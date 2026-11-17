import type { ResearchSource } from '../shared/research'

export type AiConfig = { baseUrl: string; model: string; apiKey: string }

/**
 * 一次模型调用的 token 用量。
 * cachedTokens 是服务端前缀缓存命中的部分（按缓存价计费），cacheMissTokens 是未命中的输入；
 * providerReported=false 表示供应商根本没回 usage，此时四个数字都是 0，只能当估算，不能当真实零消耗。
 */
export type AiUsage = {
  promptTokens: number
  cachedTokens: number
  cacheMissTokens: number
  completionTokens: number
  reasoningTokens: number
  providerReported: boolean
  model: string
}

export type AiUsageSink = (kind: string, usage: AiUsage) => void

/** DeepSeek 官方余额；只有余额，没有逐请求用量。 */
export type AiBalanceInfo = {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(4000, 800 * 2 ** attempt)))
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

export class AiError extends Error {
  constructor(
    readonly code: 'AI_FAILED' | 'AI_NOT_CONFIGURED' | 'LIMIT_EXCEEDED',
    message: string,
  ) {
    super(message)
  }
}

/** OpenAI 兼容的 /chat/completions；只走主进程，渲染层拿不到密钥。 */
export class AiClient {
  constructor(
    private readonly config: AiConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 60_000,
    private readonly onUsage?: AiUsageSink,
    /** 每次真正发模型请求前调用；预算到顶时抛 AiError('LIMIT_EXCEEDED')。 */
    private readonly beforeCall?: () => void,
  ) {}

  private endpoint(): string {
    const base = this.config.baseUrl.replace(/\/+$/, '')
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  }

  private modelsEndpoint(): string {
    const base = this.config.baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
    return `${base}/models`
  }

  private searchEndpoint(): string {
    const base = this.config.baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
    if (!base.includes('api.deepseek.com')) {
      throw new AiError('AI_FAILED', '联网查证目前只支持 DeepSeek 官方地址（api.deepseek.com/v1）。')
    }
    const root = base.replace(/\/v1$/, '')
    return `${root}/v1/tools/search`
  }

  private authHeaders(json = false): Record<string, string> {
    const headers: Record<string, string> = {}
    if (json) headers['content-type'] = 'application/json'
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`
    return headers
  }

  async listModels(): Promise<string[]> {
    let response: Response
    try {
      response = await this.fetchImpl(this.modelsEndpoint(), {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new AiError('AI_FAILED', '连不上模型服务，检查地址、网络和密钥。')
    }
    const text = await response.text()
    if (!response.ok) {
      throw new AiError('AI_FAILED', `拉取模型返回 ${response.status}：${text.slice(0, 160)}`)
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new AiError('AI_FAILED', '模型列表不是 JSON。')
    }
    const raw = Array.isArray(body)
      ? body
      : (body as { data?: unknown }).data
    const ids = Array.isArray(raw)
      ? raw
          .map((item) => (typeof item === 'string' ? item : (item as { id?: unknown })?.id))
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : []
    if (ids.length === 0) throw new AiError('AI_FAILED', '模型服务没有返回可用的模型。')
    return [...new Set(ids.map((id) => id.trim()))].slice(0, 200)
  }

  /** DeepSeek 官方余额：只能核对账户还剩多少，没有逐请求用量查询接口。 */
  async balance(): Promise<AiBalanceInfo[]> {
    const root = this.config.baseUrl
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '')
      .replace(/\/v1$/, '')
    let host = ''
    try {
      host = new URL(root).hostname
    } catch {
      throw new AiError('AI_FAILED', '模型地址不是合法 URL。')
    }
    if (host !== 'api.deepseek.com') {
      throw new AiError('AI_FAILED', '余额核对仅支持 DeepSeek 官方地址（api.deepseek.com）。')
    }
    if (!this.config.apiKey.trim()) throw new AiError('AI_NOT_CONFIGURED', '先在「模型」里填好密钥，再核对余额。')
    let response: Response
    try {
      response = await this.fetchImpl(`${root}/user/balance`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new AiError('AI_FAILED', '连不上 DeepSeek 余额接口，检查网络。')
    }
    const text = await response.text()
    if (!response.ok) {
      throw new AiError('AI_FAILED', `余额接口返回 ${response.status}：${text.slice(0, 160)}`)
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new AiError('AI_FAILED', '余额接口返回的不是 JSON。')
    }
    const raw = (body as { balance_infos?: unknown }).balance_infos
    if (!Array.isArray(raw)) return []
    return raw
      .map((item): AiBalanceInfo => {
        const row = (item ?? {}) as Record<string, unknown>
        return {
          currency: str(row.currency),
          totalBalance: str(row.total_balance),
          grantedBalance: str(row.granted_balance),
          toppedUpBalance: str(row.topped_up_balance),
        }
      })
      .filter((item) => item.currency.length > 0)
  }

  /** DeepSeek 的独立 Search 接口；只读网页，不把结果直接当成模型答案。 */
  async search(query: string, count = 5): Promise<ResearchSource[]> {
    const trimmed = Array.from(query.trim()).slice(0, 128).join('')
    if (!trimmed) throw new AiError('AI_FAILED', '没有可搜索的文字。')
    if (!this.config.apiKey) throw new AiError('AI_NOT_CONFIGURED', '先在「模型」里填好密钥，再联网查证。')
    const endpoint = this.searchEndpoint()
    let response: Response
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: this.authHeaders(true),
        body: JSON.stringify({
          query: trimmed,
          count: Math.max(1, Math.min(50, Math.round(count))),
          ori_question: '核对课件这一页的概念、公式和说法是否准确',
          need_content: false,
        }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new AiError('AI_FAILED', '连不上 DeepSeek 的搜索服务，检查网络和密钥。')
    }
    const text = await response.text()
    if (!response.ok) {
      throw new AiError('AI_FAILED', `搜索服务返回 ${response.status}：${text.slice(0, 160)}`)
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new AiError('AI_FAILED', '搜索服务返回的不是 JSON。')
    }
    const raw = (body as { results?: unknown }).results
    if (!Array.isArray(raw)) return []
    return raw
      .map((item): ResearchSource => {
        const row = (item ?? {}) as Record<string, unknown>
        return {
          title: str(row.title),
          url: str(row.url),
          snippet: str(row.snippet),
          summary: str(row.summary) || str(row.snippet),
          siteName: row.site_name == null ? null : str(row.site_name),
          date: row.date == null ? null : str(row.date),
          authority: num(row.authority),
          score: num(row.rerank_score),
        }
      })
      .filter((item) => item.title.length > 0 && isHttpUrl(item.url))
      .slice(0, 10)
  }

  async complete(
    system: string,
    user: string,
    maxTokens = 4096,
    thinking: 'enabled' | 'disabled' = 'enabled',
    kind = 'chat',
  ): Promise<string> {
    this.beforeCall?.()
    let response: Response | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await this.fetchImpl(this.endpoint(), {
          method: 'POST',
          headers: this.authHeaders(true),
          body: JSON.stringify({
            model: this.config.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0.4,
            max_tokens: maxTokens,
            ...(thinking === 'disabled' ? { thinking: { type: 'disabled' } } : {}),
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (error) {
        if (attempt < 2) {
          await retryDelay(attempt)
          continue
        }
        throw new AiError('AI_FAILED', '连不上模型服务，检查地址、网络和密钥。')
      }
      if (response.ok || !retryableStatus(response.status) || attempt === 2) break
      await retryDelay(attempt)
    }
    if (!response) throw new AiError('AI_FAILED', '连不上模型服务，检查地址、网络和密钥。')
    const text = await response.text()
    if (!response.ok) {
      throw new AiError('AI_FAILED', `模型服务返回 ${response.status}：${text.slice(0, 160)}`)
    }

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new AiError('AI_FAILED', '模型服务返回的不是 JSON。')
    }
    const content = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      throw new AiError('AI_FAILED', '模型没有返回内容。')
    }
    this.onUsage?.(kind, parseAiUsage(body))
    return content
  }

  /** 让支持图片输入的 OpenAI 兼容模型读一张图；用于扫描件、图表和课件截图。 */
  async describeImage(input: { mime: string; base64: string; prompt: string; model?: string; system?: string; kind?: string }): Promise<string> {
    this.beforeCall?.()
    let response: Response | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await this.fetchImpl(this.endpoint(), {
          method: 'POST',
          headers: this.authHeaders(true),
          body: JSON.stringify({
            model: input.model ?? this.config.model,
            messages: [
              ...(input.system ? [{ role: 'system', content: input.system }] : []),
              {
                role: 'user',
                content: [
                  { type: 'text', text: input.prompt },
                  { type: 'image_url', image_url: { url: `data:${input.mime};base64,${input.base64}` } },
                ],
              },
            ],
            temperature: 0.2,
            max_tokens: 3200,
          }),
          signal: AbortSignal.timeout(Math.max(this.timeoutMs, 90_000)),
        })
      } catch {
        if (attempt < 2) {
          await retryDelay(attempt)
          continue
        }
        throw new AiError('AI_FAILED', '连不上模型服务，检查地址、网络和密钥。')
      }
      if (response.ok || !retryableStatus(response.status) || attempt === 2) break
      await retryDelay(attempt)
    }
    if (!response) throw new AiError('AI_FAILED', '连不上模型服务，检查地址、网络和密钥。')
    const text = await response.text()
    if (!response.ok) {
      throw new AiError('AI_FAILED', `模型服务返回 ${response.status}：${text.slice(0, 160)}`)
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new AiError('AI_FAILED', '模型服务返回的不是 JSON。')
    }
    const content = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
    if (typeof content === 'string' && content.trim()) {
      this.onUsage?.(input.kind ?? 'vision', parseAiUsage(body))
      return content
    }
    if (Array.isArray(content)) {
      const joined = content
        .map((part) => (typeof part === 'string' ? part : (part as { text?: unknown })?.text))
        .filter((part): part is string => typeof part === 'string')
        .join('\n')
        .trim()
      if (joined) {
        this.onUsage?.(input.kind ?? 'vision', parseAiUsage(body))
        return joined
      }
    }
    throw new AiError('AI_FAILED', '模型没有返回图像说明。检查模型是否支持图片；DeepSeek 请用 deepseek-flash。')
  }
}

/**
 * OpenAI 兼容响应里的 usage。DeepSeek 同时给 `prompt_tokens_details.cached_tokens` 和顶层的
 * `prompt_cache_hit_tokens/prompt_cache_miss_tokens`，两处口径相同；任一处缺失都要能回退。
 * 没有任何 usage 时返回 providerReported=false —— 调用方必须把它标成估算，不能当真实零消耗。
 */
export function parseAiUsage(body: unknown): AiUsage {
  const usage = (body as { usage?: Record<string, unknown> }).usage
  const model = str((body as { model?: unknown }).model)
  const empty: AiUsage = {
    promptTokens: 0,
    cachedTokens: 0,
    cacheMissTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    providerReported: false,
    model,
  }
  if (!usage || typeof usage !== 'object') return empty
  const toCount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>
  const completionDetails = (usage.completion_tokens_details ?? {}) as Record<string, unknown>
  const cached = toCount(details.cached_tokens) || toCount(usage.prompt_cache_hit_tokens)
  const miss = toCount(usage.prompt_cache_miss_tokens)
  const prompt = toCount(usage.prompt_tokens) || cached + miss
  return {
    promptTokens: prompt,
    cachedTokens: Math.min(cached, prompt || cached),
    // 只报了总数和命中数时，未命中数由总数减出来；两者都缺才写 0。
    cacheMissTokens: miss || Math.max(0, prompt - cached),
    completionTokens: toCount(usage.completion_tokens),
    reasoningTokens: toCount(completionDetails.reasoning_tokens),
    providerReported: true,
    model,
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

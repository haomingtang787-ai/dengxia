import { randomUUID } from 'node:crypto'
import { isUuid } from '../domain/ids'
import { ArgumentError, isPlainObject } from '../domain/validation'
import type { SettingsStore } from '../providers/settings'
import type { Result } from '../shared/contract'
import { fail, ok } from '../shared/contract'
import type { AiConfigView, AiModelList } from '../shared/ai'
import { DEFAULT_AI } from '../shared/ai'
import type { LectureListItem } from '../shared/teaching'
import type { TeachingService } from '../teaching/service'
import { habitStamp } from '../teaching/habits'
import { AiClient, AiError, type AiConfig } from './client'
import { parseLectureResponse } from './parse'
import { buildLecturePrompt, type PromptBlock } from './prompt'

export class AiService {
  constructor(
    private readonly options: {
      settings: SettingsStore
      teaching: TeachingService
      fetchImpl?: typeof fetch
      timeoutMs?: number
    },
  ) {}

  status(): Result<AiConfigView> {
    return ok(randomUUID(), this.view())
  }

  saveConfig(body: unknown): Result<AiConfigView> {
    return this.guard(() => {
      if (!isPlainObject(body)) throw new ArgumentError('模型配置必须是对象')
      const baseUrl = this.url(body.baseUrl)
      const model = this.required(body.model, '模型名', 120)
      const existing = this.options.settings.load().ai
      const visionModel = body.visionModel === undefined
        ? existing?.visionModel
        : this.optional(body.visionModel, '图像模型', 120) || undefined
      const typed = body.apiKey === undefined ? '' : this.optional(body.apiKey, '密钥', 400)
      const apiKey = typed || existing?.apiKey || ''
      if (!apiKey) throw new ArgumentError('还没有填密钥')
      this.options.settings.save({ ...this.options.settings.load(), ai: { baseUrl, model, visionModel, apiKey } })
      return this.view()
    })
  }

  async testConfig(): Promise<Result<{ reply: string }>> {
    const requestId = randomUUID()
    try {
      const config = this.config()
      const client = this.client(config)
      const reply = await client.complete('你是连接测试。只回复“ok”。', '连接测试', 200)
      return ok(requestId, { reply: reply.trim().slice(0, 80) })
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  /** 拉取 /models；允许先用表单里还没保存的地址和密钥。 */
  async models(body: unknown): Promise<Result<AiModelList>> {
    const requestId = randomUUID()
    try {
      const input = isPlainObject(body) ? body : {}
      const saved = this.options.settings.load().ai
      const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim()
        ? this.url(input.baseUrl)
        : saved?.baseUrl
          ? this.url(saved.baseUrl)
          : DEFAULT_AI.baseUrl
      const typedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
      const apiKey = typedKey || saved?.apiKey || ''
      if (!apiKey) throw new ArgumentError('先填密钥，再拉取模型')
      const models = await this.client({
        baseUrl,
        model: saved?.model ?? DEFAULT_AI.model,
        apiKey,
      }).listModels()
      return ok(requestId, { models })
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  async makeLecture(body: unknown): Promise<Result<LectureListItem>> {
    const requestId = randomUUID()
    try {
      const input = this.parseLectureInput(body)
      const config = this.config()
      const habits = this.options.teaching.habits()
      if (!habits.ok) return habits
      const prompt = buildLecturePrompt({
        title: input.title,
        subject: input.subject,
        blocks: input.blocks,
        habits: habits.data,
        pageLabel: input.pageLabel,
      })
      const reply = await this.client(config).complete(prompt.system, prompt.user)
      const draft = parseLectureResponse(reply, {
        title: input.title,
        subject: input.subject,
        sourceName: input.sourceName,
      })
      return this.options.teaching.create({
        ...draft,
        requestId: input.requestId,
        documentVersionId: input.documentVersionId,
        sourceName: input.sourceName,
        rawText: input.blocks.map((block) => block.text).join('\n'),
        habitStamp: habitStamp(habits.data),
      })
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  private parseLectureInput(body: unknown): {
    requestId: string
    documentVersionId: string
    title: string
    subject: string
    sourceName: string
    pageLabel?: string
    blocks: PromptBlock[]
  } {
    if (!isPlainObject(body)) throw new ArgumentError('拆讲参数必须是对象')
    if (!isUuid(body.requestId)) throw new ArgumentError('requestId 必须是 UUID')
    if (!isUuid(body.documentVersionId)) throw new ArgumentError('documentVersionId 无效')
    const title = this.required(body.title, '标题', 120)
    const subject = this.optional(body.subject, '科目', 40)
    const sourceName = this.optional(body.sourceName, '来源名称', 200)
    const pageLabel = this.optional(body.pageLabel, '页码', 60) || undefined
    if (!Array.isArray(body.blocks) || body.blocks.length === 0) throw new ArgumentError('这一页没有可拆的文字')
    if (body.blocks.length > 400) throw new ArgumentError('这一页文字块太多')
    const blocks: PromptBlock[] = body.blocks.map((item, index) => {
      if (!isPlainObject(item)) throw new ArgumentError(`第 ${index + 1} 块格式不对`)
      const kind = typeof item.kind === 'string' ? item.kind.slice(0, 40) : 'paragraph'
      const text = this.optional(item.text, `第 ${index + 1} 块文字`, 4000)
      if (!text) throw new ArgumentError(`第 ${index + 1} 块是空的`)
      return { kind, text }
    })
    return {
      requestId: String(body.requestId).toLowerCase(),
      documentVersionId: String(body.documentVersionId).toLowerCase(),
      title,
      subject,
      sourceName,
      pageLabel,
      blocks,
    }
  }

  private view(): AiConfigView {
    const ai = this.options.settings.load().ai
    return {
      configured: Boolean(ai?.baseUrl && ai?.model && ai?.apiKey),
      baseUrl: ai?.baseUrl ?? '',
      model: ai?.model ?? '',
      visionModel: ai?.visionModel ?? '',
      hasKey: Boolean(ai?.apiKey),
    }
  }

  private config(): AiConfig {
    const ai = this.options.settings.load().ai
    if (!ai?.baseUrl || !ai.model || !ai.apiKey) {
      throw new AiError('AI_NOT_CONFIGURED', '还没有配置模型。到「模型」里填地址、模型名和密钥。')
    }
    return ai
  }

  private client(config: AiConfig): AiClient {
    return new AiClient(config, this.options.fetchImpl ?? globalThis.fetch, this.options.timeoutMs)
  }

  private url(value: unknown): string {
    const raw = this.required(value, '模型地址', 300)
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new ArgumentError('模型地址不是合法的 URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ArgumentError('模型地址只支持 http 或 https')
    }
    return raw.replace(/\/+$/, '')
  }

  private required(value: unknown, label: string, max: number): string {
    const text = this.optional(value, label, max)
    if (!text) throw new ArgumentError(`${label}不能为空`)
    return text
  }

  private optional(value: unknown, label: string, max: number): string {
    if (value === undefined || value === null) return ''
    if (typeof value !== 'string') throw new ArgumentError(`${label}必须是文本`)
    const trimmed = value.trim()
    if (trimmed.length > max) throw new ArgumentError(`${label}超过 ${max} 字`)
    return trimmed
  }

  private failure(requestId: string, error: unknown): Result<never> {
    if (error instanceof ArgumentError) return fail(requestId, 'INVALID_ARGUMENT', error.message)
    if (error instanceof AiError) return fail(requestId, error.code, error.message)
    console.error('ai', error)
    return fail(requestId, 'AI_FAILED', '模型这一步没有成功，可以改用本地拆讲。')
  }

  private guard<T>(fn: () => T): Result<T> {
    const requestId = randomUUID()
    try {
      return ok(requestId, fn())
    } catch (error) {
      return this.failure(requestId, error)
    }
  }
}

import { createCanvas, loadImage } from '@napi-rs/canvas'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { isUuid } from '../domain/ids'
import { ArgumentError, isPlainObject } from '../domain/validation'
import { AiClient, AiError } from '../ai/client'
import type { AiUsage } from '../ai/client'
import type { SettingsStore } from '../providers/settings'
import type { Result } from '../shared/contract'
import { fail, ok } from '../shared/contract'
import type { AutoReadResult, BlockReading, BlockReadingResult, ImageReading, ImageReadingKind, ImageReadingList, ImageReadingResult } from '../shared/images'
import type { PageResearch, ResearchList, ResearchResult, ResearchSource } from '../shared/research'
import type { Store } from '../storage/store'
import { nowIso } from '../domain/ids'
import { realpathInside, resolveInside } from '../storage/paths'
import { OcrError, normalizeOcrText, ocrImage } from '../ocr/windows'

class NotFoundError extends Error {}

const AI_READ_SYSTEM = [
  '你是一位严谨的学科老师，负责先把课件页读懂，再交给老师讲课。',
  '先看清图中的知识点，不要被作者、机构、版式、页码干扰；这些非知识信息一律忽略。',
  '注意区分 O/0、I/l/1、上下标、箭头和希腊字母，化学式与公式按图中实际写法保留；看不清就写「不确定」，不要猜。',
  '不要输出识别过程，也不要把整页文字逐字转写当成答案。',
].join('\n')

const AI_READ_PROMPT = [
  '请先把这张课件页读懂，再输出老师可以直接用来讲课的知识点。',
  '只输出以下三节：',
  '## 知识点',
  '按 1. 2. 3. 列出图中真正要讲的学科知识，保留公式、符号、图表关系和关键数字。',
  '## 概念关系',
  '说明这些知识点之间怎么连接，图、表或公式分别在说明什么。',
  '## 讲课提示',
  '指出容易讲错、容易混淆或值得强调的地方。',
  '不要输出整页 OCR 转写，不要逐字抄页眉页脚；作者、编者、出版方、版权、页码、日期、致谢、参考文献列表等非知识信息一律忽略。',
  '只写图中能看到或能直接推出的内容，不确定就写「不确定」，不要编造人名、数字或结论。',
].join('\n')

const RESEARCH_SYSTEM = [
  '你在做课件页面的联网核对，目标只有一个：把这一页的学科知识点讲对。',
  '只能依据「页面内容」和「搜索结果」回答，不要凭记忆补充没有来源的事实。',
  '忽略作者、编者、机构、出版社、版权、页眉页脚、页码、日期、致谢、参考文献列表等非知识信息，不要核对或复述它们，只核对知识点。',
  '请输出三节：',
  '## 核对结论',
  '逐条说页面里的知识点与资料是一致、需要补充，还是可能过时/有误。',
  '## 需要补充或修正',
  '只写对讲课真正有用的补充；资料不足就直说，不要硬编。',
  '## 讲课建议',
  '指出这一页适合强调的因果关系、容易讲错的地方。',
  '引用搜索结果时写成 [1]、[2]，编号对应给出的来源；没有来源支持的句子不要写。',
].join('\n')

type VisionPayload = { mime: string; base64: string }

export type ImageServiceOptions = {
  store: Store
  root: string
  settings: SettingsStore
  runOcr?: (file: string) => Promise<string>
  fetchImpl?: typeof fetch
  visionPayload?: (file: string) => Promise<VisionPayload>
  /** 每次读图/查证成功后上报 token 用量，供成本统计。 */
  onUsage?: (kind: string, usage: AiUsage, documentVersionId: string) => void
  budget?: import('../ai/budget').BudgetService
}

export class ImageService {
  constructor(private readonly options: ImageServiceOptions) {}

  readings(body: unknown): Result<ImageReadingList> {
    const requestId = randomUUID()
    try {
      const versionId = this.versionId(body)
      return ok(requestId, { items: this.options.store.listImageReadings(versionId).map(toView) })
    } catch (error) {
      return this.failure(requestId, error, 'PARSE_FAILED')
    }
  }

  async ocr(body: unknown): Promise<Result<ImageReadingResult>> {
    const requestId = randomUUID()
    try {
      const page = this.page(body)
      const file = this.pageFile(page.document_version_id, page.id)
      const raw = await (this.options.runOcr ?? (async (path: string) => (await ocrImage(path)).text))(file)
      const text = focusKnowledgeText(normalizeOcrText(raw))
      if (!text) throw new OcrError('这一页本机 OCR 没有识别到文字。可以换一张更清晰的图，或让 AI 读图。')
      const reading = this.save(page.document_version_id, page.id, 'ocr', text, 'windows-ocr')
      return ok(requestId, { reading })
    } catch (error) {
      return this.failure(requestId, error, 'PARSE_FAILED')
    }
  }

  async vision(body: unknown): Promise<Result<ImageReadingResult>> {
    const requestId = randomUUID()
    try {
      const page = this.page(body)
      const config = this.options.settings.load().ai
      if (!config) throw new ArgumentError('先在「模型」里填好地址、模型和密钥，再让它读图。')
      const file = this.pageFile(page.document_version_id, page.id)
      const payload = await (this.options.visionPayload ?? defaultVisionPayload)(file)
      const model = config.visionModel?.trim() || config.model
      const client = new AiClient({ ...config, model }, this.options.fetchImpl ?? globalThis.fetch, 90_000, (kind, usage) => this.options.onUsage?.(kind, usage, page.document_version_id), () => this.options.budget?.beforeCall())
      const text = (await client.describeImage({ ...payload, prompt: AI_READ_PROMPT, system: AI_READ_SYSTEM, kind: 'vision' })).trim()
      if (!text) throw new AiError('AI_FAILED', '模型没有返回这一页的知识点。')
      const reading = this.save(page.document_version_id, page.id, 'vision', text, model)
      return ok(requestId, { reading })
    } catch (error) {
      return this.failure(requestId, error, 'AI_FAILED')
    }
  }

  /**
   * DOCX 的内嵌图没有页码，只能按块读。同一块只读一次，结果落到 block_readings，
   * 之后开课、重开课都直接复用，不重复扣 API。
   */
  async visionEmbedded(body: unknown): Promise<Result<BlockReadingResult>> {
    const requestId = randomUUID()
    try {
      const blockId = this.blockId(body)
      const block = this.options.store.getBlock(blockId)
      if (!block) throw new NotFoundError('找不到这一块内容')
      const cached = this.options.store
        .listBlockReadings(block.document_version_id)
        .find((row) => row.block_id === block.id && row.kind === 'vision')
      if (cached) return ok(requestId, { reading: toBlockView(cached) })
      const config = this.options.settings.load().ai
      if (!config || !config.apiKey) throw new ArgumentError('先在「模型」里填好地址、模型和密钥，再让它读图。')
      const artifactId = artifactIdOf(block.locator_json)
      if (!artifactId) throw new NotFoundError('这一块没有可读的图片。')
      const artifact = this.options.store.getArtifact(artifactId)
      if (!artifact) throw new NotFoundError('这一块的图片不在文库目录里。')
      const abs = resolveInside(this.options.root, artifact.relpath)
      const real = abs ? realpathInside(this.options.root, abs) : null
      if (!real) throw new NotFoundError('这一块的图片不在文库目录里。')
      const payload = await (this.options.visionPayload ?? defaultVisionPayload)(real)
      const model = config.visionModel?.trim() || config.model
      const client = new AiClient({ ...config, model }, this.options.fetchImpl ?? globalThis.fetch, 90_000, (kind, usage) => this.options.onUsage?.(kind, usage, block.document_version_id), () => this.options.budget?.beforeCall())
      const text = (await client.describeImage({ ...payload, prompt: AI_READ_PROMPT, system: AI_READ_SYSTEM, kind: 'vision-embedded' })).trim()
      if (!text) throw new AiError('AI_FAILED', '模型没有返回这张图的讲解。')
      const row = {
        id: randomUUID(),
        document_version_id: block.document_version_id,
        block_id: block.id,
        kind: 'vision' as const,
        text: text.slice(0, 40_000),
        engine: model,
        created_at: nowIso(),
      }
      this.options.store.upsertBlockReading(row)
      return ok(requestId, { reading: toBlockView(row) })
    } catch (error) {
      return this.failure(requestId, error, 'AI_FAILED')
    }
  }

  private blockId(body: unknown): string {
    if (!isPlainObject(body)) throw new ArgumentError('请求必须是对象')
    const id = body.blockId
    if (typeof id !== 'string' || !isUuid(id)) throw new ArgumentError('块 ID 不对')
    return id
  }

  /** 上传即读懂：图片页先让 AI 读图，AI 不可用时才退回本机 OCR；文字页只查证。 */  async auto(body: unknown): Promise<Result<AutoReadResult>> {
    const requestId = randomUUID()
    try {
      const page = this.page(body)
      const config = this.options.settings.load().ai
      const readings = this.options.store
        .listImageReadings(page.document_version_id)
        .filter((row) => row.page_id === page.id)
      const errors: string[] = []

      const hasVision = readings.some((row) => row.kind === 'vision')
      let vision: AutoReadResult['vision'] = 'skipped'
      if (page.source_kind === 'image' && hasVision) {
        vision = 'existing'
      } else if (page.source_kind === 'image' && config?.apiKey) {
        const result = await this.vision(body)
        if (result.ok) vision = 'created'
        else {
          vision = 'failed'
          errors.push(`AI 读图：${result.error.message}`)
        }
      }

      const hasOcr = readings.some((row) => row.kind === 'ocr')
      const visionReady = hasVision || vision === 'created'
      let ocr: AutoReadResult['ocr'] = 'skipped'
      if (page.source_kind === 'image') {
        if (hasOcr) {
          ocr = 'existing'
        } else if (!visionReady) {
          const result = await this.ocr(body)
          if (result.ok) ocr = 'created'
          else {
            ocr = 'failed'
            errors.push(`本机 OCR：${result.error.message}`)
          }
        }
      }

      let research: AutoReadResult['research'] = 'skipped'
      if (this.options.store.getPageResearch(page.id)) {
        research = 'existing'
      } else if (config?.apiKey && this.pageText(page)) {
        const result = await this.researchVerify(body)
        if (result.ok) research = 'created'
        else {
          research = 'failed'
          errors.push(`查证：${result.error.message}`)
        }
      }

      return ok(requestId, { pageId: page.id, ocr, vision, research, errors })
    } catch (error) {
      return this.failure(requestId, error, 'PARSE_FAILED')
    }
  }

  researchList(body: unknown): Result<ResearchList> {
    const requestId = randomUUID()
    try {
      const versionId = this.versionId(body)
      return ok(requestId, { items: this.options.store.listPageResearch(versionId).map(toResearchView) })
    } catch (error) {
      return this.failure(requestId, error, 'PARSE_FAILED')
    }
  }

  /** 独立按钮：先用页面文字搜网页，再让模型只根据页面和搜索结果核对。 */
  async researchVerify(body: unknown): Promise<Result<ResearchResult>> {
    const requestId = randomUUID()
    try {
      const page = this.page(body)
      const config = this.options.settings.load().ai
      if (!config || !config.apiKey) throw new ArgumentError('先在「模型」里填好地址、模型和密钥，再联网查证。')
      let pageText = this.pageText(page)
      if (!pageText) {
        const reading = await this.ocr({ documentVersionId: page.document_version_id, pageId: page.id })
        if (!reading.ok) throw new ArgumentError(reading.error.message)
        pageText = reading.data.reading.text
      }
      if (!pageText) throw new ArgumentError('这一页还没有可查证的文字。等自动读懂完成，或填好模型后重试这一页。')
      const query = this.researchQuery(body, pageText)
      const client = new AiClient(config, this.options.fetchImpl ?? globalThis.fetch, 90_000, (kind, usage) => this.options.onUsage?.(kind, usage, page.document_version_id), () => this.options.budget?.beforeCall())
      const sources = await client.search(query, 5)
      if (sources.length === 0) {
        throw new AiError('AI_FAILED', '没有搜到可用的网页结果。换一个更具体的页面标题或关键词再试。')
      }
      const answer = (
        await client.complete(RESEARCH_SYSTEM, buildResearchPrompt(pageText, query, sources), 3000, 'disabled', 'research')
      ).trim()
      if (!answer) throw new AiError('AI_FAILED', '模型没有返回核对结果。')
      const research = this.saveResearch(page.document_version_id, page.id, query, answer, sources, `${config.model}+search`)
      return ok(requestId, { research })
    } catch (error) {
      return this.failure(requestId, error, 'AI_FAILED')
    }
  }

  private researchQuery(body: unknown, pageText: string): string {
    if (isPlainObject(body) && typeof body.query === 'string' && body.query.trim()) {
      return Array.from(body.query.trim()).slice(0, 128).join('')
    }
    const plain = pageText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && !isMetadataLine(line))
      .join(' ')
    return Array.from(plain).slice(0, 120).join('')
  }

  private pageText(page: { id: string; document_version_id: string; source_kind: string }): string {
    const readings = this.options.store
      .listImageReadings(page.document_version_id)
      .filter((row) => row.page_id === page.id)
    if (page.source_kind === 'image') {
      // AI 读懂优先；只有 AI 不可用时才用本机 OCR。两者不能混在一起，避免 OCR 错字污染查证。
      const vision = readings.find((row) => row.kind === 'vision')
      if (vision) return vision.text.trim().slice(0, 6000)
      const ocr = readings.find((row) => row.kind === 'ocr')
      return (ocr?.text ?? '').trim().slice(0, 6000)
    }
    const blocks = this.options.store
      .listBlocksByPage(page.id, 0, 50)
      .map((row) => row.text)
      .filter((text) => !text.includes('图像已作为预览保留'))
    return [...readings.map((row) => row.text), ...blocks].join('\n').trim().slice(0, 6000)
  }

  private saveResearch(
    versionId: string,
    pageId: string,
    query: string,
    answer: string,
    sources: ResearchSource[],
    engine: string,
  ): PageResearch {
    const row = {
      id: randomUUID(),
      document_version_id: versionId,
      page_id: pageId,
      query: query.slice(0, 128),
      answer: answer.slice(0, 40_000),
      sources_json: JSON.stringify(sources.slice(0, 10)).slice(0, 40_000),
      engine,
      created_at: nowIso(),
    }
    this.options.store.upsertPageResearch(row)
    return toResearchView(row)
  }

  private versionId(body: unknown): string {
    if (!isPlainObject(body)) throw new ArgumentError('请求必须是对象')
    const id = body.documentVersionId
    if (typeof id !== 'string' || !isUuid(id)) throw new ArgumentError('文稿版本不对')
    if (!this.options.store.getVersion(id)) throw new NotFoundError('找不到这份文稿')
    return id
  }

  private page(body: unknown): { id: string; document_version_id: string; source_kind: string } {
    const versionId = this.versionId(body)
    if (!isPlainObject(body)) throw new ArgumentError('请求必须是对象')
    const pageId = body.pageId
    if (typeof pageId !== 'string' || !isUuid(pageId)) throw new ArgumentError('页码不对')
    const page = this.options.store.getPage(pageId)
    if (!page || page.document_version_id !== versionId) throw new NotFoundError('找不到这一页')
    return { id: page.id, document_version_id: page.document_version_id, source_kind: page.source_kind }
  }

  private pageFile(versionId: string, pageId: string): string {
    const artifact = this.options.store
      .listArtifacts(versionId)
      .find((item) => item.page_id === pageId && item.kind === 'page-image')
    if (!artifact) throw new NotFoundError('这一页没有预览图，先等解析完成。')
    const abs = resolveInside(this.options.root, artifact.relpath)
    const real = abs ? realpathInside(this.options.root, abs) : null
    if (!real) throw new NotFoundError('这一页的预览图不在文库目录里。')
    return real
  }

  private save(versionId: string, pageId: string, kind: ImageReadingKind, text: string, engine: string): ImageReading {
    const row = {
      id: randomUUID(),
      document_version_id: versionId,
      page_id: pageId,
      kind,
      text: text.slice(0, 40_000),
      engine,
      created_at: nowIso(),
    }
    this.options.store.upsertImageReading(row)
    return toView(row)
  }

  private failure(requestId: string, error: unknown, fallback: 'PARSE_FAILED' | 'AI_FAILED'): Result<never> {
    if (error instanceof ArgumentError) return fail(requestId, 'INVALID_ARGUMENT', error.message)
    if (error instanceof NotFoundError) return fail(requestId, 'NOT_FOUND', error.message)
    if (error instanceof OcrError) return fail(requestId, 'PARSE_FAILED', error.message)
    if (error instanceof AiError) {
      return fail(requestId, error.code === 'AI_NOT_CONFIGURED' ? 'AI_NOT_CONFIGURED' : error.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'AI_FAILED', error.message)
    }
    return fail(requestId, fallback, error instanceof Error ? error.message.slice(0, 220) : '图片处理失败。')
  }
}

function toView(row: {  id: string
  document_version_id: string
  page_id: string
  kind: string
  text: string
  engine: string
  created_at: string
}): ImageReading {
  return {
    id: row.id,
    documentVersionId: row.document_version_id,
    pageId: row.page_id,
    kind: row.kind === 'vision' ? 'vision' : 'ocr',
    text: row.text,
    engine: row.engine,
    createdAt: row.created_at,
  }
}

function toBlockView(row: {
  block_id: string
  text: string
  engine: string
  created_at: string
}): BlockReading {
  return {
    blockId: row.block_id,
    text: row.text,
    engine: row.engine,
    createdAt: row.created_at,
  }
}

function artifactIdOf(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { artifactId?: unknown }
    return typeof parsed.artifactId === 'string' ? parsed.artifactId : ''
  } catch {
    return ''
  }
}

function toResearchView(row: {
  id: string
  document_version_id: string
  page_id: string
  query: string
  answer: string
  sources_json: string
  engine: string
  created_at: string
}): PageResearch {
  return {
    id: row.id,
    documentVersionId: row.document_version_id,
    pageId: row.page_id,
    query: row.query,
    answer: row.answer,
    sources: parseSources(row.sources_json),
    engine: row.engine,
    createdAt: row.created_at,
  }
}

function parseSources(raw: string): ResearchSource[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        const row = (item ?? {}) as Record<string, unknown>
        return {
          title: typeof row.title === 'string' ? row.title : '',
          url: typeof row.url === 'string' ? row.url : '',
          snippet: typeof row.snippet === 'string' ? row.snippet : '',
          summary: typeof row.summary === 'string' ? row.summary : '',
          siteName: typeof row.siteName === 'string' ? row.siteName : null,
          date: typeof row.date === 'string' ? row.date : null,
          authority: typeof row.authority === 'number' ? row.authority : 0,
          score: typeof row.score === 'number' ? row.score : 0,
        }
      })
      .filter((item) => item.title && item.url)
  } catch {
    return []
  }
}

/** 本机 OCR 也会把作者、版权页抄进来；在落库前就把这类非知识行去掉。 */
function focusKnowledgeText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !isMetadataLine(line))
    .join('\n')
    .trim()
}

/** 搜索词只取知识点，不要把作者、出版社、版权页等元信息带进搜索。 */
function isMetadataLine(line: string): boolean {
  return /^(?:作者|主编|副主编|编者|编著|出版社|出版发行|版权|版权所有|ISBN|DOI|印刷|版次|字数|开本|定价|策划|责编|责任编辑|封面设计|基金项目|收稿日期|引用格式|作者简介|通讯作者|Author|Editor|Publisher|Copyright)\s*[:：]/i.test(line.trim())
}

function buildResearchPrompt(pageText: string, query: string, sources: ResearchSource[]): string {  const sourceLines = sources
    .map((source, index) => {
      const site = source.siteName ? `（${source.siteName}）` : ''
      const date = source.date ? ` · ${source.date}` : ''
      return `[${index + 1}] ${source.title}${site}${date}\n${source.url}\n${source.summary || source.snippet}`
    })
    .join('\n\n')
  return `页面内容：\n${pageText}\n\n搜索关键词：${query}\n\n搜索结果：\n${sourceLines}\n\n请只围绕这一页的学科知识点核对，忽略作者、机构、版权、页眉页脚等非知识信息。按系统要求输出三节。`
}

/** 幻灯片里的公式、图表和小字比普通照片更密，长边压到 2048 再送视觉模型。 */
async function defaultVisionPayload(file: string): Promise<VisionPayload> {
  const image = await loadImage(fs.readFileSync(file))
  const maxEdge = 2048
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d') as unknown as {
    drawImage: (source: unknown, x: number, y: number, w: number, h: number) => void
  }
  context.drawImage(image, 0, 0, width, height)
  const jpeg = canvas.toBuffer('image/jpeg', 88)
  return { mime: 'image/jpeg', base64: jpeg.toString('base64') }
}

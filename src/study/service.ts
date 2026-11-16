import { createHash, randomUUID } from 'node:crypto'
import { AiClient, AiError } from '../ai/client'
import { isUuid, nowIso } from '../domain/ids'
import { ArgumentError, isPlainObject } from '../domain/validation'
import type { ImageService } from '../images/service'
import type { SettingsStore } from '../providers/settings'
import { fail, ok, type Result } from '../shared/contract'
import type {
  StudyCheck,
  StudyMessage,
  StudySessionDetail,
  StudySessionList,
  StudyProgress,
  StudySummary,
  StudyUnit,
  StudyUsage,
} from '../shared/study'
import type { AppDatabase } from '../storage/database'
import { StudyStore, messageFromRow, type StudyMessageRow, type StudySessionRow, type StudyUnitRow } from '../storage/studyStore'
import type { Habits } from '../teaching/habits'
import { DEFAULT_HABITS, sanitizeHabits } from '../teaching/habits'
import { DIRECT_PLAN_CHARS, MAX_MATERIAL_CHARS, digestMaterial, renderDigests } from './digest'
import { parseStudyPlan, parseStudySummary } from './parse'
import { buildStudyChatPrompt, buildStudyPlanPrompt, buildStudySummaryPrompt, mergeOpening } from './prompt'
import { groundUnits } from './ground'

const MAX_MESSAGE_CHARS = 4_000
const MAX_ANSWER_CHARS = 2_000

export type StudyServiceOptions = {
  db: AppDatabase
  settings: SettingsStore
  images: Pick<ImageService, 'vision' | 'ocr' | 'visionEmbedded'>
  habits: () => Habits
  fetchImpl?: typeof fetch
  onProgress?: (progress: StudyProgress) => void
}

type Material = {
  text: string
  chars: number
  warnings: string[]
  truncated: boolean
}

type PageRow = {
  id: string
  ordinal: number
  source_kind: string
  source_number: number | null
}

type BlockRow = {
  id: string
  page_id: string | null
  ordinal: number
  kind: string
  text: string
  locator_json: string
}

type ReadingRow = {
  page_id: string
  kind: 'ocr' | 'vision'
  text: string
}

export class StudyService {
  private readonly store: StudyStore
  /** 用量上报时的归属：开课前只有文稿，建好课后补记到这门课名下。 */
  private usageSessionId: string | null = null
  private usageVersionId: string | null = null

  constructor(private readonly options: StudyServiceOptions) {
    this.store = new StudyStore(options.db)
  }

  list(): Result<StudySessionList> {
    const requestId = randomUUID()
    try {
      return ok(requestId, { items: this.store.listSessions() })
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  get(body: unknown): Result<StudySessionDetail> {
    const requestId = randomUUID()
    try {
      const sessionId = this.sessionId(body)
      return ok(requestId, this.detail(sessionId))
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  async create(body: unknown): Promise<Result<StudySessionDetail>> {
    const requestId = randomUUID()
    try {
      const input = this.createBody(body)
      const existing = this.store.findByRequest(input.requestId)
      if (existing) return ok(requestId, this.detail(existing.id))
      this.config()
      this.usageSessionId = null
      this.usageVersionId = input.documentVersionId
      const meta = this.documentMeta(input.documentVersionId)
      const material = await this.collectMaterial(input.documentVersionId)
      const habits = this.options.habits() ?? DEFAULT_HABITS
      const client = this.client()
      const warnings = [...material.warnings]
      // 长课件不再截断成前 20 万字：先按页分段逐段读懂，再拿结构化理解去拆课。
      let digests = ''
      let chunkCount = 1
      if (material.text.length > DIRECT_PLAN_CHARS) {
        const materialSha = createHash('sha256').update(material.text).digest('hex')
        const cached = this.store.findMaterialDigest(input.documentVersionId, materialSha)
        if (cached) {
          digests = cached.rendered_text
          chunkCount = cached.chunk_count
          warnings.push(
            `已复用上一次对这份课件的逐段理解结果（${chunkCount} 段），这次开课只花拆课的 token。`,
          )
          this.progress({ phase: 'reading', done: chunkCount, total: chunkCount })
        } else {
          this.progress({ phase: 'reading', done: 0, total: 0 })
          const outcome = await digestMaterial(client, material.text, {
            onProgress: (done, total) => this.progress({ phase: 'reading', done, total }),
          })
          digests = renderDigests(outcome.digests)
          chunkCount = outcome.digests.length
          warnings.push(
            `这份材料约 ${material.text.length} 字，已按页分成 ${chunkCount} 段逐段读懂，再据此拆课；课程覆盖全部段落。`,
          )
          warnings.push(...outcome.warnings)
          // 材料没变时这份理解结果直接复用，重开课、换习惯再开一门都不用重新扣读材料的钱。
          this.store.saveMaterialDigest({
            document_version_id: input.documentVersionId,
            material_sha: materialSha,
            chunk_count: chunkCount,
            rendered_text: digests,
            digests_json: JSON.stringify(outcome.digests),
            warnings_json: JSON.stringify(outcome.warnings),
            created_at: nowIso(),
          })
        }
      }
      const planInput = {
        title: input.title || meta.displayName,
        subject: input.subject || '',
        material: digests ? '' : material.text,
        habits,
        truncated: material.truncated,
        digests: digests || undefined,
        chunkCount,
      }
      const prompt = buildStudyPlanPrompt(planInput)
      this.progress({ phase: 'planning', done: 0, total: 0 })
      // 24 讲 × 8 段的讲稿 JSON 换算成 token 轻松超过 8000；上限太小会被截断成非法 JSON。
      const raw = await client.complete(prompt.system, prompt.user, 24_000, 'disabled', 'plan')
      let plan
      try {
        plan = parseStudyPlan(raw, {
          title: input.title || meta.displayName,
          subject: input.subject || '',
        })
      } catch (error) {
        if (!(error instanceof ArgumentError)) throw error
        const repair = buildStudyPlanPrompt({ ...planInput, repairNote: error.message })
        const repaired = await client.complete(repair.system, repair.user, 24_000, 'disabled', 'plan-repair')
        plan = parseStudyPlan(repaired, {
          title: input.title || meta.displayName,
          subject: input.subject || '',
        })
      }
      const sessionId = randomUUID()
      const timestamp = nowIso()
      const grounded = groundUnits(plan.units.map((unit, index) => ({
        id: randomUUID(),
        ordinal: index,
        title: unit.title,
        source: unit.source,
        minutes: unit.minutes,
        keyPoints: unit.keyPoints,
        segments: unit.segments,
      })), material.text)
      const units: StudyUnit[] = grounded.units
      if (grounded.ungrounded > 0) {
        warnings.push(`有 ${grounded.ungrounded} 处讲稿引用的「原文」没能在课件里逐字找到，已保留讲解，但那一句是模型转述，请对照原件。`)
      }
      const opening = mergeOpening(plan.opening, units)
      const session: StudySessionRow = {
        id: sessionId,
        request_id: input.requestId,
        document_version_id: input.documentVersionId,
        title: plan.title,
        subject: plan.subject,
        source_name: meta.displayName,
        overview: plan.overview,
        outline_json: JSON.stringify(units.map((unit) => unit.title)),
        habits_json: JSON.stringify(habits),
        warnings_json: JSON.stringify(warnings),
        truncated: material.truncated ? 1 : 0,
        material_chars: material.chars,
        material_chunks: chunkCount,
        status: 'ready',
        summary_json: '',
        created_at: timestamp,
        updated_at: timestamp,
      }
      this.store.createBundle({
        session,
        units: units.map((unit) => ({
          id: unit.id,
          session_id: sessionId,
          ordinal: unit.ordinal,
          title: unit.title,
          source: unit.source,
          minutes: unit.minutes,
          key_points_json: JSON.stringify(unit.keyPoints),
          segments_json: JSON.stringify(unit.segments),
        })),
        message: {
          id: randomUUID(),
          session_id: sessionId,
          role: 'assistant',
          unit_ordinal: 0,
          content: opening,
          created_at: timestamp,
        },
      })
      // 开课阶段的读图/分段理解/拆课用量之前没有归属，现在记到这门课名下。
      this.store.claimUsage(sessionId, input.documentVersionId)
      this.usageSessionId = sessionId
      return ok(requestId, this.detail(sessionId))
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  async send(body: unknown): Promise<Result<StudySessionDetail>> {
    const requestId = randomUUID()
    try {
      const input = this.sendBody(body)
      const session = this.requireSession(input.sessionId)
      if (session.status === 'finished') throw new ArgumentError('这门课已经生成过学习总结，可以新开一门课继续。')
      this.config()
      const habits = this.readHabits(session)
      const units = this.units(session.id)
      const unit = input.unitOrdinal == null
        ? units[0] ?? null
        : units.find((item) => item.ordinal === input.unitOrdinal) ?? null
      const messages = this.messages(session.id)
      this.usageSessionId = session.id
      this.usageVersionId = session.document_version_id
      const prompt = buildStudyChatPrompt({
        overview: session.overview,
        outline: this.outline(session),
        units,
        unit,
        messages,
        question: input.content,
        habits,
      })
      const answer = (await this.client().complete(prompt.system, prompt.user, 3000, 'disabled', 'chat')).trim()
      if (!answer) throw new AiError('AI_FAILED', '模型没有返回讲解。')
      const timestamp = nowIso()
      const userMessage: StudyMessageRow = {
        id: randomUUID(),
        session_id: session.id,
        role: 'user',
        unit_ordinal: unit?.ordinal ?? input.unitOrdinal ?? null,
        content: input.content,
        created_at: timestamp,
      }
      const assistantMessage: StudyMessageRow = {
        id: randomUUID(),
        session_id: session.id,
        role: 'assistant',
        unit_ordinal: unit?.ordinal ?? input.unitOrdinal ?? null,
        content: answer,
        created_at: timestamp,
      }
      this.options.db.transaction(() => {
        this.store.appendMessage(userMessage)
        this.store.appendMessage(assistantMessage)
      })
      return ok(requestId, this.detail(session.id))
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  async finish(body: unknown): Promise<Result<StudySessionDetail>> {
    const requestId = randomUUID()
    try {
      const sessionId = this.sessionId(body)
      const session = this.requireSession(sessionId)
      const existing = this.summary(session)
      if (existing) return ok(requestId, this.detail(sessionId))
      this.config()
      const units = this.units(sessionId)
      const messages = this.messages(sessionId)
      this.usageSessionId = session.id
      this.usageVersionId = session.document_version_id
      const prompt = buildStudySummaryPrompt({
        title: session.title,
        overview: session.overview,
        units,
        messages,
        checks: this.checks(sessionId),
      })
      const raw = await this.client().complete(prompt.system, prompt.user, 3000, 'disabled', 'summary')
      const summary = parseStudySummary(raw)
      this.store.saveSummary(sessionId, summary, nowIso())
      return ok(requestId, this.detail(sessionId))
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  /**
   * 学生回答「停一下」的问题。这一步不调模型、不判对错，只把真实作答留作证据；
   * 掌握程度由最后的总结基于这些作答来判断，避免凭感觉写「已掌握」。
   */
  check(body: unknown): Result<StudySessionDetail> {
    const requestId = randomUUID()
    try {
      const input = this.checkBody(body)
      const session = this.requireSession(input.sessionId)
      const unit = this.units(session.id).find((item) => item.ordinal === input.unitOrdinal)
      if (!unit) throw new ArgumentError('找不到这一讲，可能已经被删除。')
      const segment = unit.segments[input.segmentIndex]
      if (!segment) throw new ArgumentError('找不到这一句对应的讲解。')
      if (!segment.check) throw new ArgumentError('这一句没有「停一下」的问题，不用作答。')
      this.store.upsertCheck({
        id: randomUUID(),
        session_id: session.id,
        unit_ordinal: unit.ordinal,
        segment_index: input.segmentIndex,
        question: segment.check,
        answer: input.answer,
        created_at: nowIso(),
      })
      return ok(requestId, this.detail(session.id))
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  private async collectMaterial(versionId: string): Promise<Material> {
    const pages = this.options.db.all<PageRow>(
      'SELECT id, ordinal, source_kind, source_number FROM pages WHERE document_version_id = ? ORDER BY ordinal ASC',
      versionId,
    )
    const blocks = this.options.db.all<BlockRow>(
      `SELECT id, page_id, ordinal, kind, text, locator_json FROM blocks
       WHERE document_version_id = ?
       ORDER BY ordinal ASC`,
      versionId,
    )
    const readings = this.options.db.all<ReadingRow>(
      'SELECT page_id, kind, text FROM image_readings WHERE document_version_id = ?',
      versionId,
    )
    const blockReadings = new Map<string, string>()
    const readingRows = this.options.db.all<{ block_id: string; kind: string; text: string }>(
      'SELECT block_id, kind, text FROM block_readings WHERE document_version_id = ?',
      versionId,
    )
    for (const row of readingRows) {
      if (row.kind === 'vision') blockReadings.set(row.block_id, row.text.trim())
    }
    const warnings: string[] = []
    // 块级读图：一张图只调用一次模型，结果按块缓存；失败只记警告，不阻断整门课。
    const readEmbedded = async (block: BlockRow): Promise<string> => {
      const cached = blockReadings.get(block.id)
      if (cached !== undefined) return cached
      const result = await this.options.images.visionEmbedded({ blockId: block.id })
      if (result.ok) {
        const text = result.data.reading.text.trim()
        blockReadings.set(block.id, text)
        return text
      }
      warnings.push(`有一张内嵌图片没能读懂：${result.error.message}`)
      return ''
    }

    const byPage = new Map<string, BlockRow[]>()
    const visualPages = new Set<string>()
    for (const block of blocks) {
      if (!block.page_id) continue
      if (block.kind === 'image_region') visualPages.add(block.page_id)
      const current = byPage.get(block.page_id) ?? []
      current.push(block)
      byPage.set(block.page_id, current)
    }
    const readingByPage = new Map<string, { vision: string; ocr: string }>()
    for (const reading of readings) {
      const current = readingByPage.get(reading.page_id) ?? { vision: '', ocr: '' }
      current[reading.kind] = reading.text.trim()
      readingByPage.set(reading.page_id, current)
    }

    const parts: string[] = []
    const pendingVision = new Set(
      pages
        .filter((page) => (page.source_kind === 'image' || visualPages.has(page.id)) && !readingByPage.get(page.id)?.vision)
        .map((page) => page.id),
    )
    const visionTotal = pendingVision.size
    let visionDone = 0
    if (visionTotal > 0) this.progress({ phase: 'vision', done: 0, total: visionTotal })
    const pageResults = await mapLimit(pages, 4, async (page) => {
      const label = `【第 ${page.ordinal + 1} 页${page.source_kind === 'slide' ? ' / 幻灯片' : ''}】`
      const pageBlocks = byPage.get(page.id) ?? []
      const pageWarnings: string[] = []
      const pieces: string[] = []
      let embeddedCovered = false
      for (const block of pageBlocks) {
        if (block.kind === 'image_region' && artifactIdFrom(block.locator_json)) {
          embeddedCovered = true
          const text = await readEmbedded(block)
          if (text) pieces.push(`本页图片/图表：\n${text}`)
          continue
        }
        const text = block.text.trim()
        if (text) pieces.push(text)
      }
      const visual = (page.source_kind === 'image' || visualPages.has(page.id)) && !embeddedCovered
      if (visual) {
        let reading = readingByPage.get(page.id)
        if (!reading?.vision) {
          const result = await this.options.images.vision({ documentVersionId: versionId, pageId: page.id })
          if (result.ok) {
            reading = { ...(reading ?? { vision: '', ocr: '' }), vision: result.data.reading.text.trim() }
          } else if (!reading?.ocr) {
            const ocr = await this.options.images.ocr({ documentVersionId: versionId, pageId: page.id })
            if (ocr.ok) {
              reading = { ...(reading ?? { vision: '', ocr: '' }), ocr: ocr.data.reading.text.trim() }
            } else {
              pageWarnings.push(`第 ${page.ordinal + 1} 页有图片，但读图没有成功：${result.error.message}`)
            }
          }
        }
        const visualText = reading?.vision || reading?.ocr || ''
        if (visualText) pieces.push(visualText)
      }
      if (pendingVision.delete(page.id)) {
        visionDone += 1
        this.progress({ phase: 'vision', done: visionDone, total: visionTotal })
      }
      const merged = pieces.join('\n').trim()
      if (merged) return { text: `${label}\n${merged}`, warnings: pageWarnings }
      pageWarnings.push(`第 ${page.ordinal + 1} 页没有可用的内容。`)
      return { text: '', warnings: pageWarnings }
    })
    for (const result of pageResults) {
      if (result.text) parts.push(result.text)
      warnings.push(...result.warnings)
    }

    const slideGroups = new Map<number, string[]>()
    const loose: string[] = []
    const embeddedTexts: string[] = []
    for (const block of blocks) {
      if (block.page_id) continue
      if (block.kind === 'image_region' && artifactIdFrom(block.locator_json)) {
        const text = await readEmbedded(block)
        if (text) embeddedTexts.push(text)
        continue
      }
      const text = block.text.trim()
      if (!text) continue
      const slide = slideNumberFromLocator(block.locator_json)
      if (slide === null) {
        loose.push(text)
        continue
      }
      const current = slideGroups.get(slide) ?? []
      current.push(text)
      slideGroups.set(slide, current)
    }
    for (const [slide, values] of [...slideGroups.entries()].sort((a, b) => a[0] - b[0])) {
      parts.push(`【第 ${slide} 页 / 幻灯片】\n${values.join('\n')}`)
    }
    if (loose.length > 0) parts.push(`【整份文稿的连续正文】\n${loose.join('\n')}`)
    if (embeddedTexts.length > 0) {
      parts.push(
        `【整份文稿的内嵌图片与图表】\n${embeddedTexts.map((text, index) => `${index + 1}. ${text}`).join('\n')}`,
      )
    }
    if (parts.length === 0) throw new ArgumentError('这份文稿还没有可读内容，先在「文稿」里等解析完成。')

    const full = parts.join('\n\n')
    const truncated = full.length > MAX_MATERIAL_CHARS
    return {
      text: truncated ? full.slice(0, MAX_MATERIAL_CHARS) : full,
      chars: full.length,
      warnings,
      truncated,
    }
  }

  private detail(sessionId: string): StudySessionDetail {
    const session = this.requireSession(sessionId)
    const units = this.units(sessionId)
    const messages = this.messages(sessionId)
    const summary = this.summary(session)
    return {
      sessionId: session.id,
      documentVersionId: session.document_version_id,
      title: session.title,
      subject: session.subject,
      sourceName: session.source_name,
      unitCount: units.length,
      messageCount: messages.length,
      status: session.status,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      overview: session.overview,
      outline: this.outline(session),
      units,
      messages,
      checks: this.checks(sessionId),
      warnings: parseStringList(session.warnings_json),
      truncated: Number(session.truncated) === 1,
      materialChars: Number(session.material_chars),
      materialChunks: Number(session.material_chunks ?? 1),
      habits: this.readHabits(session),
      summary,
      usage: this.usageOf(sessionId),
    }
  }

  /** 用量聚合容错：统计表不在或为空时显示 0，不影响看课。 */
  private usageOf(sessionId: string): StudyUsage {
    try {
      return this.store.usageOfSession(sessionId)
    } catch {
      return { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 }
    }
  }

  private checks(sessionId: string): StudyCheck[] {
    return this.store.listChecks(sessionId).map((row) => ({
      unitOrdinal: Number(row.unit_ordinal),
      segmentIndex: Number(row.segment_index),
      question: row.question,
      answer: row.answer,
      createdAt: row.created_at,
    }))
  }

  private units(sessionId: string): StudyUnit[] {
    return this.store.listUnits(sessionId).map((row) => unitFromRow(row))
  }

  private messages(sessionId: string): StudyMessage[] {
    return this.store.listMessages(sessionId).map(messageFromRow)
  }

  private outline(session: StudySessionRow): string[] {
    return parseStringList(session.outline_json)
  }

  private readHabits(session: StudySessionRow): Habits {
    try {
      const parsed = JSON.parse(session.habits_json) as unknown
      return sanitizeHabits(parsed)
    } catch {
      return DEFAULT_HABITS
    }
  }

  private summary(session: StudySessionRow): StudySummary | null {
    if (!session.summary_json) return null
    try {
      const parsed = JSON.parse(session.summary_json) as StudySummary
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.mastered)) return null
      return parsed
    } catch {
      return null
    }
  }

  private requireSession(sessionId: string): StudySessionRow {
    const session = this.store.getSession(sessionId)
    if (!session) throw new ArgumentError('找不到这门课，可能已经被删除。')
    return session
  }

  private config() {
    const ai = this.options.settings.load().ai
    if (!ai || !ai.apiKey.trim()) throw new AiError('AI_NOT_CONFIGURED', '先在「模型」里填好 API 地址、模型和密钥。')
    if (!ai.baseUrl.trim() || !ai.model.trim()) throw new AiError('AI_NOT_CONFIGURED', '模型地址和模型名不能为空。')
    return ai
  }

  private client(): AiClient {
    const ai = this.config()
    // 82 页课件的拆课 JSON 可能要两三分钟才能吐完，120 秒会把长课件拦腰打断。
    return new AiClient(ai, this.options.fetchImpl ?? globalThis.fetch, 300_000, (kind, usage) => {
      this.recordUsage(kind, usage)
    })
  }

  /** token 用量落库：口径见 ai_usage；cached_tokens 是 DeepSeek 前缀缓存命中的部分。 */
  private recordUsage(kind: string, usage: { promptTokens: number; cachedTokens: number; completionTokens: number }): void {
    try {
      this.store.insertUsage({
        sessionId: this.usageSessionId,
        documentVersionId: this.usageVersionId,
        kind,
        promptTokens: usage.promptTokens,
        cachedTokens: usage.cachedTokens,
        completionTokens: usage.completionTokens,
        createdAt: nowIso(),
      })
    } catch {
      // 用量统计不许影响课程生成。
    }
  }

  private progress(progress: StudyProgress): void {
    try {
      this.options.onProgress?.(progress)
    } catch {
      // 进度只是界面提示，送不出去不能拖垮建课。
    }
  }

  private documentMeta(versionId: string): { displayName: string; title: string } {
    const row = this.options.db.get<{ display_name: string }>(
      `SELECT d.display_name FROM document_versions v
       JOIN documents d ON d.id = v.document_id
       WHERE v.id = ?`,
      versionId,
    )
    if (!row) throw new ArgumentError('找不到这份文稿。')
    return { displayName: row.display_name, title: row.display_name }
  }

  private createBody(body: unknown): { requestId: string; documentVersionId: string; title: string; subject: string } {
    if (!isPlainObject(body)) throw new ArgumentError('请求格式不正确。')
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
    if (!requestId || requestId.length > 80) throw new ArgumentError('请求缺少有效的 requestId。')
    const documentVersionId = typeof body.documentVersionId === 'string' ? body.documentVersionId.trim() : ''
    if (!isUuid(documentVersionId)) throw new ArgumentError('documentVersionId 不是有效的文稿版本。')
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : ''
    const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 60) : ''
    return { requestId, documentVersionId, title, subject }
  }

  private sendBody(body: unknown): { sessionId: string; content: string; unitOrdinal: number | null } {
    if (!isPlainObject(body)) throw new ArgumentError('请求格式不正确。')
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!isUuid(sessionId)) throw new ArgumentError('sessionId 不是有效的课堂。')
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (!content) throw new ArgumentError('先写一句想问老师的话。')
    if (content.length > MAX_MESSAGE_CHARS) throw new ArgumentError(`一次最多问 ${MAX_MESSAGE_CHARS} 个字。`)
    const ordinal = body.unitOrdinal
    if (ordinal != null && (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0)) {
      throw new ArgumentError('unitOrdinal 不是有效的小讲序号。')
    }
    return { sessionId, content, unitOrdinal: typeof ordinal === 'number' ? ordinal : null }
  }

  private checkBody(body: unknown): { sessionId: string; unitOrdinal: number; segmentIndex: number; answer: string } {
    if (!isPlainObject(body)) throw new ArgumentError('请求格式不正确。')
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!isUuid(sessionId)) throw new ArgumentError('sessionId 不是有效的课堂。')
    const unitOrdinal = body.unitOrdinal
    if (typeof unitOrdinal !== 'number' || !Number.isInteger(unitOrdinal) || unitOrdinal < 0) {
      throw new ArgumentError('unitOrdinal 不是有效的小讲序号。')
    }
    const segmentIndex = body.segmentIndex
    if (typeof segmentIndex !== 'number' || !Number.isInteger(segmentIndex) || segmentIndex < 0) {
      throw new ArgumentError('segmentIndex 不是有效的讲解序号。')
    }
    const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
    if (!answer) throw new ArgumentError('先写下你的答案。')
    if (answer.length > MAX_ANSWER_CHARS) throw new ArgumentError(`一次最多答 ${MAX_ANSWER_CHARS} 个字。`)
    return { sessionId, unitOrdinal, segmentIndex, answer }
  }

  private sessionId(body: unknown): string {    if (!isPlainObject(body)) throw new ArgumentError('请求格式不正确。')
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!isUuid(sessionId)) throw new ArgumentError('sessionId 不是有效的课堂。')
    return sessionId
  }

  private failure(requestId: string, error: unknown): Result<never> {
    if (error instanceof AiError) return fail(requestId, error.code, error.message)
    if (error instanceof ArgumentError) return fail(requestId, 'INVALID_ARGUMENT', error.message)
    console.error('[study]', error)
    return fail(requestId, 'STORAGE_ERROR', '课堂数据处理失败，请重试。')
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function artifactIdFrom(raw: string | undefined): string {
  if (!raw) return ''
  try {
    const locator = JSON.parse(raw) as { artifactId?: unknown }
    return typeof locator.artifactId === 'string' ? locator.artifactId : ''
  } catch {
    return ''
  }
}

function slideNumberFromLocator(raw: string | undefined): number | null {
  if (!raw) return null
  try {
    const locator = JSON.parse(raw) as { slideNumber?: unknown }
    return typeof locator.slideNumber === 'number' && Number.isInteger(locator.slideNumber) && locator.slideNumber > 0
      ? locator.slideNumber
      : null
  } catch {
    return null
  }
}

function parseStringList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function unitFromRow(row: StudyUnitRow): StudyUnit {
  return {
    id: row.id,
    ordinal: Number(row.ordinal),
    title: row.title,
    source: row.source,
    minutes: Number(row.minutes),
    keyPoints: parseStringList(row.key_points_json),
    segments: parseSegments(row.segments_json),
  }
}

function parseSegments(raw: string): StudyUnit['segments'] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        const row = isPlainObject(item) ? item : {}
        return {
          source: typeof row.source === 'string' ? row.source : '',
          explain: typeof row.explain === 'string' ? row.explain : '',
          check: typeof row.check === 'string' ? row.check : '',
        }
      })
      .filter((segment) => segment.source && segment.explain)
  } catch {
    return []
  }
}

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ArgumentError, parseBlocksQuery, parseImportBody, parseJobIdBody, parseLocator, parsePagination, parseRetryBody, parseVersionBody } from '../domain/validation'
import { canRetryJob, isTerminalJob } from '../domain/jobs'
import { nowIso } from '../domain/ids'
import { MESSAGES, LIMITS, PARSER_VERSION, type Limits } from '../shared/constants'
import {
  DOCUMENT_FORMATS,
  fail,
  ok,
  type BlockList,
  type BlockView,
  type DeleteDocumentResult,
  type DocumentDetail,
  type DocumentList,
  type ImportResult,
  type JobChangedEvent,
  type JobSnapshot,
  type JobState,
  type Locator,
  type OpenSourceResult,
  type PageList,
  type PickResult,
  type Prerequisites,
  type PreviewFocus,
  type Result,
  type ReviewState,
} from '../shared/contract'
import { safeDisplayName, safeStoredName, sanitizeDocumentText } from '../shared/text'
import type { OfficeGateway } from '../providers/officeGateway'
import { officeIsolationStatus } from '../providers/isolation'
import { planOfficeConversion } from '../providers/officeGateway'
import type { SettingsStore } from '../providers/settings'
import type { WorkerHandle, WorkerHost } from '../providers/workerHost'
import { resolvePreview } from '../retrieval/openSource'
import { isInsideRoot, realpathInside, resolveInside } from '../storage/paths'
import type { AppDatabase } from '../storage/database'
import { Store, type JobRow, type VersionRow } from '../storage/store'
import { AppError, isAppError } from './errors'
import { detectFormat } from './formats'
import { HandleTable } from './handles'
import { hashFile, sha256Bytes } from './hash'
import type { ParseResult, ParseTask, ProgressReport } from './parseTypes'

export interface NativeDialogs {
  pickDocuments(windowId: string): Promise<{ cancelled: boolean; files: Array<{ path: string; name: string; sizeBytes: number }> }>
  pickExecutable(windowId: string): Promise<{ cancelled: boolean; path: string | null }>
}

export interface DeskEvents {
  jobsChanged(event: JobChangedEvent): void
  focus(windowId: string, target: PreviewFocus): boolean
}

const STAGES = new Set(['queued', 'extract', 'render', 'commit', 'done', 'canceling', 'cancelled', 'interrupted'])

export class DocumentService {
  private readonly store: Store
  private readonly handles = new HandleTable()
  private readonly live = new Map<string, WorkerHandle>()
  private readonly cancelRequested = new Set<string>()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly inflight = new Set<Promise<void>>()
  private readonly limits: Limits

  constructor(
    private readonly options: {
      db: AppDatabase
      root: string
      worker: WorkerHost
      office: OfficeGateway
      dialogs: NativeDialogs
      events: DeskEvents
      settings: SettingsStore
      limits?: Limits
      repair?: boolean
      recheckIsolation?: () => Promise<void>
    },
  ) {
    this.store = new Store(options.db)
    this.limits = options.limits ?? LIMITS
    if (options.repair !== false) this.repairOnStart()
  }

  get root(): string {
    return this.options.root
  }

  dropWindow(windowId: string): void {
    this.handles.dropWindow(windowId)
  }

  async settle(): Promise<void> {
    await Promise.all([...this.inflight])
  }

  async close(): Promise<void> {
    for (const handle of this.live.values()) handle.kill()
    await this.settle()
    this.options.db.close()
  }

  async pick(windowId: string): Promise<Result<PickResult>> {
    const requestId = randomUUID()
    try {
      const picked = await this.options.dialogs.pickDocuments(windowId)
      if (picked.cancelled || picked.files.length === 0) return ok(requestId, { cancelled: true, files: [] })
      const files = picked.files.map((file) => {
        const handle = randomUUID()
        const name = safeDisplayName(file.name)
        this.handles.put({ handle, windowId, filePath: file.path, name, sizeBytes: file.sizeBytes })
        return { handle, name, sizeBytes: file.sizeBytes }
      })
      return ok(requestId, { cancelled: false, files })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  async import(windowId: string, body: unknown): Promise<Result<ImportResult>> {
    let requestId: string = randomUUID()
    try {
      const parsed = parseImportBody(body)
      requestId = parsed.requestId
      const replay = this.store.getJobByRequestId(parsed.requestId)
      if (replay) {
        const version = this.store.getVersion(replay.document_version_id)
        const document = version ? this.store.getDocument(version.document_id) : undefined
        if (!version || !document) return fail(parsed.requestId, 'STORAGE_ERROR', '找不到这次导入对应的文稿。')
        return ok(parsed.requestId, { documentId: document.id, documentVersionId: version.id, jobId: replay.id })
      }
      const held = this.handles.consume(windowId, parsed.handle)
      if (held === 'used') return fail(parsed.requestId, 'CONFLICT', '这个选择已经用过。请重新选择文件。')
      if (held !== 'missing' && held !== 'wrong-window') {
        return await this.importHeld(parsed.requestId, held)
      }
      return fail(parsed.requestId, 'NOT_FOUND', '找不到这个文件选择。请重新选择。')
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  list(body: unknown): Result<DocumentList> {
    const requestId = randomUUID()
    try {
      const page = parsePagination(body ?? {})
      const total = this.store.countDocuments()
      const rows = this.store.listDocuments(page.offset, page.limit)
      return ok(requestId, {
        total,
        items: rows.map((row) => ({
          documentId: row.document_id,
          documentVersionId: row.document_version_id,
          displayName: row.display_name,
          format: row.format as DocumentList['items'][number]['format'],
          sizeBytes: row.size_bytes,
          status: row.status,
          createdAt: row.created_at,
          sha256: row.sha256,
          job: row.job_id
            ? {
                jobId: row.job_id,
                state: row.job_state as JobState,
                stage: row.job_stage ?? 'queued',
                completed: row.job_completed ?? 0,
                total: row.job_total,
                ...(row.error_code ? { error: { code: row.error_code, message: row.error_message ?? '' } } : {}),
              }
            : null,
        })),
      })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  get(body: unknown): Result<DocumentDetail> {
    const requestId = randomUUID()
    try {
      const parsed = parseVersionBody(body)
      const version = this.store.getVersion(parsed.documentVersionId)
      if (!version) return fail(requestId, 'NOT_FOUND', '没有这份文稿版本。')
      const document = this.store.getDocument(version.document_id)
      if (!document) return fail(requestId, 'NOT_FOUND', '没有这份文稿。')
      const content = this.store.countContent(version.id)
      return ok(requestId, {
        documentId: document.id,
        documentVersionId: version.id,
        displayName: document.display_name,
        format: version.format as DocumentDetail['format'],
        sha256: version.sha256,
        sizeBytes: version.size_bytes,
        status: version.status,
        parserVersion: version.parser_version,
        createdAt: version.created_at,
        pageCount: content.pages,
        blockCount: content.blocks,
        job: snapshot(this.store.latestJob(version.id)),
        warnings: this.store.listIssues(version.id).map((issue) => ({
          id: issue.id,
          code: issue.code,
          message: sanitizeDocumentText(issue.message),
          reviewState: issue.review_state,
          pageId: issue.page_id,
          blockId: issue.block_id,
          createdAt: issue.created_at,
        })),
        sourceMetadata: this.readMetadata(version.id),
      })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  async delete(body: unknown): Promise<Result<DeleteDocumentResult>> {
    const requestId = randomUUID()
    try {
      const parsed = parseVersionBody(body)
      const version = this.store.getVersion(parsed.documentVersionId)
      if (!version) return fail(requestId, 'NOT_FOUND', '没有这份文稿。')
      const document = this.store.getDocument(version.document_id)
      if (!document) return fail(requestId, 'NOT_FOUND', '没有这份文稿。')
      const versions = this.store.listVersions(document.id)
      const versionIds = new Set(versions.map((item) => item.id))
      // 正在解析的文稿先停机：等 worker 真正退出再删，免得删文件时还有人往里写。
      const running: WorkerHandle[] = []
      for (const [jobId, handle] of this.live) {
        const job = this.store.getJob(jobId)
        if (job && versionIds.has(job.document_version_id)) running.push(handle)
      }
      if (running.length) {
        for (const handle of running) handle.kill()
        await Promise.all(running.map((handle) => handle.exited.catch(() => undefined)))
      }
      const jobIds = versions.flatMap((item) => this.store.listJobIds(item.id))
      const removed = this.store.deleteDocument(document.id)
      for (const jobId of this.cancelRequested) {
        if (!this.store.getJob(jobId)) this.cancelRequested.delete(jobId)
      }
      // 库删成功后再清文件：宁可留孤儿字节，也不让记录指向不存在的文件。
      for (const rel of [`originals/${document.id}`, `artifacts/${document.id}`]) {
        const target = resolveInside(this.root, rel)
        if (target && isInsideRoot(this.root, target)) fs.rmSync(target, { recursive: true, force: true })
      }
      for (const jobId of jobIds) {
        const workDir = resolveInside(this.root, `work/${jobId}`)
        if (workDir && isInsideRoot(this.root, workDir)) fs.rmSync(workDir, { recursive: true, force: true })
      }
      return ok(requestId, { documentId: document.id, removedVersions: removed })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  pages(body: unknown): Result<PageList> {
    const requestId = randomUUID()
    try {
      const parsed = parseVersionBody(body)
      if (!this.store.getVersion(parsed.documentVersionId)) return fail(requestId, 'NOT_FOUND', '没有这份文稿版本。')
      const total = this.store.countPages(parsed.documentVersionId)
      const items = this.store.listPages(parsed.documentVersionId, parsed.offset, parsed.limit).map((page) => ({
        pageId: page.id,
        ordinal: page.ordinal,
        sourceKind: page.source_kind,
        sourceNumber: page.source_number,
        previewResourceId: page.preview_resource_id ?? null,
        width: page.width,
        height: page.height,
        status: page.status,
      }))
      return ok(requestId, { items, total })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  blocks(body: unknown): Result<BlockList> {
    const requestId = randomUUID()
    try {
      const query = parseBlocksQuery(body)
      if (query.kind === 'page') {
        const page = this.store.getPage(query.pageId)
        if (!page) return fail(requestId, 'NOT_FOUND', '没有这一页。')
        const total = this.store.countBlocksByPage(page.id)
        const rows = this.store.listBlocksByPage(page.id, query.offset, query.limit)
        return ok(requestId, { total, items: rows.map((row) => this.toBlock(row)) })
      }
      if (!this.store.getVersion(query.documentVersionId)) return fail(requestId, 'NOT_FOUND', '没有这份文稿版本。')
      const total = this.store.countUnpagedBlocks(query.documentVersionId)
      const rows = this.store.listUnpagedBlocks(query.documentVersionId, query.offset, query.limit)
      return ok(requestId, { total, items: rows.map((row) => this.toBlock(row)) })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  openSource(windowId: string, body: unknown): Result<OpenSourceResult> {
    const requestId = randomUUID()
    try {
      const locator = parseLocator(body)
      const version = this.store.getVersion(locator.documentVersionId)
      if (!version) return fail(requestId, 'NOT_FOUND', '没有这份文稿版本。')
      const focus = resolvePreview(
        locator,
        this.store.listBlockLocators(version.id),
        this.store.listPages(version.id, 0, this.limits.maxPages).map((page) => ({
          id: page.id,
          document_version_id: page.document_version_id,
          ordinal: page.ordinal,
        })),
      )
      if (!focus) return ok(requestId, { opened: false })
      return ok(requestId, { opened: this.options.events.focus(windowId, focus) })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  job(body: unknown): Result<JobSnapshot> {
    const requestId = randomUUID()
    try {
      const jobId = parseJobIdBody(body)
      const job = this.store.getJob(jobId)
      if (!job) return fail(requestId, 'NOT_FOUND', '没有这个任务。')
      const view = snapshot(job)
      if (!view) return fail(requestId, 'NOT_FOUND', '没有这个任务。')
      return ok(requestId, view)
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  async cancel(body: unknown): Promise<Result<{ state: JobState }>> {
    const requestId = randomUUID()
    try {
      const jobId = parseJobIdBody(body)
      let waiting: Promise<void> | null = null
      const immediate = await this.lock(jobId, () => {
        const job = this.store.getJob(jobId)
        if (!job) return { missing: true as const }
        if (isTerminalJob(job.state)) return { state: job.state }
        this.cancelRequested.add(jobId)
        const live = this.live.get(jobId)
        if (!live) {
          const updated = this.markCancelled(job)
          return { state: updated.state, event: toEvent(updated) }
        }
        const updated = this.store.updateJob(jobId, { stage: 'canceling', seq: job.seq + 1, updated_at: nowIso() })
        live.kill()
        waiting = live.exited
        return { state: updated.state, event: toEvent(updated), pending: true as const }
      })
      if ('missing' in immediate) return fail(requestId, 'NOT_FOUND', '没有这个任务。')
      if (immediate.event) this.emit(immediate.event)
      if (!('pending' in immediate) || !waiting) return ok(requestId, { state: immediate.state })
      await waiting
      const finalJob = await this.lock(jobId, () => {
        const job = this.store.getJob(jobId)
        if (!job) return null
        if (isTerminalJob(job.state)) return job
        return this.markCancelled(job)
      })
      this.cancelRequested.delete(jobId)
      if (!finalJob) return fail(requestId, 'NOT_FOUND', '没有这个任务。')
      this.emit(toEvent(finalJob))
      return ok(requestId, { state: finalJob.state })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  async retry(body: unknown): Promise<Result<{ jobId: string }>> {
    const requestId = randomUUID()
    try {
      const parsed = parseRetryBody(body)
      const existing = this.store.getJobByRequestId(parsed.requestId)
      if (existing) return ok(parsed.requestId, { jobId: existing.id })
      const source = this.store.getJob(parsed.jobId)
      if (!source) return fail(parsed.requestId, 'NOT_FOUND', '没有这个任务。')
      if (!canRetryJob(source.state)) return fail(parsed.requestId, 'CONFLICT', '这个任务还在进行，不能重试。')
      const now = nowIso()
      const jobId = randomUUID()
      const created = this.options.db.transaction(() => {
        const row: JobRow = {
          id: jobId,
          document_version_id: source.document_version_id,
          request_id: parsed.requestId,
          retry_of: source.id,
          state: 'queued',
          stage: 'queued',
          completed: 0,
          total: null,
          seq: 1,
          error_code: null,
          error_message: null,
          created_at: now,
          updated_at: now,
        }
        this.store.insertJob(row)
        return row
      })
      this.emit(toEvent(created))
      this.start(jobId)
      return ok(parsed.requestId, { jobId })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  async prerequisites(): Promise<Result<Prerequisites>> {
    const requestId = randomUUID()
    try {
      return ok(requestId, await this.prerequisiteView())
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  async pickLibreOffice(windowId: string): Promise<Result<Prerequisites>> {
    const requestId = randomUUID()
    try {
      const picked = await this.options.dialogs.pickExecutable(windowId)
      if (picked.cancelled || !picked.path) return ok(requestId, await this.prerequisiteView())
      this.rememberExecutable(picked.path)
      return ok(requestId, await this.prerequisiteView())
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  async recheckLibreOffice(): Promise<Result<Prerequisites>> {
    const requestId = randomUUID()
    try {
      // "重新检查" earns the evidence again: nothing carries over from the
      // previous run, so a changed machine cannot inherit an old pass.
      if (this.options.recheckIsolation) {
        await this.options.recheckIsolation()
      }
      return ok(requestId, await this.prerequisiteView())
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  private async importHeld(requestId: string, held: { filePath: string; name: string }): Promise<Result<ImportResult>> {
    const source = await readableFile(held.filePath)
    const stat = await fs.promises.stat(source)
    if (stat.size > this.limits.maxFileBytes) {
      return fail(requestId, 'LIMIT_EXCEEDED', '文件超过本阶段的大小上限。')
    }
    const header = await readHeader(source)
    const format = detectFormat(held.name, header)
    if ((format === 'txt' || format === 'markdown') && stat.size > this.limits.maxTextFileBytes) {
      return fail(requestId, 'LIMIT_EXCEEDED', '文本文件超过本阶段的大小上限。')
    }
    const documentId = randomUUID()
    const versionId = randomUUID()
    const jobId = randomUUID()
    const rel = `originals/${documentId}/${versionId}/${safeStoredName(held.name)}`
    const destination = resolveInside(this.root, rel)
    if (!destination) return fail(requestId, 'STORAGE_ERROR', '无法在资料目录内保存原文。')
    await fs.promises.mkdir(path.dirname(destination), { recursive: true })
    try {
      await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL)
      const hashed = await hashFile(destination)
      const now = nowIso()
      const created = this.options.db.transaction(() => {
        this.store.insertDocument({ id: documentId, display_name: held.name, created_at: now })
        this.store.insertVersion({
          id: versionId,
          document_id: documentId,
          sha256: hashed.sha256,
          format,
          size_bytes: hashed.sizeBytes,
          original_relpath: rel,
          status: 'stored',
          parser_version: PARSER_VERSION,
          created_at: now,
        })
        const job: JobRow = {
          id: jobId,
          document_version_id: versionId,
          request_id: requestId,
          retry_of: null,
          state: 'queued',
          stage: 'queued',
          completed: 0,
          total: null,
          seq: 1,
          error_code: null,
          error_message: null,
          created_at: now,
          updated_at: now,
        }
        this.store.insertJob(job)
        return job
      })
      this.emit(toEvent(created))
      this.start(jobId)
      return ok(requestId, { documentId, documentVersionId: versionId, jobId })
    } catch (error) {
      await fs.promises.rm(destination, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private repairOnStart(): void {
    this.store.interruptInflight(nowIso())
    for (const version of this.store.listVersionsByStatus('parsing')) {
      this.store.setVersionStatus(version.id, this.statusFor(version.id, false))
    }
    fs.rmSync(path.join(this.root, 'work'), { recursive: true, force: true })
    fs.mkdirSync(path.join(this.root, 'work'), { recursive: true })
  }

  private start(jobId: string): void {
    const promise = this.run(jobId)
    this.inflight.add(promise)
    promise.finally(() => this.inflight.delete(promise)).catch(() => undefined)
  }

  private async run(jobId: string): Promise<void> {
    const queued = this.store.getJob(jobId)
    if (!queued || queued.state !== 'queued') return
    const version = this.store.getVersion(queued.document_version_id)
    const workDir = resolveInside(this.root, `work/${queued.id}`)
    if (!version || !workDir) {
      await this.lock(jobId, () => {
        const current = this.store.getJob(jobId)
        if (!current || current.state !== 'queued') return
        this.fail(current, version ? 'STORAGE_ERROR' : 'NOT_FOUND', version ? '无法创建任务工作目录。' : '文稿版本已经不存在。')
      })
      return
    }
    let task: ParseTask
    try {
      const absolute = realpathInside(this.root, resolveInside(this.root, version.original_relpath) ?? '')
      if (!absolute) throw new AppError('FILE_UNREADABLE', '保存的原文不在资料目录内。')
      const hashed = await hashFile(absolute)
      if (hashed.sha256 !== version.sha256) throw new AppError('FILE_UNREADABLE', '原文哈希与入库时不一致。')
      const settings = this.options.settings.load()
      const description = await this.options.office.describe(settings)
      task = {
        jobId: queued.id,
        documentVersionId: version.id,
        format: version.format as ParseTask['format'],
        dataRoot: this.root,
        originalRelpath: version.original_relpath,
        workDir,
        limits: this.limits,
        office: planOfficeConversion(description),
      }
    } catch (error) {
      await this.lock(jobId, () => {
        const current = this.store.getJob(jobId)
        if (!current || current.state !== 'queued') return
        if (isAppError(error)) this.fail(current, error.code, error.message)
        else this.fail(current, 'PARSE_FAILED', '处理准备失败。')
      })
      return
    }
    const started = await this.lock(jobId, () => {
      const job = this.store.getJob(jobId)
      if (!job || job.state !== 'queued') return null
      if (this.cancelRequested.has(jobId)) {
        this.emit(toEvent(this.markCancelled(job)))
        return null
      }
      fs.mkdirSync(workDir, { recursive: true })
      const handle = this.options.worker.start(task, (progress) => {
        queueMicrotask(() => this.noteProgress(job.id, progress))
      })
      this.live.set(job.id, handle)
      const updated = this.store.updateJob(job.id, {
        state: 'running',
        stage: 'extract',
        seq: job.seq + 1,
        updated_at: nowIso(),
      })
      this.store.setVersionStatus(version.id, 'parsing')
      this.emit(toEvent(updated))
      return { job: updated, handle, workDir }
    })
    if (!started) return
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      started.handle.kill()
    }, this.limits.workerTimeoutMs)
    try {
      const result = await started.handle.done
      clearTimeout(timer)
      await this.lock(jobId, () => {
        const job = this.store.getJob(jobId)
        if (!job || job.state !== 'running' || this.cancelRequested.has(jobId)) return
        this.applyResult(job, version, result)
      })
    } catch (error) {
      clearTimeout(timer)
      await this.lock(jobId, () => {
        const job = this.store.getJob(jobId)
        if (!job || job.state !== 'running' || this.cancelRequested.has(jobId)) return
        if (timedOut) this.fail(job, 'RESOURCE_LIMIT', '处理超过时间上限，已停止。')
        else if (isAppError(error)) this.fail(job, error.code, error.message)
        else this.fail(job, 'PARSE_FAILED', '处理进程失败。')
      })
    } finally {
      await started.handle.exited
      this.live.delete(jobId)
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  }

  private noteProgress(jobId: string, progress: ProgressReport): void {
    void this.lock(jobId, () => {
      if (this.cancelRequested.has(jobId)) return
      const job = this.store.getJob(jobId)
      if (!job || job.state !== 'running') return
      const completed = Number.isInteger(progress.completed) && progress.completed >= 0 ? progress.completed : job.completed
      const total = progress.total === null || (Number.isInteger(progress.total) && progress.total >= 0) ? progress.total : job.total
      const updated = this.store.updateJob(jobId, {
        stage: STAGES.has(progress.stage) ? progress.stage : 'extract',
        completed,
        total,
        seq: job.seq + 1,
        updated_at: nowIso(),
      })
      this.emit(toEvent(updated))
    })
  }

  private applyResult(job: JobRow, version: VersionRow, result: ParseResult): void {
    const placed: Array<{ pageOrdinal: number; id: string; rel: string; sha256: string }> = []
    for (const page of result.pages) {
      if (!page.imagePath) continue
      const workDir = resolveInside(this.root, `work/${job.id}`)
      const realImage = workDir && isInsideRoot(workDir, page.imagePath) ? realpathInside(workDir, page.imagePath) : null
      if (!realImage) continue
      const id = randomUUID()
      const rel = `artifacts/${version.document_id}/${version.id}/${id}.png`
      const destination = resolveInside(this.root, rel)
      if (!destination) continue
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.copyFileSync(realImage, destination)
      const body = fs.readFileSync(destination)
      placed.push({ pageOrdinal: page.ordinal, id, rel, sha256: sha256Bytes(body) })
    }
    let metadata: { id: string; rel: string; sha256: string } | null = null
    if (result.sourceMetadata && Object.keys(result.sourceMetadata).length) {
      const id = randomUUID()
      const rel = `artifacts/${version.document_id}/${version.id}/${id}.json`
      const destination = resolveInside(this.root, rel)
      if (destination) {
        const body = Buffer.from(JSON.stringify(result.sourceMetadata))
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.writeFileSync(destination, body)
        metadata = { id, rel, sha256: sha256Bytes(body) }
      }
    }
    // 内嵌图片（DOCX 的图、图解题）在解析时写进了工作目录。这里把它们收进文库
    // artifacts，并把 artifactId 写回块的 locator，授课阶段才能按块读图。
    const embedded = new Map<number, { id: string; rel: string; sha256: string; mime: string }>()
    const embeddedRoot = resolveInside(this.root, `work/${job.id}`)
    if (embeddedRoot) {
      for (const block of result.blocks) {
        if (!block.embeddedImage) continue
        const realImage = isInsideRoot(embeddedRoot, block.embeddedImage.path)
          ? realpathInside(embeddedRoot, block.embeddedImage.path)
          : null
        if (!realImage) continue
        const id = randomUUID()
        const rel = `artifacts/${version.document_id}/${version.id}/${id}.${extensionForMime(block.embeddedImage.mime)}`
        const destination = resolveInside(this.root, rel)
        if (!destination) continue
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.copyFileSync(realImage, destination)
        embedded.set(block.ordinal, {
          id,
          rel,
          sha256: sha256Bytes(fs.readFileSync(destination)),
          mime: block.embeddedImage.mime,
        })
      }
    }
    const previous = this.store.listArtifacts(version.id)
    const now = nowIso()
    const updated = this.options.db.transaction(() => {
      this.store.deleteParseOutput(version.id)
      const pageIds = new Map<number, string>()
      for (const page of result.pages) {
        const pageId = randomUUID()
        pageIds.set(page.ordinal, pageId)
        const image = placed.find((item) => item.pageOrdinal === page.ordinal)
        this.store.insertPage({
          id: pageId,
          document_version_id: version.id,
          ordinal: page.ordinal,
          source_kind: page.sourceKind,
          source_number: page.sourceNumber,
          image_relpath: image?.rel ?? null,
          width: page.width,
          height: page.height,
          status: page.status,
        })
        if (image) {
          this.store.insertArtifact({
            id: image.id,
            document_version_id: version.id,
            page_id: pageId,
            kind: 'page-image',
            relpath: image.rel,
            mime: 'image/png',
            sha256: image.sha256,
          })
        }
      }
      const blockIds = new Map<number, string>()
      for (const block of result.blocks) {
        const blockId = randomUUID()
        blockIds.set(block.ordinal, blockId)
        const pageId = block.pageOrdinal ? pageIds.get(block.pageOrdinal) ?? null : null
        const locator: Locator = { ...block.locator, documentVersionId: version.id }
        if (pageId) locator.pageId = pageId
        else delete locator.pageId
        const image = embedded.get(block.ordinal)
        if (image) locator.artifactId = image.id
        this.store.insertBlock({
          id: blockId,
          document_version_id: version.id,
          page_id: pageId,
          ordinal: block.ordinal,
          kind: block.kind,
          text: sanitizeDocumentText(block.text),
          locator_json: JSON.stringify(locator),
          extraction_method: block.extractionMethod,
          review_state: block.reviewState,
        })
        if (image) {
          this.store.insertArtifact({
            id: image.id,
            document_version_id: version.id,
            page_id: pageId,
            kind: 'embedded-image',
            relpath: image.rel,
            mime: image.mime,
            sha256: image.sha256,
          })
        }
      }
      for (const issue of result.issues) {
        this.store.insertIssue({
          id: randomUUID(),
          document_version_id: version.id,
          page_id: issue.pageOrdinal ? pageIds.get(issue.pageOrdinal) ?? null : null,
          block_id: issue.blockOrdinal ? blockIds.get(issue.blockOrdinal) ?? null : null,
          code: issue.code,
          message: sanitizeDocumentText(issue.message).slice(0, 1000),
          review_state: issue.reviewState,
          created_at: now,
        })
      }
      if (metadata) {
        this.store.insertArtifact({
          id: metadata.id,
          document_version_id: version.id,
          page_id: null,
          kind: 'source-metadata',
          relpath: metadata.rel,
          mime: 'application/json',
          sha256: metadata.sha256,
        })
      }
      const state = result.outcome
      this.store.setVersionStatus(version.id, state === 'succeeded' ? 'ready' : state === 'partial' ? 'partial' : 'failed')
      const total = Math.max(result.pages.length, result.blocks.length, 1)
      return this.store.updateJob(job.id, {
        state,
        stage: 'done',
        completed: state === 'failed' ? 0 : total,
        total,
        seq: job.seq + 1,
        error_code: result.error?.code ?? null,
        error_message: result.error?.message ?? null,
        updated_at: now,
      })
    })
    for (const artifact of previous) {
      const abs = resolveInside(this.root, artifact.relpath)
      if (abs) fs.rmSync(abs, { force: true })
    }
    this.emit(toEvent(updated))
  }

  private fail(job: JobRow, code: string, message: string): void {
    const updated = this.store.updateJob(job.id, {
      state: 'failed',
      stage: 'done',
      seq: job.seq + 1,
      error_code: code,
      error_message: message,
      updated_at: nowIso(),
    })
    this.store.setVersionStatus(job.document_version_id, this.store.countContent(job.document_version_id).blocks + this.store.countContent(job.document_version_id).pages > 0 ? this.statusFor(job.document_version_id, true) : 'failed')
    this.emit(toEvent(updated))
  }

  private markCancelled(job: JobRow): JobRow {
    const updated = this.store.updateJob(job.id, {
      state: 'cancelled',
      stage: 'cancelled',
      seq: job.seq + 1,
      error_code: null,
      error_message: null,
      updated_at: nowIso(),
    })
    this.store.setVersionStatus(job.document_version_id, this.statusFor(job.document_version_id, false))
    return updated
  }

  private statusFor(versionId: string, failed: boolean): string {
    const content = this.store.countContent(versionId)
    if (content.blocks + content.pages === 0) return failed ? 'failed' : 'stored'
    return content.needsReview > 0 ? 'partial' : 'ready'
  }

  private readMetadata(versionId: string): Record<string, string> | null {
    const artifact = this.store.artifactByKind(versionId, 'source-metadata')
    if (!artifact || !artifact.relpath.startsWith('artifacts/')) return null
    const abs = resolveInside(this.root, artifact.relpath)
    const real = abs ? realpathInside(this.root, abs) : null
    if (!real) return null
    try {
      const body = fs.readFileSync(real)
      if (sha256Bytes(body) !== artifact.sha256) return null
      const parsed = JSON.parse(body.toString('utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && key.length < 40) out[key] = sanitizeDocumentText(value).slice(0, 500)
      }
      return Object.keys(out).length ? out : null
    } catch {
      return null
    }
  }

  private toBlock(row: { id: string; ordinal: number; kind: string; text: string; locator_json: string; extraction_method: string; review_state: string }): BlockView {
    let locator: Locator
    try {
      locator = parseLocator(JSON.parse(row.locator_json) as unknown)
    } catch {
      throw new AppError('STORAGE_ERROR', '保存的来源定位无法读取。')
    }
    return {
      blockId: row.id,
      ordinal: row.ordinal,
      kind: row.kind,
      text: row.text,
      locator,
      extractionMethod: row.extraction_method,
      reviewState: row.review_state as ReviewState,
    }
  }

  private async prerequisiteView(): Promise<Prerequisites> {
    const settings = this.options.settings.load()
    const description = await this.options.office.describe(settings)
    const plan = planOfficeConversion(description)
    const status = officeIsolationStatus()
    return {
      libreOffice: {
        fileFound: description.fileFound,
        path: description.fileFound ? description.path : null,
        version: null,
        launched: false,
        message: plan.mode === 'skip' ? plan.message : MESSAGES.isolationUnavailable,
      },
      sandbox: {
        windowsSandboxVerified: status.sandboxVerified,
        networkBlocked: status.sandboxVerified,
        restrictedPermissionsVerified: status.sandboxVerified,
        processTreeLifecycleVerified: status.sandboxVerified,
        boundedResourcesVerified: status.sandboxVerified,
        conversionVerified: status.conversionVerified,
        officeConversionWillRun: plan.mode === 'convert',
        note: status.sandboxVerified ? (status.evidence ?? MESSAGES.sandboxNote) : `${MESSAGES.sandboxNote}${status.detail}`,
      },
      capabilities: { ocr: false, vision: false, formulaUnderstanding: false },
      supportedFormats: [...DOCUMENT_FORMATS],
      legacyRejection: MESSAGES.legacyOffice,
    }
  }

  private rememberExecutable(executable: string): void {
    let found = false
    try {
      const stat = fs.lstatSync(executable)
      found = stat.isFile() || stat.isSymbolicLink()
    } catch {
      found = false
    }
    if (!found) return
    this.options.settings.save({ ...this.options.settings.load(), libreOfficePath: executable })
  }

  private async lock<T>(jobId: string, fn: () => T): Promise<T> {
    const prev = this.tails.get(jobId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tails.set(
      jobId,
      prev.then(
        () => gate,
        () => gate,
      ),
    )
    await prev.catch(() => undefined)
    try {
      return fn()
    } finally {
      release()
    }
  }

  private emit(event: JobChangedEvent): void {
    queueMicrotask(() => this.options.events.jobsChanged(event))
  }

  private asFailure(requestId: string, error: unknown): Result<never> {
    if (error instanceof ArgumentError) return fail(requestId, 'INVALID_ARGUMENT', error.message)
    if (isAppError(error)) return fail(requestId, error.code, error.message)
    console.error(error)
    return fail(requestId, 'STORAGE_ERROR', '本机存储出现错误。')
  }
}

function snapshot(job: JobRow | undefined): JobSnapshot | null {
  if (!job) return null
  return {
    jobId: job.id,
    state: job.state,
    stage: job.stage,
    completed: job.completed,
    total: job.total,
    ...(job.error_code ? { error: { code: job.error_code, message: job.error_message ?? '' } } : {}),
  }
}

function toEvent(job: JobRow): JobChangedEvent {
  return {
    jobId: job.id,
    seq: job.seq,
    state: job.state,
    stage: job.stage,
    completed: job.completed,
    total: job.total,
  }
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/bmp':
      return 'bmp'
    default:
      return 'png'
  }
}

async function readableFile(filePath: string): Promise<string> {
  const listed = await fs.promises.lstat(filePath)
  if (listed.isSymbolicLink()) {
    const real = await fs.promises.realpath(filePath)
    const stat = await fs.promises.stat(real)
    if (!stat.isFile()) throw new AppError('FILE_UNREADABLE', '选择的路径不是文件。')
    return real
  }
  if (!listed.isFile()) throw new AppError('FILE_UNREADABLE', '选择的路径不是文件。')
  return filePath
}

async function readHeader(filePath: string): Promise<Uint8Array> {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(16)
    await handle.read(buffer, 0, 16, 0)
    return buffer
  } finally {
    await handle.close()
  }
}

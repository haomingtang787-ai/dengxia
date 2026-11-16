import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ArgumentError, parseBlocksQuery, parseImportBody, parseJobIdBody, parseLocator, parsePagination, parsePinBody, parseRenameBody, parseRetryBody, parseReviewSettings, parseVersionBody } from '../domain/validation'
import { canRetryJob, isTerminalJob } from '../domain/jobs'
import { nowIso } from '../domain/ids'
import { MESSAGES, LIMITS, PARSER_VERSION, type Limits } from '../shared/constants'
import {
  DOCUMENT_FORMATS,
  fail,
  ok,
  type BlockList,
  type BlockView,
  type BackupResult,
  type DeleteDocumentResult,
  type DocumentDetail,
  type DocumentList,
  type ImportResult,
  type JobChangedEvent,
  type JobSnapshot,
  type JobState,
  type LibraryStats,
  type Locator,
  type OpenSourceResult,
  type PageList,
  type PickResult,
  type Prerequisites,
  type PreviewFocus,
  type Result,
  type ReviewSettingsView,
  type ReviewState,
  type StorageUsage,
} from '../shared/contract'
import { safeDisplayName, safeStoredName, sanitizeDocumentText } from '../shared/text'
import { buildFtsQuery, snippetText, type SearchList } from '../shared/search'
import type { HighlightCreateBody, HighlightList, HighlightView } from '../shared/highlights'
import type { AutoBackupResult, PickBackupDirResult, RestoreApplied, RestorePreview, AppSettingsView, SaveAppSettingsBody, BudgetStatus } from '../shared/data'
import type { OfficeGateway } from '../providers/officeGateway'
import { officeIsolationStatus } from '../providers/isolation'
import { planOfficeConversion } from '../providers/officeGateway'
import type { SettingsStore } from '../providers/settings'
import type { WorkerHandle, WorkerHost } from '../providers/workerHost'
import { resolvePreview } from '../retrieval/openSource'
import { isInsideRoot, realpathInside, resolveInside } from '../storage/paths'
import type { AppDatabase } from '../storage/database'
import { Store, type JobRow, type VersionRow } from '../storage/store'
import { CURRENT_SCHEMA_VERSION } from '../storage/migrate'
import { AppError, isAppError } from './errors'
import { detectFormat } from './formats'
import { HandleTable } from './handles'
import { hashFile, sha256Bytes } from './hash'
import type { ParseResult, ParseTask, ProgressReport } from './parseTypes'

export interface NativeDialogs {
  pickDocuments(windowId: string): Promise<{ cancelled: boolean; files: Array<{ path: string; name: string; sizeBytes: number }> }>
  pickExecutable(windowId: string): Promise<{ cancelled: boolean; path: string | null }>
  /** 备份时选一个文件夹；取消返回 null。 */
  pickDirectory?(windowId: string, title: string): Promise<string | null>
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
  private readonly restoreTokens = new Map<string, string>()

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
      /** 备份清单里记录的应用版本；测试里可缺省。 */
      version?: () => string
      /** 恢复后重启应用；测试里可注入假函数。 */
      restart?: () => void
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
      const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
      const query = typeof source.query === 'string' ? source.query.trim().slice(0, 80) : ''
      const format = typeof source.format === 'string' && (DOCUMENT_FORMATS as readonly string[]).includes(source.format)
        ? source.format
        : null
      const rows = this.store.queryDocuments(query, format)
      const pinnedIds = new Set(this.options.settings.load().pinnedDocumentIds)
      const ordered = rows.slice().sort((a, b) => {
        const aPinned = pinnedIds.has(a.document_id)
        const bPinned = pinnedIds.has(b.document_id)
        if (aPinned !== bPinned) return aPinned ? -1 : 1
        return b.created_at.localeCompare(a.created_at) || b.document_id.localeCompare(a.document_id)
      })
      return ok(requestId, {
        total: ordered.length,
        items: ordered.slice(page.offset, page.offset + page.limit).map((row) => ({
          documentId: row.document_id,
          documentVersionId: row.document_version_id,
          displayName: row.display_name,
          format: row.format as DocumentList['items'][number]['format'],
          sizeBytes: row.size_bytes,
          status: row.status,
          createdAt: row.created_at,
          sha256: row.sha256,
          pinned: pinnedIds.has(row.document_id),
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

  search(body: unknown): Result<SearchList> {
    const requestId = randomUUID()
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ArgumentError('请求格式不正确。')
      const raw = body as Record<string, unknown>
      const query = typeof raw.query === 'string' ? raw.query.trim() : ''
      if (query.length > 200) throw new ArgumentError('搜索词最多 200 个字。')
      const limit = typeof raw.limit === 'number' && Number.isInteger(raw.limit)
        ? Math.max(1, Math.min(50, raw.limit))
        : 20
      const offset = typeof raw.offset === 'number' && Number.isInteger(raw.offset)
        ? Math.max(0, Math.min(10_000, raw.offset))
        : 0
      const ftsQuery = buildFtsQuery(query)
      if (!ftsQuery) return ok(requestId, { items: [], total: 0, query })
      const rows = this.store.searchBlocks(ftsQuery, limit, offset)
      return ok(requestId, {
        query,
        total: this.store.countSearchBlocks(ftsQuery),
        items: rows.map((row) => ({
          documentId: row.document_id,
          documentVersionId: row.document_version_id,
          displayName: row.display_name,
          format: row.format,
          pageNumber: row.page_number && row.page_number > 0 ? row.page_number : null,
          pageId: row.page_id,
          blockId: row.block_id,
          kind: row.kind,
          snippet: snippetText(row.text, query),
        })),
      })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  highlights(body: unknown): Result<HighlightList> {
    const requestId = randomUUID()
    try {
      const parsed = parseVersionBody(body)
      const version = this.store.getVersion(parsed.documentVersionId)
      if (!version) return fail(requestId, 'NOT_FOUND', '没有这份文稿。')
      return ok(requestId, {
        items: this.store.listHighlights(parsed.documentVersionId).map((row) => this.highlightView(row)),
      })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  createHighlight(body: unknown): Result<HighlightView> {
    const requestId = randomUUID()
    try {
      const input = this.highlightBody(body)
      const block = this.store.block(input.blockId)
      if (!block || block.document_version_id !== input.documentVersionId) {
        return fail(requestId, 'NOT_FOUND', '找不到要划线的这段文字。')
      }
      if (input.startOffset < 0 || input.endOffset <= input.startOffset || input.endOffset > block.text.length) {
        throw new ArgumentError('划线的范围不对，请重新选择。')
      }
      const quote = block.text.slice(input.startOffset, input.endOffset).trim()
      if (!quote) throw new ArgumentError('选中的内容是空的。')
      if (quote.length > 500) throw new ArgumentError('一次最多高亮 500 个字。')
      const row = {
        id: randomUUID(),
        document_version_id: input.documentVersionId,
        page_id: input.pageId ?? block.page_id,
        block_id: block.id,
        start_offset: input.startOffset,
        end_offset: input.endOffset,
        quote,
        color: input.color ?? 'yellow',
        created_at: nowIso(),
      }
      this.store.insertHighlight(row)
      return ok(requestId, this.highlightView(row))
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  deleteHighlight(body: unknown): Result<{ deleted: boolean }> {
    const requestId = randomUUID()
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ArgumentError('请求格式不正确。')
      const id = (body as Record<string, unknown>).id
      if (typeof id !== 'string' || !id) throw new ArgumentError('缺少高亮 id。')
      return ok(requestId, { deleted: this.store.deleteHighlight(id) })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  private highlightBody(body: unknown): HighlightCreateBody {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ArgumentError('请求格式不正确。')
    const raw = body as Record<string, unknown>
    if (typeof raw.documentVersionId !== 'string' || !raw.documentVersionId) throw new ArgumentError('缺少文稿版本。')
    if (typeof raw.blockId !== 'string' || !raw.blockId) throw new ArgumentError('缺少段落 id。')
    if (typeof raw.startOffset !== 'number' || !Number.isInteger(raw.startOffset)) throw new ArgumentError('划线起点无效。')
    if (typeof raw.endOffset !== 'number' || !Number.isInteger(raw.endOffset)) throw new ArgumentError('划线终点无效。')
    const color = typeof raw.color === 'string' && /^[a-z]{1,16}$/.test(raw.color) ? raw.color : 'yellow'
    return {
      documentVersionId: raw.documentVersionId,
      blockId: raw.blockId,
      startOffset: raw.startOffset,
      endOffset: raw.endOffset,
      pageId: typeof raw.pageId === 'string' ? raw.pageId : null,
      color,
    }
  }

  private highlightView(row: {
    id: string
    document_version_id: string
    page_id: string | null
    block_id: string
    start_offset: number
    end_offset: number
    quote: string
    color: string
    created_at: string
  }): HighlightView {
    const block = this.store.block(row.block_id)
    let valid = true
    let reason: HighlightView['reason'] = null
    if (!block || block.document_version_id !== row.document_version_id) {
      valid = false
      reason = 'block_missing'
    } else if (
      row.start_offset < 0 ||
      row.end_offset <= row.start_offset ||
      row.end_offset > block.text.length
    ) {
      valid = false
      reason = 'offset_out_of_range'
    } else if (block.text.slice(row.start_offset, row.end_offset) !== row.quote) {
      valid = false
      reason = 'quote_changed'
    }
    return {
      id: row.id,
      documentVersionId: row.document_version_id,
      pageId: row.page_id,
      blockId: row.block_id,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      quote: row.quote,
      color: row.color,
      createdAt: row.created_at,
      valid,
      reason,
    }
  }

  /** 只清理当前版本已失效的高亮；不改有效高亮，也不跨版本猜测迁移。 */
  cleanupHighlights(body: unknown): Result<{ deleted: number }> {
    const requestId = randomUUID()
    try {
      const parsed = parseVersionBody(body)
      const version = this.store.getVersion(parsed.documentVersionId)
      if (!version) return fail(requestId, 'NOT_FOUND', '没有这份文稿。')
      let deleted = 0
      for (const row of this.store.listHighlights(parsed.documentVersionId)) {
        if (!this.highlightView(row).valid && this.store.deleteHighlight(row.id)) deleted += 1
      }
      return ok(requestId, { deleted })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  rename(body: unknown): Result<{ documentId: string; displayName: string }> {
    const requestId = randomUUID()
    try {
      const parsed = parseRenameBody(body)
      const version = this.store.getVersion(parsed.documentVersionId)
      if (!version) return fail(requestId, 'NOT_FOUND', '没有这份文稿。')
      this.store.renameDocument(version.document_id, parsed.displayName)
      return ok(requestId, { documentId: version.document_id, displayName: parsed.displayName })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  pin(body: unknown): Result<{ pinned: boolean }> {
    const requestId = randomUUID()
    try {
      const parsed = parsePinBody(body)
      const version = this.store.getVersion(parsed.documentVersionId)
      if (!version) return fail(requestId, 'NOT_FOUND', '没有这份文稿。')
      const settings = this.options.settings.load()
      const pinned = new Set(settings.pinnedDocumentIds)
      if (parsed.pinned) pinned.add(version.document_id)
      else pinned.delete(version.document_id)
      this.options.settings.save({ ...settings, pinnedDocumentIds: [...pinned].slice(0, 200) })
      return ok(requestId, { pinned: parsed.pinned })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  reviewSettings(): Result<ReviewSettingsView> {
    const requestId = randomUUID()
    try {
      return ok(requestId, this.options.settings.load().review)
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  saveReviewSettings(body: unknown): Result<ReviewSettingsView> {
    const requestId = randomUUID()
    try {
      const review = parseReviewSettings(body)
      const settings = this.options.settings.load()
      this.options.settings.save({ ...settings, review })
      return ok(requestId, review)
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  stats(): Result<LibraryStats> {
    const requestId = randomUUID()
    try {
      return ok(requestId, this.store.stats())
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  storage(): Result<StorageUsage> {
    const requestId = randomUUID()
    try {
      const counts = this.store.stats()
      const databaseBytes = fileBytes(path.join(this.options.root, 'library.sqlite'))
      const originalsBytes = directoryBytes(path.join(this.options.root, 'originals'))
      const artifactsBytes = directoryBytes(path.join(this.options.root, 'artifacts'))
      return ok(requestId, {
        databaseBytes,
        originalsBytes,
        artifactsBytes,
        totalBytes: databaseBytes + originalsBytes + artifactsBytes,
        documents: counts.documents,
        pages: counts.pages,
        blocks: counts.blocks,
      })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  /** 把整库（不含 API key 与临时解析目录）复制到用户选的文件夹。 */
  async backup(windowId: string): Promise<Result<BackupResult>> {
    const requestId = randomUUID()
    try {
      const chosen = await this.options.dialogs.pickDirectory?.(windowId, '选择备份保存位置')
      if (!chosen) return fail(requestId, 'CONFLICT', '没有选择备份位置。')
      const stamp = backupStamp(new Date())
      let destination = path.join(chosen, `灯下备份-${stamp}`)
      for (let suffix = 2; fs.existsSync(destination) && suffix < 100; suffix += 1) {
        destination = path.join(chosen, `灯下备份-${stamp}-${suffix}`)
      }
      try {
        this.options.db.run('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        /* 备份仍可继续；只是 WAL 未截断。 */
      }
      return ok(requestId, await this.writeBackup(destination))
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  /** 真正写一份备份；手动备份和自动备份共用。 */
  async writeBackup(destination: string): Promise<BackupResult> {
    await fs.promises.mkdir(destination, { recursive: true })
    const databaseFile = path.join(destination, 'library.sqlite')
    this.options.db.exec(`VACUUM INTO '${databaseFile.replace(/'/g, "''")}'`)
    for (const name of ['originals', 'artifacts']) {
      const source = path.join(this.options.root, name)
      if (fs.existsSync(source)) {
        await fs.promises.cp(source, path.join(destination, name), { recursive: true })
      }
    }
    const database = await hashFile(databaseFile)
    if (!sqliteIntegrityOk(databaseFile)) {
      throw new ArgumentError('备份生成的 library.sqlite 未通过完整性检查。')
    }
    const counts = this.store.stats()
    // manifest 自身不计入 payload；恢复时用“排除 manifest”的文件数/字节数复核。
    const payload = walkDirectory(destination)
    const manifest = {
      product: '灯下',
      version: this.options.version?.() ?? 'unknown',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      createdAt: nowIso(),
      counts: {
        documents: counts.documents,
        pages: counts.pages,
        cards: counts.cards,
        manualCards: counts.manualCards,
        highlights: counts.highlights,
        misses: counts.misses,
      },
      database: {
        sha256: database.sha256,
        sizeBytes: database.sizeBytes,
        integrity: 'ok',
      },
      files: payload.files,
      bytes: payload.bytes,
      note: '备份不含 settings.json（模型 API Key 留在本机）；恢复时用应用里的「从备份恢复」。',
    }
    await fs.promises.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    const walk = walkDirectory(destination)
    return {
      path: destination,
      bytes: walk.bytes,
      files: walk.files,
      documents: counts.documents,
      pages: counts.pages,
      cards: counts.cards,
      misses: counts.misses,
    }
  }

  pickBackupDirectory(windowId: string): Promise<Result<PickBackupDirResult>> {
    const requestId = randomUUID()
    return (async () => {
      try {
        const chosen = await this.options.dialogs.pickDirectory?.(windowId, '选择自动备份文件夹')
        return ok(requestId, { path: chosen ?? null })
      } catch (error) {
        return this.asFailure(requestId, error)
      }
    })()
  }

  /** 启动时/定时调用；24 小时内只备份一次，默认关闭。 */
  async autoBackup(): Promise<Result<AutoBackupResult>> {
    const requestId = randomUUID()
    try {
      const backup = this.options.settings.load().backup
      if (!backup.enabled || !backup.directory) {
        return ok(requestId, { skipped: true, path: null, pruned: 0, reason: '自动备份未开启' })
      }
      const now = Date.now()
      if (backup.lastAt && now - Date.parse(backup.lastAt) < 24 * 60 * 60 * 1000) {
        return ok(requestId, { skipped: true, path: null, pruned: 0, reason: '距离上次自动备份不到 24 小时' })
      }
      const parent = path.join(backup.directory, '灯下自动备份')
      await fs.promises.mkdir(parent, { recursive: true })
      const stamp = backupStamp(new Date(now))
      let destination = path.join(parent, `灯下备份-${stamp}`)
      for (let suffix = 2; fs.existsSync(destination) && suffix < 100; suffix += 1) {
        destination = path.join(parent, `灯下备份-${stamp}-${suffix}`)
      }
      const result = await this.writeBackup(destination)
      const pruned = pruneAutoBackups(parent, backup.keep)
      const settings = this.options.settings.load()
      this.options.settings.save({ ...settings, backup: { ...settings.backup, lastAt: nowIso() } })
      return ok(requestId, { skipped: false, path: result.path, pruned })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  async inspectRestore(windowId: string): Promise<Result<RestorePreview>> {
    const requestId = randomUUID()
    try {
      const chosen = await this.options.dialogs.pickDirectory?.(windowId, '选择要恢复的灯下备份文件夹')
      if (!chosen) return fail(requestId, 'CONFLICT', '没有选择备份文件夹。')
      return ok(requestId, await this.readRestorePreview(chosen))
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  private async readRestorePreview(source: string): Promise<RestorePreview> {
    const manifestFile = path.join(source, 'manifest.json')
    const databaseFile = path.join(source, 'library.sqlite')
    if (!fs.existsSync(manifestFile) || !fs.existsSync(databaseFile)) {
      throw new ArgumentError('这个文件夹不像灯下备份：缺少 manifest.json 或 library.sqlite。')
    }
    let manifest: {
      product?: unknown
      version?: unknown
      createdAt?: unknown
      schemaVersion?: unknown
      counts?: Record<string, unknown>
      database?: { sha256?: unknown; sizeBytes?: unknown; integrity?: unknown }
      files?: unknown
      bytes?: unknown
    }
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as typeof manifest
    } catch {
      throw new ArgumentError('备份的 manifest.json 读不出来。')
    }
    if (manifest.product !== '灯下') throw new ArgumentError('这不是灯下生成的备份。')

    const actualDatabase = await hashFile(databaseFile)
    const manifestSha = typeof manifest.database?.sha256 === 'string' ? manifest.database.sha256 : ''
    const hasIntegrity = /^[a-f0-9]{64}$/i.test(manifestSha)
    if (hasIntegrity) {
      if (manifestSha.toLowerCase() !== actualDatabase.sha256.toLowerCase()) {
        throw new ArgumentError('备份的 library.sqlite 校验失败，可能已损坏；没有覆盖当前文库。')
      }
      if (typeof manifest.database?.sizeBytes === 'number' && manifest.database.sizeBytes !== actualDatabase.sizeBytes) {
        throw new ArgumentError('备份的 library.sqlite 大小与 manifest 不一致；没有覆盖当前文库。')
      }
      if (manifest.database?.integrity !== 'ok') {
        throw new ArgumentError('备份的 manifest 没有记录数据库完整性；没有覆盖当前文库。')
      }
    }
    if (!sqliteIntegrityOk(databaseFile)) {
      throw new ArgumentError('备份的 library.sqlite 没有通过 SQLite 完整性检查；没有覆盖当前文库。')
    }

    if (typeof manifest.files === 'number' || typeof manifest.bytes === 'number') {
      const actual = walkDirectory(source)
      const manifestBytes = fs.statSync(manifestFile).size
      const payloadFiles = Math.max(0, actual.files - 1)
      const payloadBytes = Math.max(0, actual.bytes - manifestBytes)
      if (typeof manifest.files === 'number' && manifest.files !== payloadFiles) {
        throw new ArgumentError('备份的文件数和 manifest 不一致；没有覆盖当前文库。')
      }
      if (typeof manifest.bytes === 'number' && manifest.bytes !== payloadBytes) {
        throw new ArgumentError('备份的文件大小和 manifest 不一致；没有覆盖当前文库。')
      }
    }

    const token = randomUUID()
    this.restoreTokens.set(token, source)
    if (this.restoreTokens.size > 12) this.restoreTokens.delete(this.restoreTokens.keys().next().value as string)
    const counts = manifest.counts ?? {}
    const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    return {
      token,
      sourcePath: source,
      version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
      createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
      schemaVersion: number(manifest.schemaVersion),
      verification: hasIntegrity ? 'sha256' : 'legacy',
      databaseSha256: hasIntegrity ? actualDatabase.sha256 : null,
      counts: {
        documents: number(counts.documents),
        pages: number(counts.pages),
        cards: number(counts.cards),
        misses: number(counts.misses),
        highlights: number(counts.highlights),
        manualCards: number(counts.manualCards),
      },
    }
  }

  /** 关闭库、把备份复制成 staging、再把旧库改名留作回滚。 */
  async applyRestore(body: unknown): Promise<Result<RestoreApplied>> {
    const requestId = randomUUID()
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ArgumentError('请求格式不正确。')
      const token = (body as Record<string, unknown>).token
      if (typeof token !== 'string' || !token) throw new ArgumentError('缺少恢复确认 token。')
      const source = this.restoreTokens.get(token)
      if (!source) throw new ArgumentError('恢复确认已过期，请重新选择备份。')
      const preview = await this.readRestorePreview(source)
      const staging = `${this.options.root}.restore-${token.slice(0, 8)}`
      const previous = `${this.options.root}.before-restore-${backupStamp(new Date())}`
      await fs.promises.rm(staging, { recursive: true, force: true })
      await fs.promises.cp(source, staging, { recursive: true })
      fs.rmSync(path.join(staging, 'manifest.json'), { force: true })
      const settingsFile = path.join(this.options.root, 'settings.json')
      if (fs.existsSync(settingsFile)) await fs.promises.copyFile(settingsFile, path.join(staging, 'settings.json'))

      await this.close()
      let movedOld = false
      let movedNew = false
      try {
        if (fs.existsSync(this.options.root)) {
          fs.renameSync(this.options.root, previous)
          movedOld = true
        }
        fs.renameSync(staging, this.options.root)
        movedNew = true
      } catch (error) {
        if (!movedNew && fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
        if (movedOld && !fs.existsSync(this.options.root) && fs.existsSync(previous)) fs.renameSync(previous, this.options.root)
        throw error
      }
      this.restoreTokens.delete(token)
      const restart = this.options.restart
      if (restart) setTimeout(restart, 200)
      return ok(requestId, { restored: true, sourcePath: source, previousPath: previous, counts: preview.counts })
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  appSettings(): Result<AppSettingsView> {
    const requestId = randomUUID()
    try {
      return ok(requestId, this.settingsView())
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  saveAppSettings(body: unknown): Result<AppSettingsView> {
    const requestId = randomUUID()
    try {
      const input = (body ?? {}) as SaveAppSettingsBody
      const current = this.options.settings.load()
      const backup = { ...current.backup, ...(input.backup ?? {}) }
      if (typeof backup.directory !== 'string') throw new ArgumentError('备份目录不对。')
      if (!Number.isInteger(backup.keep)) throw new ArgumentError('保留份数必须是整数。')
      backup.keep = Math.max(1, Math.min(30, backup.keep))
      if (typeof backup.enabled !== 'boolean') throw new ArgumentError('自动备份开关不对。')
      const budget = { ...current.budget, ...(input.budget ?? {}) }
      if (!Number.isInteger(budget.monthlyTokens) || budget.monthlyTokens < 0 || budget.monthlyTokens > 100_000_000) {
        throw new ArgumentError('预算必须在 0 到 1 亿 token 之间。')
      }
      if (typeof budget.hardStop !== 'boolean') throw new ArgumentError('硬拦截开关不对。')
      this.options.settings.save({ ...current, backup, budget })
      return ok(requestId, this.settingsView())
    } catch (error) {
      return this.asFailure(requestId, error)
    }
  }

  private settingsView(): AppSettingsView {
    const settings = this.options.settings.load()
    return {
      backup: settings.backup,
      budget: settings.budget,
      budgetStatus: this.budgetStatus(settings.budget.monthlyTokens, settings.budget.hardStop),
    }
  }

  private budgetStatus(limit: number, hardStop: boolean): BudgetStatus {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const used = this.store.tokensSince(monthStart.toISOString())
    const estimatedCalls = Number(
      this.options.db.get<{ total: number }>(
        `SELECT COUNT(*) AS total FROM ai_usage
         WHERE created_at >= ? AND prompt_tokens = 0 AND cached_tokens = 0 AND completion_tokens = 0`,
        monthStart.toISOString(),
      )?.total ?? 0,
    )
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0
    return {
      limit,
      used,
      remaining: limit > 0 ? Math.max(0, limit - used) : 0,
      percent,
      monthStart: monthStart.toISOString(),
      monthEnd: monthEnd.toISOString(),
      hardStop,
      exceeded: limit > 0 && used >= limit,
      warned: limit > 0 && used / limit >= 0.8,
      estimatedCalls,
      estimated: estimatedCalls > 0,
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
      const settings = this.options.settings.load()
      if (settings.pinnedDocumentIds.includes(document.id)) {
        this.options.settings.save({
          ...settings,
          pinnedDocumentIds: settings.pinnedDocumentIds.filter((id) => id !== document.id),
        })
      }
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
    const sourceHash = await hashFile(source)
    const existing = this.store.latestVersionBySha(sourceHash.sha256)
    if (existing) {
      const document = this.store.getDocument(existing.document_id)
      if (document) {
        return ok(requestId, {
          documentId: document.id,
          documentVersionId: existing.id,
          jobId: '',
          duplicate: true,
        })
      }
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
      this.store.reindexVersion(version.id)
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

function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function directoryBytes(dir: string): number {
  return walkDirectory(dir).bytes
}

function pruneAutoBackups(parent: string, keep: number): number {
  let removed = 0
  try {
    const entries = fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('灯下备份-'))
      .map((entry) => {
        const full = path.join(parent, entry.name)
        return { full, mtime: fs.statSync(full).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const entry of entries.slice(Math.max(1, keep))) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(entry.full, 'manifest.json'), 'utf8')) as { product?: unknown }
        if (manifest.product !== '灯下') continue
        if (path.dirname(entry.full) !== parent) continue
        fs.rmSync(entry.full, { recursive: true, force: true })
        removed += 1
      } catch {
        /* 不是完整的灯下备份就不动它。 */
      }
    }
  } catch {
    /* 目录读不到时不阻断备份。 */
  }
  return removed
}

function walkDirectory(rootDir: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const stack = [rootDir]
  while (stack.length) {
    const current = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        files += 1
        bytes += fileBytes(full)
      }
    }
  }
  return { bytes, files }
}

function sqliteIntegrityOk(file: string): boolean {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined
    return row?.integrity_check === 'ok'
  } catch {
    return false
  } finally {
    try {
      db?.close()
    } catch {
      /* 打不开或已关闭都不影响结论。 */
    }
  }
}

function backupStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

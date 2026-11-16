export const ERROR_CODES = [
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'UNSUPPORTED_FORMAT',
  'LIMIT_EXCEEDED',
  'FILE_UNREADABLE',
  'CONVERTER_MISSING',
  'CONVERSION_FAILED',
  'PARSE_FAILED',
  'RESOURCE_LIMIT',
  'STORAGE_ERROR',
  'NETWORK_ERROR',
  'CONFLICT',
  'AI_NOT_CONFIGURED',
  'AI_FAILED',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export type Result<T> =
  | { ok: true; requestId: string; data: T }
  | {
      ok: false
      requestId: string
      error: { code: ErrorCode; message: string; retryable: boolean }
    }

export const JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
] as const

export type JobState = (typeof JOB_STATES)[number]

export const REVIEW_STATES = ['unverified', 'needs_review', 'user_verified'] as const

export type ReviewState = (typeof REVIEW_STATES)[number]

export const DOCUMENT_FORMATS = ['pptx', 'docx', 'pdf', 'txt', 'markdown', 'png', 'jpeg'] as const

export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number]

export type BBox = [number, number, number, number]

/** pageNumber is the 1-based rendered page. It is never invented for a paragraph anchor. */
export type Locator = {
  documentVersionId: string
  pageId?: string
  pageNumber?: number
  slideNumber?: number
  paragraphAnchor?: string
  bbox?: BBox
  /** 文稿里内嵌图片的资源 ID（DOCX 的图、PPTX 的图）。读图结果按块缓存。 */
  artifactId?: string
}

export type PickFile = { handle: string; name: string; sizeBytes: number }

export type PickResult = { cancelled: boolean; files: PickFile[] }

export type ImportResult = {
  documentId: string
  documentVersionId: string
  jobId: string
  /** 同一个文件之前已经导入过：不会新建副本，直接指回已有文稿。 */
  duplicate?: boolean
}

export type DocumentListItem = {
  documentId: string
  documentVersionId: string
  displayName: string
  format: DocumentFormat
  sizeBytes: number
  status: string
  createdAt: string
  sha256: string
  job: JobSnapshot | null
  /** 是否在文稿库里置顶。 */
  pinned: boolean
}

export type DocumentList = { items: DocumentListItem[]; total: number }

/** 删除整份文稿后回给界面的凭据：documentId 用于确认删对了对象，removedVersions 是连带删掉的版本数。 */
export type DeleteDocumentResult = { documentId: string; removedVersions: number }

export type IssueView = {
  id: string
  code: string
  message: string
  reviewState: ReviewState
  pageId: string | null
  blockId: string | null
  createdAt: string
}

export type JobSnapshot = {
  jobId: string
  state: JobState
  stage: string
  completed: number
  total: number | null
  error?: { code: string; message: string }
}

export type DocumentDetail = {
  documentId: string
  documentVersionId: string
  displayName: string
  format: DocumentFormat
  sha256: string
  sizeBytes: number
  status: string
  parserVersion: string
  createdAt: string
  pageCount: number
  blockCount: number
  job: JobSnapshot | null
  warnings: IssueView[]
  sourceMetadata: Record<string, string> | null
}

export type PageView = {
  pageId: string
  ordinal: number
  sourceKind: string
  sourceNumber: number | null
  previewResourceId: string | null
  width: number | null
  height: number | null
  status: string
}

export type PageList = { items: PageView[]; total: number }

export type BlockView = {
  blockId: string
  ordinal: number
  kind: string
  text: string
  locator: Locator
  extractionMethod: string
  reviewState: ReviewState
}

export type BlockList = { items: BlockView[]; total: number }

export type OpenSourceResult = { opened: boolean }

/** 复习每日目标（存 settings.json，不动数据库）。 */
export type ReviewSettingsView = { cardsPerDay: number; missesPerDay: number; remind: boolean }

/** 本机资料占用：库文件、原文、页面图分开算，设置里显示。 */
export type StorageUsage = {
  databaseBytes: number
  originalsBytes: number
  artifactsBytes: number
  totalBytes: number
  documents: number
  pages: number
  blocks: number
}

export type LibraryStats = {
  documents: number
  pages: number
  blocks: number
  lectures: number
  cards: number
  misses: number
  sessions: number
  checks: number
  aiCalls: number
  promptTokens: number
  cachedTokens: number
  completionTokens: number
}

export type BackupResult = {
  path: string
  bytes: number
  files: number
  documents: number
  pages: number
  cards: number
  misses: number
}

/** 导出内容先回给渲染层，再由保存对话框写到磁盘，服务层不碰文件选择。 */
export type ExportPayload = { fileName: string; content: string }

export type SaveTextResult = { saved: boolean; path: string | null }

export type JobChangedEvent = {
  jobId: string
  seq: number
  state: JobState
  stage: string
  completed: number
  total: number | null
}

export type PreviewFocus = {
  documentVersionId: string
  pageId?: string
  pageNumber?: number
  blockId?: string
  paragraphAnchor?: string
  slideNumber?: number
  bbox?: BBox
}

export type Prerequisites = {
  libreOffice: {
    fileFound: boolean
    path: string | null
    version: null
    launched: false
    message: string
  }
  sandbox: {
    windowsSandboxVerified: boolean
    networkBlocked: boolean
    restrictedPermissionsVerified: boolean
    processTreeLifecycleVerified: boolean
    boundedResourcesVerified: boolean
    conversionVerified: boolean
    officeConversionWillRun: boolean
    note: string
  }
  capabilities: {
    ocr: false
    vision: false
    formulaUnderstanding: false
  }
  supportedFormats: DocumentFormat[]
  legacyRejection: string
}

export const RETRYABLE: Record<ErrorCode, boolean> = {
  INVALID_ARGUMENT: false,
  NOT_FOUND: false,
  UNSUPPORTED_FORMAT: false,
  LIMIT_EXCEEDED: false,
  FILE_UNREADABLE: true,
  CONVERTER_MISSING: true,
  CONVERSION_FAILED: true,
  PARSE_FAILED: true,
  RESOURCE_LIMIT: true,
  STORAGE_ERROR: true,
  NETWORK_ERROR: true,
  CONFLICT: false,
  AI_NOT_CONFIGURED: false,
  AI_FAILED: true,
}

export function ok<T>(requestId: string, data: T): Result<T> {
  return { ok: true, requestId, data }
}

export function fail(requestId: string, code: ErrorCode, message: string): Result<never> {
  return { ok: false, requestId, error: { code, message, retryable: RETRYABLE[code] } }
}

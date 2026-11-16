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
}

export type DocumentList = { items: DocumentListItem[]; total: number }

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

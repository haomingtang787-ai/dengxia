import type { Limits } from '../shared/constants'
import type { BBox, DocumentFormat, Locator, ReviewState } from '../shared/contract'

export type OfficePlan =
  | { mode: 'convert'; executable: string }
  | { mode: 'skip'; code: 'CONVERTER_MISSING' | 'CONVERSION_FAILED'; message: string }

export type ParseTask = {
  jobId: string
  documentVersionId: string
  format: DocumentFormat
  dataRoot: string
  originalRelpath: string
  workDir: string
  limits: Limits
  office: OfficePlan
}

export type ParsedPage = {
  ordinal: number
  sourceKind: string
  sourceNumber: number | null
  width: number | null
  height: number | null
  status: 'ready' | 'needs_review' | 'failed'
  imagePath: string | null
}

export type ParsedImage = {
  /** 已经写进工作目录的文件；主进程会在落库时复制进文库 artifacts。 */
  path: string
  mime: string
}

export type ParsedBlock = {
  ordinal: number
  pageOrdinal: number | null
  kind: 'paragraph' | 'heading' | 'code' | 'slide_text' | 'formula' | 'image_region' | 'page_text'
  text: string
  locator: Locator
  extractionMethod: 'plain-text' | 'markdown' | 'docx-xml' | 'pptx-xml' | 'pdf-text' | 'none'
  reviewState: ReviewState
  /** 块级内嵌图片。有它就说明这一块的内容主要在图里，需要 AI 读图。 */
  embeddedImage?: ParsedImage
}

export type ParsedIssue = {
  pageOrdinal: number | null
  blockOrdinal: number | null
  code: string
  message: string
  reviewState: ReviewState
}

export type ParseResult = {
  pages: ParsedPage[]
  blocks: ParsedBlock[]
  issues: ParsedIssue[]
  sourceMetadata: Record<string, string> | null
  outcome: 'succeeded' | 'partial' | 'failed'
  error?: { code: string; message: string }
}

export type ProgressReport = {
  stage: string
  completed: number
  total: number | null
}

export type ConvertResult =
  | { ok: true; pdfPath: string }
  | { ok: false; message: string }

export type ParseDeps = {
  signal?: AbortSignal
  onProgress?: (progress: ProgressReport) => void
  convertOfficeToPdf?: (executable: string, inputPath: string, outDir: string, signal: AbortSignal) => Promise<ConvertResult>
}

export type NormalizedBox = { bbox: BBox }

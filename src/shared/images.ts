export type ImageReadingKind = 'ocr' | 'vision'

export type ImageReading = {
  id: string
  documentVersionId: string
  pageId: string
  kind: ImageReadingKind
  text: string
  engine: string
  createdAt: string
}

export type ImageReadingList = { items: ImageReading[] }
export type ImageReadingResult = { reading: ImageReading }

/** DOCX 内嵌图没有页码，只能按块缓存读图结果。 */
export type BlockReading = {
  blockId: string
  text: string
  engine: string
  createdAt: string
}

export type BlockReadingResult = { reading: BlockReading }

export type AutoReadStep = 'created' | 'existing' | 'skipped' | 'failed'

/** 上传后自动跑完这一页：图片页优先 AI 读懂，AI 不可用时退回本机 OCR；文字页直接查证。 */
export type AutoReadResult = {
  pageId: string
  ocr: AutoReadStep
  vision: AutoReadStep
  research: AutoReadStep
  errors: string[]
}

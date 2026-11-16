export type HighlightView = {
  id: string
  documentVersionId: string
  pageId: string | null
  blockId: string
  startOffset: number
  endOffset: number
  quote: string
  color: string
  createdAt: string
  /** 当前版本里 block 还在、偏移没越界、原文切片仍等于 quote。 */
  valid: boolean
  reason: 'block_missing' | 'offset_out_of_range' | 'quote_changed' | null
}

export type HighlightList = { items: HighlightView[] }

export type HighlightCreateBody = {
  documentVersionId: string
  pageId?: string | null
  blockId: string
  startOffset: number
  endOffset: number
  color?: string
}

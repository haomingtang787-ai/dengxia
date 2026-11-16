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

export type ResearchSource = {
  title: string
  url: string
  snippet: string
  summary: string
  siteName: string | null
  date: string | null
  authority: number
  score: number
}

export type PageResearch = {
  id: string
  documentVersionId: string
  pageId: string
  query: string
  answer: string
  sources: ResearchSource[]
  engine: string
  createdAt: string
}

export type ResearchList = { items: PageResearch[] }
export type ResearchResult = { research: PageResearch }

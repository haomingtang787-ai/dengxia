import type { PageView } from '../../shared/contract'
import type { StudySlideCitation } from '../../shared/study'

export type EvidenceLayout = {
  cards: StudySlideCitation[]
  more: StudySlideCitation[]
}

/** 老师的一条消息最多摊开两整页；更多页收进“还有”。 */
export function evidenceLayout(citations: StudySlideCitation[]): EvidenceLayout {
  return {
    cards: citations.slice(0, 2),
    more: citations.slice(2),
  }
}

/** pageId 是强标识；页码只作为旧数据或页图重建后的回退，不能反过来覆盖 pageId。 */
export function citationPage(citation: StudySlideCitation, pages: PageView[]): PageView | null {
  return pages.find((page) => page.pageId === citation.pageId)
    ?? pages.find((page) => page.ordinal === citation.pageNumber - 1)
    ?? null
}

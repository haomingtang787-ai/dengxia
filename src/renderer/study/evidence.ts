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

/** 按页码找页；题测/总结只有页号，没有 block locator，所以不画框。 */
export function pageForPageNumber(pages: PageView[], pageNumber: number | null | undefined): PageView | null {
  if (!pageNumber || pageNumber < 1) return null
  return pages.find((page) => page.ordinal === pageNumber - 1) ?? null
}

/** 生成物里的页证据只有“回到这一页”，没有可逐字对上的 bbox。 */
export function toolCitation(pageNumber: number, quote: string, page: PageView | null): StudySlideCitation {
  return {
    pageNumber,
    pageId: page?.pageId ?? null,
    quote,
    blockId: null,
    bbox: null,
  }
}

export function bboxStyle(bbox: [number, number, number, number]): { left: string; top: string; width: string; height: string } {
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  const [x, y, width, height] = bbox.map(clamp)
  return {
    left: `${Math.round(x * 10000) / 100}%`,
    top: `${Math.round(y * 10000) / 100}%`,
    width: `${Math.round(width * 10000) / 100}%`,
    height: `${Math.round(height * 10000) / 100}%`,
  }
}

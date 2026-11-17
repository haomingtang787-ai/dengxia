import { describe, expect, it } from 'vitest'
import type { PageView } from '../src/shared/contract'
import { citationPage, evidenceLayout, pageForPageNumber, toolCitation } from '../src/renderer/study/evidence'
import type { StudySlideCitation } from '../src/shared/study'

function citation(pageNumber: number, pageId: string | null = `page-${pageNumber}`): StudySlideCitation {
  return {
    pageNumber,
    pageId,
    quote: `第 ${pageNumber} 页原句`,
    blockId: `block-${pageNumber}`,
    bbox: null,
  }
}

function page(pageId: string, ordinal: number): PageView {
  return {
    pageId,
    ordinal,
    sourceKind: 'pdf',
    sourceNumber: ordinal + 1,
    previewResourceId: `preview-${pageId}`,
    width: 1000,
    height: 1400,
    status: 'ready',
  }
}

describe('1.0.1 页证据展示', () => {
  it('每条老师消息最多展示前两张整页卡，其余进还有页', () => {
    const citations = [citation(2), citation(3), citation(4)]
    const layout = evidenceLayout(citations)
    expect(layout.cards.map((item) => item.pageNumber)).toEqual([2, 3])
    expect(layout.more.map((item) => item.pageNumber)).toEqual([4])
    expect(evidenceLayout([])).toEqual({ cards: [], more: [] })
  })

  it('先按 pageId 找页，即使页码和 ordinal 对不上也不拿错页', () => {
    const pages = [page('page-a', 0), page('page-b', 1)]
    const found = citationPage({ ...citation(2, 'page-b'), pageNumber: 9 }, pages)
    expect(found?.pageId).toBe('page-b')
    expect(found?.ordinal).toBe(1)
  })

  it('pageId 不在时按页码 ordinal 回退', () => {
    const pages = [page('page-a', 0), page('page-b', 1)]
    const found = citationPage(citation(2, 'missing-page'), pages)
    expect(found?.pageId).toBe('page-b')
  })

  it('找不到页时返回 null，不伪造页图', () => {
    expect(citationPage(citation(8, null), [page('page-a', 0)])).toBeNull()
  })

  it('生成物按页号找页；没有页号的原文不伪造页码', () => {
    const pages = [page('page-a', 0), page('page-b', 1)]
    expect(pageForPageNumber(pages, 2)?.pageId).toBe('page-b')
    expect(pageForPageNumber(pages, null)).toBeNull()
    expect(pageForPageNumber(pages, 0)).toBeNull()
  })

  it('生成物页证据没有 bbox，绝不画假框', () => {
    const pages = [page('page-b', 1)]
    const generated = toolCitation(2, 'SRAM 用触发器存储一位。', pageForPageNumber(pages, 2))
    expect(generated.pageNumber).toBe(2)
    expect(generated.pageId).toBe('page-b')
    expect(generated.bbox).toBeNull()
    expect(generated.blockId).toBeNull()
  })
})

import type { Locator, PreviewFocus } from '../shared/contract'
import { parseLocator } from '../domain/validation'

export type LocatorRow = { id: string; page_id: string | null; locator_json: string }
export type PageRef = { id: string; document_version_id: string; ordinal: number }

export function resolvePreview(locator: Locator, blocks: LocatorRow[], pages: PageRef[]): PreviewFocus | null {
  if (locator.paragraphAnchor || locator.slideNumber) {
    const block = blocks.find((item) => matchesBlock(locator, item))
    if (!block) return null
    let stored: Locator
    try {
      stored = parseLocator(JSON.parse(block.locator_json) as unknown)
    } catch {
      return null
    }
    if (locator.pageNumber && stored.pageNumber && locator.pageNumber !== stored.pageNumber) return null
    if (locator.pageId && stored.pageId && locator.pageId !== stored.pageId) return null
    return {
      documentVersionId: locator.documentVersionId,
      blockId: block.id,
      ...(stored.paragraphAnchor ? { paragraphAnchor: stored.paragraphAnchor } : {}),
      ...(stored.slideNumber ? { slideNumber: stored.slideNumber } : {}),
      ...(stored.pageId ? { pageId: stored.pageId } : {}),
      ...(stored.pageNumber ? { pageNumber: stored.pageNumber } : {}),
      ...(stored.bbox ? { bbox: stored.bbox } : {}),
    }
  }
  if (locator.pageId) {
    const page = pages.find((item) => item.id === locator.pageId && item.document_version_id === locator.documentVersionId)
    if (!page) return null
    return { documentVersionId: locator.documentVersionId, pageId: page.id, pageNumber: page.ordinal }
  }
  if (locator.pageNumber) {
    const page = pages.find((item) => item.ordinal === locator.pageNumber && item.document_version_id === locator.documentVersionId)
    if (!page) return null
    return { documentVersionId: locator.documentVersionId, pageId: page.id, pageNumber: page.ordinal }
  }
  return null
}

function matchesBlock(locator: Locator, row: LocatorRow): boolean {
  try {
    const stored = parseLocator(JSON.parse(row.locator_json) as unknown)
    if (stored.documentVersionId !== locator.documentVersionId) return false
    if (locator.paragraphAnchor) return stored.paragraphAnchor === locator.paragraphAnchor
    if (locator.slideNumber) return stored.slideNumber === locator.slideNumber && !locator.paragraphAnchor
    return false
  } catch {
    return false
  }
}

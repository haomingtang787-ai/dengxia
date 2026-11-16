import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../shared/constants'
import type { BBox, Locator } from '../shared/contract'
import { isParagraphAnchor, isUuid } from './ids'

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgumentError'
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ArgumentError(`${label} 必须是整数`)
  }
  return value
}

export function parsePagination(input: unknown): { offset: number; limit: number } {
  const source = input === undefined ? {} : input
  if (!isPlainObject(source)) throw new ArgumentError('分页参数必须是对象')
  const offset = optionalInteger(source.offset, 0, 'offset')
  const limit = optionalInteger(source.limit, DEFAULT_PAGE_LIMIT, 'limit')
  if (offset < 0 || offset > 1_000_000) throw new ArgumentError('offset 超出允许范围')
  if (limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ArgumentError(`limit 必须在 1 和 ${MAX_PAGE_LIMIT} 之间`)
  }
  return { offset, limit }
}

export function parseBlocksQuery(input: unknown):
  | { kind: 'page'; pageId: string; offset: number; limit: number }
  | { kind: 'unpaged'; documentVersionId: string; offset: number; limit: number } {
  if (!isPlainObject(input)) throw new ArgumentError('blocks 参数必须是对象')
  const page = parsePagination(input)
  const hasPage = input.pageId !== undefined && input.pageId !== null
  const unpaged = input.scope === 'unpaged'
  if (hasPage && unpaged) throw new ArgumentError('不能同时按页面和无页文本查询')
  if (hasPage) {
    if (!isUuid(input.pageId)) throw new ArgumentError('pageId 不是有效标识')
    return { kind: 'page', pageId: String(input.pageId).toLowerCase(), ...page }
  }
  if (unpaged) {
    if (!isUuid(input.documentVersionId)) throw new ArgumentError('documentVersionId 不是有效标识')
    return {
      kind: 'unpaged',
      documentVersionId: String(input.documentVersionId).toLowerCase(),
      ...page,
    }
  }
  throw new ArgumentError('查询文本块时需要 pageId，或使用 scope "unpaged" 与 documentVersionId')
}

function parseBBox(value: unknown): BBox {
  if (!Array.isArray(value) || value.length !== 4) throw new ArgumentError('bbox 必须是四个数字')
  const nums = value.map((item) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) throw new ArgumentError('bbox 含有无效数字')
    return item
  })
  const [x, y, w, h] = nums as [number, number, number, number]
  if (x < -0.02 || y < -0.02 || w <= 0 || h <= 0 || x + w > 1.05 || y + h > 1.05) {
    throw new ArgumentError('bbox 必须是从左上角归一化的矩形')
  }
  return [x, y, w, h]
}

export function parseLocator(input: unknown): Locator {
  if (!isPlainObject(input)) throw new ArgumentError('locator 必须是对象')
  if (!isUuid(input.documentVersionId)) throw new ArgumentError('documentVersionId 不是有效标识')
  const locator: Locator = { documentVersionId: String(input.documentVersionId).toLowerCase() }
  if (input.pageId !== undefined) {
    if (!isUuid(input.pageId)) throw new ArgumentError('pageId 不是有效标识')
    locator.pageId = String(input.pageId).toLowerCase()
  }
  if (input.pageNumber !== undefined) {
    if (typeof input.pageNumber !== 'number' || !Number.isInteger(input.pageNumber) || input.pageNumber < 1) {
      throw new ArgumentError('pageNumber 必须是从 1 开始的整数')
    }
    locator.pageNumber = input.pageNumber
  }
  if (input.slideNumber !== undefined) {
    if (typeof input.slideNumber !== 'number' || !Number.isInteger(input.slideNumber) || input.slideNumber < 1) {
      throw new ArgumentError('slideNumber 必须是从 1 开始的整数')
    }
    locator.slideNumber = input.slideNumber
  }
  if (input.paragraphAnchor !== undefined) {
    if (!isParagraphAnchor(input.paragraphAnchor)) throw new ArgumentError('paragraphAnchor 无效')
    locator.paragraphAnchor = input.paragraphAnchor
  }
  if (input.bbox !== undefined) locator.bbox = parseBBox(input.bbox)
  if (!locator.pageId && !locator.pageNumber && !locator.slideNumber && !locator.paragraphAnchor) {
    throw new ArgumentError('locator 至少要包含页面、幻灯片或段落锚点')
  }
  return locator
}

export function parseImportBody(input: unknown): { handle: string; requestId: string } {
  if (!isPlainObject(input)) throw new ArgumentError('import 参数必须是对象')
  if (!isUuid(input.handle)) throw new ArgumentError('handle 无效')
  if (!isUuid(input.requestId)) throw new ArgumentError('requestId 必须是 UUID')
  return {
    handle: String(input.handle).toLowerCase(),
    requestId: String(input.requestId).toLowerCase(),
  }
}

export function parseRetryBody(input: unknown): { jobId: string; requestId: string } {
  if (!isPlainObject(input)) throw new ArgumentError('retry 参数必须是对象')
  if (!isUuid(input.jobId)) throw new ArgumentError('jobId 无效')
  if (!isUuid(input.requestId)) throw new ArgumentError('requestId 必须是 UUID')
  return { jobId: String(input.jobId).toLowerCase(), requestId: String(input.requestId).toLowerCase() }
}

export function parseJobIdBody(input: unknown): string {
  if (!isPlainObject(input) || !isUuid(input.jobId)) throw new ArgumentError('jobId 无效')
  return String(input.jobId).toLowerCase()
}

export function parseVersionBody(input: unknown): { documentVersionId: string; offset: number; limit: number } {
  if (!isPlainObject(input) || !isUuid(input.documentVersionId)) {
    throw new ArgumentError('documentVersionId 无效')
  }
  const page = parsePagination(input)
  return { documentVersionId: String(input.documentVersionId).toLowerCase(), ...page }
}

export function parseRenameBody(input: unknown): { documentVersionId: string; displayName: string } {
  if (!isPlainObject(input) || !isUuid(input.documentVersionId)) {
    throw new ArgumentError('documentVersionId 无效')
  }
  if (typeof input.displayName !== 'string') throw new ArgumentError('文稿名必须是文字')
  const displayName = input.displayName.trim().replace(/\s+/g, ' ')
  if (!displayName) throw new ArgumentError('文稿名不能为空')
  if (displayName.length > 120) throw new ArgumentError('文稿名最多 120 个字')
  return { documentVersionId: String(input.documentVersionId).toLowerCase(), displayName }
}

export function parsePinBody(input: unknown): { documentVersionId: string; pinned: boolean } {
  if (!isPlainObject(input) || !isUuid(input.documentVersionId)) {
    throw new ArgumentError('documentVersionId 无效')
  }
  if (typeof input.pinned !== 'boolean') throw new ArgumentError('pinned 必须是布尔值')
  return { documentVersionId: String(input.documentVersionId).toLowerCase(), pinned: input.pinned }
}

export function parseReviewSettings(input: unknown): { cardsPerDay: number; missesPerDay: number; remind: boolean } {
  if (!isPlainObject(input)) throw new ArgumentError('复习设置必须是对象')
  const cardsPerDay = optionalInteger(input.cardsPerDay, 10, '每日卡片')
  const missesPerDay = optionalInteger(input.missesPerDay, 5, '每日错题')
  if (cardsPerDay < 1 || cardsPerDay > 200) throw new ArgumentError('每日卡片要在 1 到 200 之间')
  if (missesPerDay < 0 || missesPerDay > 100) throw new ArgumentError('每日错题要在 0 到 100 之间')
  if (typeof input.remind !== 'boolean') throw new ArgumentError('remind 必须是布尔值')
  return { cardsPerDay, missesPerDay, remind: input.remind }
}

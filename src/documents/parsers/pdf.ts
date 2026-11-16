import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { MESSAGES, type Limits } from '../../shared/constants'
import type { BBox } from '../../shared/contract'
import { clipText } from '../../shared/text'
import { AppError } from '../errors'
import type { ParsedBlock, ParsedIssue, ParsedPage, ProgressReport } from '../parseTypes'

type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
type GlyphSource = {
  str: string
  transform: number[]
  width: number
  height: number
  fontName: string
  hasEOL: boolean
}

let pdfjsPromise: Promise<Pdfjs> | null = null

function slashDir(fileInDir: string): string {
  // pdf.js validates these factory URLs itself: they must end with a forward
  // slash. A Windows path keeps its backslashes and `path.sep` is `\`, so the
  // old check produced `C:\...\cmaps\` and getDocument threw
  // "must include trailing slash" before reading a single page.
  const dir = path.dirname(fileInDir).replace(/\\/g, '/')
  return dir.endsWith('/') ? dir : `${dir}/`
}

function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const require = createRequire(import.meta.url)
    const worker = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(worker).href
    return pdfjs
  })()
  return pdfjsPromise
}

function ownedBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

export async function parsePdfFile(input: {
  filePath: string
  documentVersionId: string
  workDir: string
  limits: Limits
  sourceKind: string
  signal?: AbortSignal
  onProgress?: (progress: ProgressReport) => void
}): Promise<{
  pages: ParsedPage[]
  blocks: ParsedBlock[]
  issues: ParsedIssue[]
  sourceMetadata: Record<string, string> | null
}> {
  const pdfjs = await loadPdfjs()
  const require = createRequire(import.meta.url)
  const cMapUrl = slashDir(require.resolve('pdfjs-dist/cmaps/78-EUC-H.bcmap'))
  const standardFontDataUrl = slashDir(require.resolve('pdfjs-dist/standard_fonts/FoxitFixed.pfb'))
  const raw = fs.readFileSync(input.filePath)
  if (!raw.subarray(0, 4).equals(Buffer.from('%PDF'))) {
    throw new AppError('PARSE_FAILED', '转换结果或 PDF 文件不是以 %PDF 开头。')
  }
  const task = pdfjs.getDocument({
    data: ownedBytes(raw),
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    verbosity: 0,
    disableWorkerRendering: true,
    isOffscreenCanvasSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    maxImageSize: input.limits.maxImagePixels,
    enableXfa: false,
    useWasm: false,
    stopAtErrors: false,
    isEvalSupported: false,
  } as Parameters<Pdfjs['getDocument']>[0])
  try {
    const doc = await task.promise
    if (doc.numPages > input.limits.maxPages) {
      throw new AppError('LIMIT_EXCEEDED', `PDF 有 ${doc.numPages} 页，超过 ${input.limits.maxPages} 页的上限。`)
    }
    const issues: ParsedIssue[] = []
    const pages: ParsedPage[] = []
    const blocks: ParsedBlock[] = []
    let linkNoted = false
    const metadata = await safeMetadata(doc)
    const actions = await doc.getJSActions().catch(() => null)
    if (actions && typeof actions === 'object' && sizeOf(actions) > 0) {
      issues.push({
        pageOrdinal: null,
        blockOrdinal: null,
        code: 'SCRIPT_IGNORED',
        message: MESSAGES.scripts,
        reviewState: 'needs_review',
      })
    }
    for (let number = 1; number <= doc.numPages; number += 1) {
      if (input.signal?.aborted) throw new AppError('PARSE_FAILED', '处理已取消。')
      input.onProgress?.({ stage: 'extract', completed: number - 1, total: doc.numPages })
      const page = await doc.getPage(number)
      const viewport = page.getViewport({ scale: 1 })
      const textContent = await page.getTextContent()
      const styles = textContent.styles ?? {}
      const items = textContent.items.flatMap((item) => ('str' in item && typeof item.str === 'string' ? [item] : []))
      const grouped = groupText(items, styles, viewport.width, viewport.height)
      let pageNeedsReview = false
      let imageCount = 0
      try {
        const ops = await page.getOperatorList()
        const imageIds = imageOperatorIds(pdfjs.OPS)
        imageCount = ops.fnArray.filter((fn) => imageIds.has(fn)).length
      } catch {
        pageNeedsReview = true
        issues.push({
          pageOrdinal: number,
          blockOrdinal: null,
          code: 'NO_OCR',
          message: '未能确认这一页是否含有未识别图像。没有把它当成已读懂。',
          reviewState: 'needs_review',
        })
      }
      if (imageCount > 0) {
        pageNeedsReview = true
        issues.push({
          pageOrdinal: number,
          blockOrdinal: null,
          code: 'NO_OCR',
          message: MESSAGES.pdfImage,
          reviewState: 'needs_review',
        })
      }
      try {
        const annotations = await page.getAnnotations({ intent: 'display' })
        const links = annotations.filter((annotation) => {
          const record = annotation as { subtype?: string; url?: string; unsafeUrl?: string }
          return record.subtype === 'Link' && Boolean(record.url || record.unsafeUrl)
        })
        if (links.length && !linkNoted) {
          linkNoted = true
          issues.push({
            pageOrdinal: number,
            blockOrdinal: null,
            code: 'LINKS_IGNORED',
            message: MESSAGES.links,
            reviewState: 'needs_review',
          })
        }
      } catch {
        pageNeedsReview = true
      }
      for (const group of grouped) {
        if (blocks.length >= input.limits.maxBlocks) {
          throw new AppError('LIMIT_EXCEEDED', 'PDF 文本块数量超过上限。')
        }
        const clipped = clipText(group.text, input.limits.maxBlockChars)
        const ordinal = blocks.length + 1
        const math = group.math
        if (math) {
          issues.push({
            pageOrdinal: number,
            blockOrdinal: ordinal,
            code: 'FORMULA_UNVERIFIED',
            message: MESSAGES.formulaGlyph,
            reviewState: 'needs_review',
          })
          pageNeedsReview = true
        }
        blocks.push({
          ordinal,
          pageOrdinal: number,
          kind: 'page_text',
          text: clipped.text,
          locator: {
            documentVersionId: input.documentVersionId,
            pageNumber: number,
            paragraphAnchor: `pdf-p${String(number).padStart(3, '0')}-b${String(group.index).padStart(3, '0')}`,
            ...(group.bbox ? { bbox: group.bbox } : {}),
          },
          extractionMethod: 'pdf-text',
          reviewState: math || clipped.clipped ? 'needs_review' : 'unverified',
        })
      }
      // 扫描件、图册、公式截图页几乎没有文字层。给这一页单独记一个图像块，
      // 授课阶段才会对页图跑视觉读图；否则这类页会以「没解析出文字」空着进课堂。
      const visibleChars = grouped.reduce((total, group) => total + group.text.trim().length, 0)
      if (imageCount > 0 && visibleChars < 400) {
        if (blocks.length >= input.limits.maxBlocks) {
          throw new AppError('LIMIT_EXCEEDED', 'PDF 文本块数量超过上限。')
        }
        blocks.push({
          ordinal: blocks.length + 1,
          pageOrdinal: number,
          kind: 'image_region',
          text: '',
          locator: {
            documentVersionId: input.documentVersionId,
            pageNumber: number,
            paragraphAnchor: `pdf-p${String(number).padStart(3, '0')}-img`,
          },
          extractionMethod: 'pdf-text',
          reviewState: 'unverified',
        })
      }
      const imagePath = await renderPage(page as unknown as RenderablePage, viewport.width, viewport.height, number, input.workDir, input.limits)
      if (!imagePath) {
        pageNeedsReview = true
        issues.push({
          pageOrdinal: number,
          blockOrdinal: null,
          code: 'PARSE_FAILED',
          message: '这一页的预览图没有生成。文字层如果存在，仍单独保留。',
          reviewState: 'needs_review',
        })
      }
      pages.push({
        ordinal: number,
        sourceKind: input.sourceKind,
        sourceNumber: number,
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
        status: pageNeedsReview ? 'needs_review' : 'ready',
        imagePath,
      })
      input.onProgress?.({ stage: 'render', completed: number, total: doc.numPages })
    }
    return { pages, blocks, issues, sourceMetadata: metadata }
  } catch (error) {
    if (error instanceof AppError) throw error
    const name = error instanceof Error ? error.name : ''
    if (name === 'PasswordException') {
      throw new AppError('FILE_UNREADABLE', '这份 PDF 有密码。本阶段不能解密，也不会尝试绕过密码。')
    }
    throw new AppError('PARSE_FAILED', 'PDF 无法解析。')
  } finally {
    await task.destroy()
  }
}

function sizeOf(value: object): number {
  if (value instanceof Map) return value.size
  return Object.keys(value).length
}

async function safeMetadata(doc: {
  getMetadata: () => Promise<{ info?: object }>
}): Promise<Record<string, string> | null> {
  try {
    const meta = await doc.getMetadata()
    const info = (meta.info ?? {}) as Record<string, unknown>
    const allow = ['Title', 'Author', 'Subject', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Language']
    const out: Record<string, string> = {}
    for (const key of allow) {
      const value = info[key]
      if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, 500)
    }
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}

function imageOperatorIds(ops: Record<string, number>): Set<number> {
  const names = ['paintImageXObject', 'paintImageXObjectRepeat', 'paintImageMaskXObject', 'paintInlineImageXObject']
  const ids = new Set<number>()
  for (const name of names) {
    const value = ops[name]
    if (typeof value === 'number') ids.add(value)
  }
  return ids
}

type Glyph = {
  str: string
  x: number
  y: number
  w: number
  h: number
  baseline: number
  math: boolean
  eol: boolean
}

function groupText(
  items: GlyphSource[],
  styles: Record<string, { fontFamily?: string }>,
  pageWidth: number,
  pageHeight: number,
): Array<{ index: number; text: string; bbox?: BBox; math: boolean }> {
  const glyphs: Glyph[] = []
  for (const item of items) {
    if (!item.str) continue
    const x = Number(item.transform[4])
    const baseline = Number(item.transform[5])
    const w = Number(item.width)
    const h = Number(item.height) || Math.abs(Number(item.transform[3])) || 0
    if (![x, baseline, w, h].every(Number.isFinite) || h < 0) continue
    const family = styles[item.fontName]?.fontFamily ?? ''
    glyphs.push({
      str: item.str,
      x,
      y: pageHeight - baseline - h,
      w,
      h,
      baseline,
      eol: Boolean(item.hasEOL),
      math: /math|cmsy|cmmi|symbol|mt[- ]?extra/i.test(family),
    })
  }
  glyphs.sort((a, b) => b.baseline - a.baseline || a.x - b.x)
  const lines: Glyph[][] = []
  for (const glyph of glyphs) {
    const line = lines[lines.length - 1]
    const previous = line?.[line.length - 1]
    if (!previous || previous.eol || Math.abs(previous.baseline - glyph.baseline) > Math.max(2, previous.h * 0.45)) {
      lines.push([glyph])
    } else {
      line.push(glyph)
    }
  }
  const lineBoxes = lines.map((line) => {
    line.sort((a, b) => a.x - b.x)
    let text = ''
    let previousRight = 0
    for (const glyph of line) {
      if (text && glyph.x - previousRight > Math.max(1.2, glyph.h * 0.15)) text += ' '
      text += glyph.str
      previousRight = glyph.x + glyph.w
    }
    const x = Math.min(...line.map((glyph) => glyph.x))
    const y = Math.min(...line.map((glyph) => glyph.y))
    const right = Math.max(...line.map((glyph) => glyph.x + glyph.w))
    const bottom = Math.max(...line.map((glyph) => glyph.y + glyph.h))
    return { text: text.trim(), x, y, w: right - x, h: bottom - y, math: line.some((glyph) => glyph.math) }
  }).filter((line) => line.text)
  const blocks: Array<typeof lineBoxes> = []
  for (const line of lineBoxes) {
    const current = blocks[blocks.length - 1]
    const previous = current?.[current.length - 1]
    const gap = previous ? line.y - (previous.y + previous.h) : 0
    if (!previous || gap > Math.max(previous.h, line.h) * 0.85) blocks.push([line])
    else current.push(line)
  }
  return blocks.map((linesInBlock, index) => {
    const text = linesInBlock.map((line) => line.text).join('\n')
    const x = Math.min(...linesInBlock.map((line) => line.x))
    const y = Math.min(...linesInBlock.map((line) => line.y))
    const right = Math.max(...linesInBlock.map((line) => line.x + line.w))
    const bottom = Math.max(...linesInBlock.map((line) => line.y + line.h))
    return {
      index: index + 1,
      text,
      math: linesInBlock.some((line) => line.math),
      bbox: normalize(x, y, right - x, bottom - y, pageWidth, pageHeight),
    }
  })
}

function normalize(x: number, y: number, w: number, h: number, pageWidth: number, pageHeight: number): BBox | undefined {
  if (![x, y, w, h, pageWidth, pageHeight].every(Number.isFinite)) return undefined
  if (pageWidth <= 0 || pageHeight <= 0 || w <= 0 || h <= 0) return undefined
  const nx = x / pageWidth
  const ny = y / pageHeight
  const nw = w / pageWidth
  const nh = h / pageHeight
  if (nx < -0.25 || ny < -0.25 || nx > 1.25 || ny > 1.25) return undefined
  const left = clamp(nx, 0, 0.999)
  const top = clamp(ny, 0, 0.999)
  const right = clamp(nx + nw, left + 0.001, 1)
  const bottom = clamp(ny + nh, top + 0.001, 1)
  const round = (value: number) => Math.round(value * 10000) / 10000
  return [round(left), round(top), round(right - left), round(bottom - top)]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

type RenderablePage = {
  render: (params: { canvas: unknown; viewport: { width: number; height: number } }) => { promise: Promise<void> }
  getViewport: (params: { scale: number }) => { width: number; height: number }
}

async function renderPage(
  page: RenderablePage,
  width: number,
  height: number,
  number: number,
  workDir: string,
  limits: Limits,
): Promise<string | null> {
  try {
    const { createCanvas } = await import('@napi-rs/canvas')
    const pixels = width * height
    const scale = Math.min(2, 1400 / Math.max(width, height), Math.sqrt(limits.maxImagePixels / Math.max(pixels, 1)))
    if (!Number.isFinite(scale) || scale <= 0) return null
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)))
    await page.render({ canvas, viewport }).promise
    const png = canvas.toBuffer('image/png')
    const imagePath = path.join(workDir, `page-${String(number).padStart(4, '0')}.png`)
    fs.writeFileSync(imagePath, png)
    return imagePath
  } catch {
    return null
  }
}

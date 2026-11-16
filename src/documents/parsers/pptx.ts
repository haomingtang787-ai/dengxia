import { XMLParser } from 'fast-xml-parser'
import { MESSAGES, type Limits } from '../../shared/constants'
import type { BBox } from '../../shared/contract'
import { clipText } from '../../shared/text'
import { AppError } from '../errors'
import type { ParsedBlock, ParsedIssue, ParsedPage } from '../parseTypes'
import { listZipEntries, readZipEntry } from '../zip'
import { readCoreProps } from './docx'
import { asTree, hasDescendant, localName, textOf, walk, type XmlNode } from '../xmlTree'

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false })

function attrNumber(node: XmlNode | undefined, key: string): number | null {
  if (!node) return null
  const raw = node.attrs[`@_${key}`] ?? node.attrs[key]
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function first(nodes: XmlNode[], name: string): XmlNode | undefined {
  for (const node of nodes) {
    if (localName(node.name) === name) return node
    const nested = first(node.children, name)
    if (nested) return nested
  }
  return undefined
}

type ShapeText = {
  index: number
  text: string
  x: number | null
  y: number | null
  cx: number | null
  cy: number | null
}

function collectShapes(nodes: XmlNode[], out: ShapeText[], insideGroup: boolean, counter: { n: number }): void {
  for (const node of nodes) {
    const name = localName(node.name)
    if (name === 'sp') {
      counter.n += 1
      const text = textOf(node, new Set(['del'])).replace(/[ \t]+\n/g, '\n').trim()
      const off = insideGroup ? undefined : first(node.children, 'off')
      const ext = insideGroup ? undefined : first(node.children, 'ext')
      if (text) {
        out.push({
          index: counter.n,
          text,
          x: attrNumber(off, 'x'),
          y: attrNumber(off, 'y'),
          cx: attrNumber(ext, 'cx'),
          cy: attrNumber(ext, 'cy'),
        })
      }
      continue
    }
    if (node.children.length) collectShapes(node.children, out, insideGroup || name === 'grpSp', counter)
  }
}

function slideBox(shape: ShapeText, width: number | null, height: number | null): BBox | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined
  if (shape.x === null || shape.y === null || shape.cx === null || shape.cy === null) return undefined
  if (shape.cx <= 0 || shape.cy <= 0) return undefined
  const x = shape.x / width
  const y = shape.y / height
  const w = shape.cx / width
  const h = shape.cy / height
  if (x < -0.02 || y < -0.02 || w <= 0 || h <= 0 || x + w > 1.05 || y + h > 1.05) return undefined
  const round = (n: number) => Math.round(n * 10000) / 10000
  return [round(Math.max(0, x)), round(Math.max(0, y)), round(w), round(h)]
}

/** 表格的文字不在 p:sp 里，走 collectShapes 会整块丢掉，所以单独按行列取。 */
function collectTables(nodes: XmlNode[], out: string[][]): void {
  for (const node of nodes) {
    if (localName(node.name) === 'tbl') {
      const rows: string[] = []
      const visitRows = (list: XmlNode[]) => {
        for (const row of list) {
          if (localName(row.name) === 'tr') {
            const cells: string[] = []
            const visitCells = (items: XmlNode[]) => {
              for (const cell of items) {
                if (localName(cell.name) === 'tc') {
                  const text = textOf(cell, new Set(['del'])).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim()
                  cells.push(text)
                } else if (cell.children.length) visitCells(cell.children)
              }
            }
            visitCells(row.children)
            if (cells.some(Boolean)) rows.push(cells.join(' | '))
          } else if (row.children.length) visitRows(row.children)
        }
      }
      visitRows(node.children)
      if (rows.length) out.push(rows)
      continue
    }
    if (node.children.length) collectTables(node.children, out)
  }
}

function placeholderType(shape: XmlNode): string {
  let found = ''
  walk([shape], (node) => {
    if (found) return
    if (localName(node.name) === 'ph') {
      found = node.attrs['@_type'] ?? node.attrs['type'] ?? ''
    }
  })
  return found
}

/** 备注页里除了老师写的话，还有幻灯片缩略图和页码占位符；只取真正写下来的文字。 */
function notesText(bytes: Uint8Array, entries: ReturnType<typeof listZipEntries>, slideNumber: number, limits: Limits): string {
  const relName = `ppt/slides/_rels/slide${slideNumber}.xml.rels`
  let target = ''
  const relEntry = entries.find((entry) => entry.name === relName)
  if (relEntry) {
    const relTree = asTree(parser.parse(new TextDecoder('utf-8', { fatal: false }).decode(readZipEntry(bytes, relEntry, limits))))
    walk(relTree, (node) => {
      if (target) return
      if (localName(node.name) !== 'Relationship') return
      const type = node.attrs['@_Type'] ?? node.attrs['Type'] ?? ''
      const path = node.attrs['@_Target'] ?? node.attrs['Target'] ?? ''
      if (type.endsWith('/notesSlide') && path) target = path.replace(/\\/g, '/')
    })
  }
  const fallback = `ppt/notesSlides/notesSlide${slideNumber}.xml`
  const entryName = target
    ? target.replace(/^\.\.\//, 'ppt/').replace(/^\.\//, 'ppt/slides/')
    : fallback
  const entry = entries.find((item) => item.name === entryName)
  if (!entry) return ''
  const tree = asTree(parser.parse(new TextDecoder('utf-8', { fatal: false }).decode(readZipEntry(bytes, entry, limits))))
  const lines: string[] = []
  walk(tree, (node) => {
    if (localName(node.name) !== 'sp') return
    const type = placeholderType(node)
    if (type === 'sldImg' || type === 'sldNum' || type === 'hdr' || type === 'ftr' || type === 'dt') return
    const text = textOf(node, new Set(['del'])).replace(/[ \t]+\n/g, '\n').trim()
    if (text) lines.push(text)
  })
  return lines
    .filter((line) => !/^\d{1,3}$/.test(line))
    .join('\n')
    .trim()
}


export function parsePptxXml(
  bytes: Uint8Array,
  documentVersionId: string,
  limits: Limits,
): { blocks: ParsedBlock[]; pages: ParsedPage[]; issues: ParsedIssue[]; sourceMetadata: Record<string, string> | null } {
  const entries = listZipEntries(bytes, limits)
  const presentation = entries.find((entry) => entry.name === 'ppt/presentation.xml')
  if (!presentation) throw new AppError('PARSE_FAILED', 'PPTX 里没有 ppt/presentation.xml。')
  const slides = entries
    .map((entry) => {
      const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.name)
      return match ? { entry, number: Number(match[1]) } : null
    })
    .filter((item): item is { entry: (typeof entries)[number]; number: number } => item !== null)
    .sort((a, b) => a.number - b.number)
  if (!slides.length) throw new AppError('PARSE_FAILED', 'PPTX 里没有幻灯片。')
  if (slides.length > limits.maxPages) throw new AppError('LIMIT_EXCEEDED', '幻灯片数量超过上限。')
  const presentationXml = readZipEntry(bytes, presentation, limits)
  const presentationTree = asTree(parser.parse(new TextDecoder('utf-8', { fatal: false }).decode(presentationXml)))
  const sizeNode = first(presentationTree, 'sldSz')
  const slideWidth = attrNumber(sizeNode, 'cx')
  const slideHeight = attrNumber(sizeNode, 'cy')
  const blocks: ParsedBlock[] = []
  const pages: ParsedPage[] = slides.map((slide, index) => ({
    ordinal: index + 1,
    sourceKind: 'slide',
    sourceNumber: slide.number,
    width: slideWidth,
    height: slideHeight,
    status: 'ready',
    imagePath: null,
  }))
  const issues: ParsedIssue[] = []
  let imageNoted = false
  for (let index = 0; index < slides.length; index += 1) {
    const slide = slides[index]!
    const pageOrdinal = index + 1
    const xml = readZipEntry(bytes, slide.entry, limits)
    const tree = asTree(parser.parse(new TextDecoder('utf-8', { fatal: false }).decode(xml)))
    const slideHasImage = tree.some((node) => hasDescendant(node, 'pic') || localName(node.name) === 'pic')
    if (slideHasImage) {
      if (blocks.length >= limits.maxBlocks) throw new AppError('LIMIT_EXCEEDED', '幻灯片文本块数量超过上限。')
      blocks.push({
        ordinal: blocks.length + 1,
        pageOrdinal,
        kind: 'image_region',
        text: '',
        locator: {
          documentVersionId,
          slideNumber: slide.number,
          pageNumber: pageOrdinal,
          paragraphAnchor: `pptx-s${String(slide.number).padStart(3, '0')}-image`,
        },
        extractionMethod: 'pptx-xml',
        reviewState: 'needs_review',
      })
      if (!imageNoted) {
        imageNoted = true
        issues.push({
          pageOrdinal,
          blockOrdinal: null,
          code: 'NO_OCR',
          message: `幻灯片含有图片。${MESSAGES.noOcr}`,
          reviewState: 'needs_review',
        })
      }
    }
    const shapes: ShapeText[] = []
    collectShapes(tree, shapes, false, { n: 0 })
    const ordered = [...shapes].sort((a, b) => {
      if (a.y !== null && b.y !== null && a.y !== b.y) return a.y - b.y
      if (a.x !== null && b.x !== null && a.x !== b.x) return a.x - b.x
      return a.index - b.index
    })
    for (const shape of ordered) {
      if (blocks.length >= limits.maxBlocks) throw new AppError('LIMIT_EXCEEDED', '幻灯片文本块数量超过上限。')
      const clipped = clipText(shape.text, limits.maxBlockChars)
      const bbox = slideBox(shape, slideWidth, slideHeight)
      const ordinal = blocks.length + 1
      blocks.push({
        ordinal,
        pageOrdinal,
        kind: 'slide_text',
        text: clipped.text,
        locator: {
          documentVersionId,
          slideNumber: slide.number,
          pageNumber: pageOrdinal,
          paragraphAnchor: `pptx-s${String(slide.number).padStart(3, '0')}-sh${String(shape.index).padStart(3, '0')}`,
          ...(bbox ? { bbox } : {}),
        },
        extractionMethod: 'pptx-xml',
        reviewState: clipped.clipped ? 'needs_review' : 'unverified',
      })
    }
    const tables: string[][] = []
    collectTables(tree, tables)
    tables.forEach((rows, tableIndex) => {
      if (blocks.length >= limits.maxBlocks) throw new AppError('LIMIT_EXCEEDED', '幻灯片文本块数量超过上限。')
      const clipped = clipText(rows.join('\n'), limits.maxBlockChars)
      blocks.push({
        ordinal: blocks.length + 1,
        pageOrdinal,
        kind: 'slide_text',
        text: clipped.text,
        locator: {
          documentVersionId,
          slideNumber: slide.number,
          pageNumber: pageOrdinal,
          paragraphAnchor: `pptx-s${String(slide.number).padStart(3, '0')}-tbl${String(tableIndex + 1).padStart(2, '0')}`,
        },
        extractionMethod: 'pptx-xml',
        reviewState: clipped.clipped ? 'needs_review' : 'unverified',
      })
    })
    const notes = notesText(bytes, entries, slide.number, limits)
    if (notes) {
      if (blocks.length >= limits.maxBlocks) throw new AppError('LIMIT_EXCEEDED', '幻灯片文本块数量超过上限。')
      const clipped = clipText(notes, limits.maxBlockChars)
      blocks.push({
        ordinal: blocks.length + 1,
        pageOrdinal,
        kind: 'paragraph',
        text: clipped.text,
        locator: {
          documentVersionId,
          slideNumber: slide.number,
          pageNumber: pageOrdinal,
          paragraphAnchor: `pptx-s${String(slide.number).padStart(3, '0')}-notes`,
        },
        extractionMethod: 'pptx-xml',
        reviewState: 'unverified',
      })
    }
  }
  if (entries.some((entry) => entry.name.startsWith('ppt/notesSlides/'))) {
    issues.push({
      pageOrdinal: null,
      blockOrdinal: null,
      code: 'NOTES_READ',
      message: MESSAGES.notesRead,
      reviewState: 'unverified',
    })
  }
  if (!blocks.length) {
    issues.push({
      pageOrdinal: null,
      blockOrdinal: null,
      code: 'NO_OCR',
      message: '幻灯片没有可提取的文字。如果内容在图片里，可以打开页面用「识别这一页文字」或「让模型看懂这一页」。',
      reviewState: 'needs_review',
    })
  }
  const core = entries.find((entry) => entry.name === 'docProps/core.xml')
  const sourceMetadata = core ? readCoreProps(readZipEntry(bytes, core, limits)) : null
  return { blocks, pages, issues, sourceMetadata }
}

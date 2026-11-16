import { XMLParser } from 'fast-xml-parser'
import fs from 'node:fs'
import path from 'node:path'
import { MESSAGES, type Limits } from '../../shared/constants'
import { clipText } from '../../shared/text'
import { AppError } from '../errors'
import type { ParsedBlock, ParsedImage, ParsedIssue } from '../parseTypes'
import { listZipEntries, readZipEntry, readZipFiles } from '../zip'
import { asTree, hasDescendant, localName, textOf, walk, type XmlNode } from '../xmlTree'

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false })

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/** 小于这个体积的多半是图标、分隔线、项目符号，送进视觉模型只会浪费调用。 */
const MIN_IMAGE_BYTES = 8 * 1024
const MAX_EMBEDDED_IMAGES = 40

type DocxNode = { type: 'p' | 'tbl'; node: XmlNode }

/** 按文档顺序收集段落与表格。表格整块收走，表格里的单元格段落不再单独成段，否则表格会散成一堆孤立句子。 */
function collectNodes(nodes: XmlNode[], out: DocxNode[]): void {
  for (const node of nodes) {
    const name = localName(node.name)
    if (name === 'del') continue
    if (name === 'p') out.push({ type: 'p', node })
    else if (name === 'tbl') out.push({ type: 'tbl', node })
    else if (node.children.length) collectNodes(node.children, out)
  }
}

/** 表格按行取文字：一行一条，单元格用 | 分隔，单元格内的换行压成空格。 */
function tableRows(table: XmlNode): string[] {
  const rows: string[] = []
  const visitRows = (nodes: XmlNode[]) => {
    for (const node of nodes) {
      if (localName(node.name) === 'tr') {
        const cells: string[] = []
        const visitCells = (items: XmlNode[]) => {
          for (const cell of items) {
            if (localName(cell.name) === 'tc') {
              const text = textOf(cell, new Set(['del'])).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim()
              cells.push(text)
            } else if (cell.children.length) visitCells(cell.children)
          }
        }
        visitCells(node.children)
        if (cells.some(Boolean)) rows.push(cells.join(' | '))
      } else if (node.children.length) visitRows(node.children)
    }
  }
  visitRows(table.children)
  return rows
}

function imageRelIds(paragraph: XmlNode): string[] {
  const ids: string[] = []
  walk([paragraph], (node) => {
    if (localName(node.name) !== 'blip') return
    const id = node.attrs['@_r:embed'] ?? node.attrs['r:embed'] ?? node.attrs['@_embed'] ?? ''
    if (id && !ids.includes(id)) ids.push(id)
  })
  return ids
}

function parseRels(bytes: Uint8Array | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!bytes) return out
  const tree = asTree(parser.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes)))
  walk(tree, (node) => {
    if (localName(node.name) !== 'Relationship') return
    const id = node.attrs['@_Id'] ?? node.attrs['Id'] ?? ''
    const target = node.attrs['@_Target'] ?? node.attrs['Target'] ?? ''
    if (id && target) out.set(id, target)
  })
  return out
}

function mediaEntryName(target: string): string | null {
  const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.includes('://')) return null
  return normalized.startsWith('/') ? normalized.slice(1) : `word/${normalized}`
}

export type DocxParseResult = {
  blocks: ParsedBlock[]
  issues: ParsedIssue[]
  sourceMetadata: Record<string, string> | null
}

/**
 * DOCX 没有页，图片也不在文字里。这里把每个 drawing 的内嵌图片单独做成
 * image_region 块，并把图片写进工作目录，交给主进程落成 artifact、
 * 再由 AI 私教按块读图。读不出来的图仍然只标「需复核」，不假装读懂。
 */
export function parseDocxXml(
  bytes: Uint8Array,
  documentVersionId: string,
  limits: Limits,
  workDir?: string,
): DocxParseResult {
  const entries = listZipEntries(bytes, limits)
  const names = new Set(entries.map((entry) => entry.name))
  if (!names.has('word/document.xml')) {
    throw new AppError('PARSE_FAILED', 'DOCX 里没有 word/document.xml。')
  }
  const wanted = new Set(['word/document.xml', 'docProps/core.xml', 'word/_rels/document.xml.rels'])
  const files = readZipFiles(bytes, wanted, limits)
  const documentXml = files.get('word/document.xml')
  if (!documentXml) throw new AppError('PARSE_FAILED', '无法读取 DOCX 正文。')
  const tree = asTree(parser.parse(new TextDecoder('utf-8', { fatal: false }).decode(documentXml)))
  const nodes: DocxNode[] = []
  collectNodes(tree, nodes)
  const rels = parseRels(files.get('word/_rels/document.xml.rels'))
  const blocks: ParsedBlock[] = []
  const issues: ParsedIssue[] = []
  let formulaNoted = false
  let imageNoted = false
  let imagesWritten = 0
  const mediaCache = new Map<string, ParsedImage | null>()

  const takeImage = (relId: string): ParsedImage | null => {
    if (mediaCache.has(relId)) return mediaCache.get(relId) ?? null
    const cache = (value: ParsedImage | null): ParsedImage | null => {
      mediaCache.set(relId, value)
      return value
    }
    if (!workDir || imagesWritten >= MAX_EMBEDDED_IMAGES) return cache(null)
    const target = rels.get(relId)
    if (!target) return cache(null)
    const entryName = mediaEntryName(target)
    if (!entryName) return cache(null)
    const ext = path.extname(entryName).slice(1).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (!mime) return cache(null)
    const entry = entries.find((item) => item.name === entryName)
    if (!entry || entry.uncompressedSize < MIN_IMAGE_BYTES) return cache(null)
    try {
      const body = readZipEntry(bytes, entry, limits)
      const dir = path.join(workDir, 'embedded')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `docx-${String(imagesWritten + 1).padStart(3, '0')}.${ext}`)
      fs.writeFileSync(file, body)
      imagesWritten += 1
      return cache({ path: file, mime })
    } catch {
      return cache(null)
    }
  }

  let paragraphIndex = 0
  let tableIndex = 0
  for (const entry of nodes) {
    if (entry.type === 'tbl') {
      const rows = tableRows(entry.node)
      if (!rows.length) continue
      if (blocks.length >= limits.maxBlocks) throw new AppError('LIMIT_EXCEEDED', 'DOCX 文本块数量超过上限。')
      tableIndex += 1
      const clipped = clipText(rows.join('\n'), limits.maxBlockChars)
      blocks.push({
        ordinal: blocks.length + 1,
        pageOrdinal: null,
        kind: 'paragraph',
        text: clipped.text,
        locator: { documentVersionId, paragraphAnchor: `docx-tbl-${String(tableIndex).padStart(4, '0')}` },
        extractionMethod: 'docx-xml',
        reviewState: clipped.clipped ? 'needs_review' : 'unverified',
      })
      imageRelIds(entry.node)
        .map(takeImage)
        .filter((item): item is ParsedImage => item !== null)
        .forEach((image, imageIndex) => {
          if (blocks.length >= limits.maxBlocks) throw new AppError('LIMIT_EXCEEDED', 'DOCX 文本块数量超过上限。')
          blocks.push({
            ordinal: blocks.length + 1,
            pageOrdinal: null,
            kind: 'image_region',
            text: '',
            locator: { documentVersionId, paragraphAnchor: `docx-tbl-${String(tableIndex).padStart(4, '0')}-img${imageIndex + 1}` },
            extractionMethod: 'docx-xml',
            reviewState: 'unverified',
            embeddedImage: image,
          })
        })
      continue
    }
    const paragraph = entry.node
    paragraphIndex += 1
    const anchor = `docx-p-${String(paragraphIndex).padStart(4, '0')}`
    const formula = hasDescendant(paragraph, 'oMath') || hasDescendant(paragraph, 'oMathPara')
    const drawing = ['drawing', 'pict', 'object'].some((name) => hasDescendant(paragraph, name))
    const plain = textOf(paragraph, new Set(['del', 'oMath', 'oMathPara'])).replace(/[ \t]+\n/g, '\n').trim()
    const mathText = formula ? textOf(paragraph, new Set(['del'])).replace(plain, '').replace(/[ \t]+\n/g, '\n').trim() : ''
    const visible = [plain, mathText].filter(Boolean).join(plain && mathText ? '\n' : '')
    const images = imageRelIds(paragraph).map(takeImage).filter((item): item is ParsedImage => item !== null)
    if (!visible && !formula && !drawing) continue
    if (visible || formula) {
      if (blocks.length >= limits.maxBlocks) throw new AppError('LIMIT_EXCEEDED', 'DOCX 文本块数量超过上限。')
      const clipped = clipText(visible || (formula ? '（公式，未解释）' : ''), limits.maxBlockChars)
      const ordinal = blocks.length + 1
      const review = formula || clipped.clipped ? 'needs_review' : 'unverified'
      blocks.push({
        ordinal,
        pageOrdinal: null,
        kind: formula && !plain ? 'formula' : 'paragraph',
        text: clipped.text,
        locator: { documentVersionId, paragraphAnchor: anchor },
        extractionMethod: 'docx-xml',
        reviewState: review,
      })
      if (formula && !formulaNoted) {
        formulaNoted = true
        issues.push({
          pageOrdinal: null,
          blockOrdinal: ordinal,
          code: 'FORMULA_UNVERIFIED',
          message: MESSAGES.formula,
          reviewState: 'needs_review',
        })
      }
    }
    images.forEach((image, imageIndex) => {
      if (blocks.length >= limits.maxBlocks) throw new AppError('LIMIT_EXCEEDED', 'DOCX 文本块数量超过上限。')
      blocks.push({
        ordinal: blocks.length + 1,
        pageOrdinal: null,
        kind: 'image_region',
        text: '',
        locator: { documentVersionId, paragraphAnchor: `${anchor}-img${imageIndex + 1}` },
        extractionMethod: 'docx-xml',
        reviewState: 'unverified',
        embeddedImage: image,
      })
    })
    if (drawing && images.length === 0 && !imageNoted) {
      imageNoted = true
      issues.push({
        pageOrdinal: null,
        blockOrdinal: blocks.length || null,
        code: 'NO_OCR',
        message: MESSAGES.docxImage,
        reviewState: 'needs_review',
      })
    }
  }
  if (!blocks.length) throw new AppError('PARSE_FAILED', 'DOCX 正文里没有可提取的段落。')
  let sourceMetadata: Record<string, string> | null = null
  const core = files.get('docProps/core.xml')
  if (core) sourceMetadata = readCoreProps(core)
  return { blocks, issues, sourceMetadata }
}

export function readCoreProps(bytes: Uint8Array): Record<string, string> | null {
  const tree = asTree(parser.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes)))
  const wanted = new Map<string, string>([
    ['title', 'Title'],
    ['creator', 'Creator'],
    ['subject', 'Subject'],
    ['lastModifiedBy', 'LastModifiedBy'],
  ])
  const out: Record<string, string> = {}
  const visit = (nodes: XmlNode[]) => {
    for (const node of nodes) {
      const key = wanted.get(localName(node.name))
      if (key && out[key] === undefined) {
        const text = textOf(node).trim().slice(0, 500)
        if (text) out[key] = text
      }
      if (node.children.length) visit(node.children)
    }
  }
  visit(tree)
  return Object.keys(out).length ? out : null
}

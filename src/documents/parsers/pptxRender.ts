import { createCanvas, loadImage } from '@napi-rs/canvas'
import { XMLParser } from 'fast-xml-parser'
import fs from 'node:fs'
import path from 'node:path'
import type { BBox } from '../../shared/contract'
import type { Limits } from '../../shared/constants'
import type { ParsedIssue, ParsedPage } from '../parseTypes'
import { listZipEntries, readZipEntry, type ZipEntry } from '../zip'
import { asTree, localName, textOf, walk, type XmlNode } from '../xmlTree'

/**
 * Renders each slide from its own XML into a white-background PNG. This is the
 * fallback that does not depend on LibreOffice running inside AppContainer:
 * text boxes and embedded pictures are drawn at their real positions, so the
 * vision model receives the actual slide content instead of a text-only stub.
 */

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false })

type TextShape = {
  text: string
  x: number | null
  y: number | null
  cx: number | null
  cy: number | null
}

type PictureShape = {
  media: string
  x: number | null
  y: number | null
  cx: number | null
  cy: number | null
}

function attrNumber(node: XmlNode | undefined, key: string): number | null {
  if (!node) return null
  const raw = node.attrs[`@_${key}`] ?? node.attrs[key]
  if (raw === undefined) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function attr(node: XmlNode | undefined, key: string): string {
  if (!node) return ''
  return (
    node.attrs[`@_${key}`] ??
    node.attrs[key] ??
    node.attrs[`@_r:${key}`] ??
    node.attrs[`r:${key}`] ??
    ''
  )
}

function first(nodes: XmlNode[], name: string): XmlNode | undefined {
  for (const node of nodes) {
    if (localName(node.name) === name) return node
    const nested = first(node.children, name)
    if (nested) return nested
  }
  return undefined
}

function shapeText(node: XmlNode): string {
  const body = first(node.children, 'txBody')
  if (!body) return textOf(node, new Set(['del'])).replace(/[ \t]+\n/g, '\n').trim()
  const paragraphs: string[] = []
  for (const child of body.children) {
    if (localName(child.name) !== 'p') continue
    const text = textOf(child, new Set(['del'])).replace(/[ \t]+\n/g, '\n').trim()
    if (text) paragraphs.push(text)
  }
  return paragraphs.join('\n').trim()
}

function collectText(nodes: XmlNode[], out: TextShape[], insideGroup: boolean): void {
  for (const node of nodes) {
    const name = localName(node.name)
    if (name === 'sp') {
      const text = shapeText(node)
      if (text) {
        const off = insideGroup ? undefined : first(node.children, 'off')
        const ext = insideGroup ? undefined : first(node.children, 'ext')
        out.push({
          text,
          x: attrNumber(off, 'x'),
          y: attrNumber(off, 'y'),
          cx: attrNumber(ext, 'cx'),
          cy: attrNumber(ext, 'cy'),
        })
      }
      continue
    }
    if (node.children.length) collectText(node.children, out, insideGroup || name === 'grpSp')
  }
}

function collectPictures(nodes: XmlNode[], out: PictureShape[]): void {
  for (const node of nodes) {
    const name = localName(node.name)
    if (name === 'pic') {
      const blip = first(node.children, 'blip')
      const embed = attr(blip, 'embed')
      const spPr = first(node.children, 'spPr')
      const off = spPr ? first(spPr.children, 'off') : undefined
      const ext = spPr ? first(spPr.children, 'ext') : undefined
      if (embed) {
        out.push({
          media: embed,
          x: attrNumber(off, 'x'),
          y: attrNumber(off, 'y'),
          cx: attrNumber(ext, 'cx'),
          cy: attrNumber(ext, 'cy'),
        })
      }
      continue
    }
    if (node.children.length) collectPictures(node.children, out)
  }
}

function relTargets(xml: Uint8Array | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!xml) return out
  const tree = asTree(parser.parse(new TextDecoder('utf-8', { fatal: false }).decode(xml)))
  walk(tree, (node) => {
    if (localName(node.name) !== 'Relationship') return
    const id = node.attrs.Id ?? node.attrs['@_Id'] ?? ''
    const target = node.attrs.Target ?? node.attrs['@_Target'] ?? ''
    if (id && target) out.set(id, target)
  })
  return out
}

function resolveMedia(target: string): string {
  const normalized = target.replace(/\\/g, '/').replace(/^\//, '')
  if (normalized.startsWith('ppt/')) return normalized
  return path.posix.normalize(path.posix.join('ppt/slides', normalized))
}

function normalizeBox(shape: { x: number | null; y: number | null; cx: number | null; cy: number | null }, width: number, height: number): BBox | null {
  if (shape.x === null || shape.y === null || shape.cx === null || shape.cy === null) return null
  if (shape.cx <= 0 || shape.cy <= 0) return null
  const x = shape.x / width
  const y = shape.y / height
  const w = shape.cx / width
  const h = shape.cy / height
  if (x < -0.1 || y < -0.1 || w <= 0 || h <= 0 || x + w > 1.1 || y + h > 1.1) return null
  return [Math.max(0, x), Math.max(0, y), Math.min(1 - Math.max(0, x), w), Math.min(1 - Math.max(0, y), h)]
}

function wrapLines(measure: (text: string) => number, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) continue
    let line = ''
    for (const char of Array.from(paragraph)) {
      const next = line + char
      if (line && measure(next) > maxWidth) {
        lines.push(line)
        line = char.trimStart()
      } else {
        line = next
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

type DrawContext = {
  fillStyle: string
  font: string
  textBaseline: string
  fillRect: (x: number, y: number, width: number, height: number) => void
  fillText: (text: string, x: number, y: number) => void
  measureText: (text: string) => { width: number }
}

function paintText(
  context: DrawContext,
  shape: TextShape,
  slideWidth: number,
  slideHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const box = normalizeBox(shape, slideWidth, slideHeight)
  if (!box) return
  const x = box[0] * canvasWidth
  const y = box[1] * canvasHeight
  const maxWidth = Math.max(1, box[2] * canvasWidth)
  const maxHeight = Math.max(1, box[3] * canvasHeight)
  const base = Math.max(11, Math.min(40, Math.round(maxHeight / 3)))
  let font = base
  let lines: string[] = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    context.font = `${font}px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`
    lines = wrapLines((text) => context.measureText(text).width, shape.text, maxWidth)
    if (lines.length * font * 1.22 <= maxHeight || font <= 11) break
    font = Math.max(11, font - 3)
  }
  context.fillStyle = '#111827'
  context.textBaseline = 'top'
  let cursor = y
  for (const line of lines) {
    if (cursor + font * 1.22 > y + maxHeight + 2) break
    context.fillText(line, x, cursor)
    cursor += font * 1.22
  }
}

export async function renderPptxSlides(input: {
  bytes: Uint8Array
  pages: ParsedPage[]
  workDir: string
  limits: Limits
  onProgress?: (progress: { stage: string; completed: number; total: number | null }) => void
}): Promise<{ pages: ParsedPage[]; issues: ParsedIssue[] }> {
  const entries = listZipEntries(input.bytes, input.limits)
  const presentation = entries.find((entry) => entry.name === 'ppt/presentation.xml')
  if (!presentation) return { pages: input.pages, issues: [] }
  const presentationTree = asTree(parser.parse(new TextDecoder('utf-8', { fatal: false }).decode(readZipEntry(input.bytes, presentation, input.limits))))
  const sizeNode = first(presentationTree, 'sldSz')
  const slideWidth = attrNumber(sizeNode, 'cx') ?? 10_000_000
  const slideHeight = attrNumber(sizeNode, 'cy') ?? 5_625_000
  const targetWidth = 1280
  const targetHeight = Math.max(1, Math.round(targetWidth * (slideHeight / Math.max(1, slideWidth))))
  const outDir = path.join(input.workDir, 'pptx-pages')
  fs.mkdirSync(outDir, { recursive: true })
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const pages: ParsedPage[] = input.pages.map((page) => ({ ...page }))
  const issues: ParsedIssue[] = []

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!
    const slideNumber = page.sourceNumber ?? index + 1
    const slideEntry = byName.get(`ppt/slides/slide${slideNumber}.xml`)
    if (!slideEntry) {
      page.status = 'needs_review'
      issues.push({
        pageOrdinal: page.ordinal,
        blockOrdinal: null,
        code: 'PPTX_RENDER_FAILED',
        message: `第 ${page.ordinal} 页找不到对应的幻灯片 XML。`,
        reviewState: 'needs_review',
      })
      continue
    }
    try {
      const slideTree = asTree(parser.parse(new TextDecoder('utf-8', { fatal: false }).decode(readZipEntry(input.bytes, slideEntry, input.limits))))
      const canvas = createCanvas(targetWidth, targetHeight)
      const context = canvas.getContext('2d') as unknown as DrawContext & {
        drawImage: (source: unknown, x: number, y: number, width: number, height: number) => void
      }
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, targetWidth, targetHeight)
      const relEntry = byName.get(`ppt/slides/_rels/slide${slideNumber}.xml.rels`)
      const rels = relTargets(relEntry ? readZipEntry(input.bytes, relEntry, input.limits) : null)
      const pictures: PictureShape[] = []
      collectPictures(slideTree, pictures)
      for (const picture of pictures) {
        const media = rels.get(picture.media)
        if (!media) continue
        const mediaEntry = byName.get(resolveMedia(media)) as ZipEntry | undefined
        if (!mediaEntry) continue
        const box = normalizeBox(picture, slideWidth, slideHeight)
        if (!box) continue
        try {
          const image = await loadImage(Buffer.from(readZipEntry(input.bytes, mediaEntry, input.limits)))
          context.drawImage(image, box[0] * targetWidth, box[1] * targetHeight, box[2] * targetWidth, box[3] * targetHeight)
        } catch {
          // A corrupt or unsupported image must not blank the rest of the slide.
        }
      }
      const shapes: TextShape[] = []
      collectText(slideTree, shapes, false)
      for (const shape of shapes) paintText(context, shape, slideWidth, slideHeight, targetWidth, targetHeight)
      const imagePath = path.join(outDir, `slide-${String(page.ordinal).padStart(3, '0')}.png`)
      fs.writeFileSync(imagePath, canvas.toBuffer('image/png'))
      page.imagePath = imagePath
      page.width = targetWidth
      page.height = targetHeight
      page.status = 'ready'
    } catch (error) {
      page.status = 'needs_review'
      issues.push({
        pageOrdinal: page.ordinal,
        blockOrdinal: null,
        code: 'PPTX_RENDER_FAILED',
        message: `第 ${page.ordinal} 页渲染失败：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}`,
        reviewState: 'needs_review',
      })
    }
    input.onProgress?.({ stage: 'render', completed: index + 1, total: pages.length })
  }
  return { pages, issues }
}

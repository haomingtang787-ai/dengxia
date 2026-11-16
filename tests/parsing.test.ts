import { createCanvas } from '@napi-rs/canvas'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeDocx, makePdf, makePptx, SAMPLE_MD, SAMPLE_TXT } from './helpers/builders'
import { createHarness, writeTemp } from './helpers/app'

describe('parsing', () => {
  it('gives stable paragraph anchors to text and markdown, including page-less blocks', async () => {
    const app = await createHarness()
    const text = await app.importFile(writeTemp('reading.txt', SAMPLE_TXT))
    const markdown = await app.importFile(writeTemp('outline.md', SAMPLE_MD))
    expect(text.ok && markdown.ok).toBe(true)
    if (!text.ok || !markdown.ok) return
    await app.service.settle()
    const textBlocks = app.service.blocks({ documentVersionId: text.data.documentVersionId, scope: 'unpaged' })
    expect(textBlocks.ok).toBe(true)
    if (textBlocks.ok) {
      expect(textBlocks.data.items.map((item) => item.locator.paragraphAnchor)).toEqual(['txt-p-0001', 'txt-p-0002', 'txt-p-0003'])
      expect(textBlocks.data.items[1]?.text).toContain('仍属同一段')
      expect(textBlocks.data.items.every((item) => item.locator.pageNumber === undefined)).toBe(true)
    }
    const textPages = app.service.pages({ documentVersionId: text.data.documentVersionId })
    expect(textPages.ok && textPages.data.total).toBe(0)
    const mdBlocks = app.service.blocks({ documentVersionId: markdown.data.documentVersionId, scope: 'unpaged' })
    expect(mdBlocks.ok).toBe(true)
    if (mdBlocks.ok) {
      expect(mdBlocks.data.items[0]?.kind).toBe('heading')
      expect(mdBlocks.data.items.some((item) => item.text.includes('https://example.com'))).toBe(true)
      expect(mdBlocks.data.items.some((item) => item.text.includes('<script>'))).toBe(true)
    }
    const detail = app.service.get({ documentVersionId: markdown.data.documentVersionId })
    expect(detail.ok && detail.data.warnings.some((warning) => warning.code === 'HTML_NOT_EXECUTED')).toBe(true)
    const opened = app.service.openSource('window-a', {
      documentVersionId: text.data.documentVersionId,
      paragraphAnchor: 'txt-p-0002',
    })
    expect(opened.ok && opened.data.opened).toBe(true)
    expect(app.focuses.at(-1)?.paragraphAnchor).toBe('txt-p-0002')
    expect(app.focuses.at(-1)?.pageNumber).toBeUndefined()
    await app.cleanup()
  })

  it('keeps docx paragraph anchors off rendered pages and flags the formula', async () => {
    const app = await createHarness()
    const imported = await app.importFile(writeTemp('lesson.docx', makeDocx()))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    await app.service.settle()
    const blocks = app.service.blocks({ documentVersionId: imported.data.documentVersionId, scope: 'unpaged' })
    expect(blocks.ok).toBe(true)
    if (!blocks.ok) return
    expect(blocks.data.items.map((item) => [item.locator.paragraphAnchor, item.text])).toEqual([
      ['docx-p-0001', '第一段：课程导入。'],
      ['docx-p-0002', '第二段：例题说明。'],
      ['docx-p-0003', 'x+1'],
    ])
    expect(blocks.data.items[2]?.kind).toBe('formula')
    expect(blocks.data.items[2]?.reviewState).toBe('needs_review')
    expect(blocks.data.items.every((item) => item.locator.pageNumber === undefined && item.locator.pageId === undefined)).toBe(true)
    const detail = app.service.get({ documentVersionId: imported.data.documentVersionId })
    expect(detail.ok && detail.data.sourceMetadata?.Title).toBe('一次函数讲义')
    expect(detail.ok && detail.data.warnings.some((warning) => warning.code === 'FORMULA_UNVERIFIED')).toBe(true)
    await app.cleanup()
  })

  it('keeps every pptx slide as its own page and attaches text to that slide', async () => {
    const app = await createHarness()
    const imported = await app.importFile(writeTemp('slides.pptx', makePptx()))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    await app.service.settle()
    const pages = app.service.pages({ documentVersionId: imported.data.documentVersionId })
    expect(pages.ok && pages.data.total).toBe(2)
    if (!pages.ok) return
    expect(pages.data.items.map((page) => page.sourceKind)).toEqual(['slide', 'slide'])
    expect(pages.data.items.every((page) => Boolean(page.previewResourceId))).toBe(true)
    const firstPageId = pages.data.items[0]!.pageId
    const blocks = app.service.blocks({ pageId: firstPageId })
    expect(blocks.ok).toBe(true)
    if (!blocks.ok) return
    const first = blocks.data.items.find((item) => item.text === '一次函数')
    expect(first?.locator.slideNumber).toBe(1)
    expect(first?.locator.pageNumber).toBe(1)
    expect(first?.locator.bbox).toEqual([0, 0, 0.5, 0.2])
    const secondPage = app.service.blocks({ pageId: pages.data.items[1]!.pageId })
    expect(secondPage.ok).toBe(true)
    if (!secondPage.ok) return
    const second = secondPage.data.items.find((item) => item.text === '练习')
    expect(second?.locator.slideNumber).toBe(2)
    expect(second?.locator.pageNumber).toBe(2)
    expect(second?.locator.bbox).toEqual([0.25, 0.4, 0.5, 0.2])
    const detail = app.service.get({ documentVersionId: imported.data.documentVersionId })
    expect(detail.ok && detail.data.warnings.some((warning) => warning.code === 'NOTES_READ')).toBe(true)
    await app.cleanup()
  })

  it('marks a slide that contains a picture so the visual reader can run', async () => {
    const app = await createHarness()
    const imported = await app.importFile(writeTemp('slides-image.pptx', makePptx({ withImage: true })))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    await app.service.settle()
    const pages = app.service.pages({ documentVersionId: imported.data.documentVersionId })
    expect(pages.ok && pages.data.total).toBe(2)
    if (!pages.ok) return
    const first = app.service.blocks({ pageId: pages.data.items[0]!.pageId })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data.items.some((item) => item.kind === 'image_region')).toBe(true)
    const detail = app.service.get({ documentVersionId: imported.data.documentVersionId })
    expect(detail.ok && detail.data.warnings.some((warning) => warning.code === 'NO_OCR')).toBe(true)
    await app.cleanup()
  })

  it('extracts PDF text with a top-of-page box and renders a preview', async () => {
    const app = await createHarness()
    const imported = await app.importFile(writeTemp('hello.pdf', makePdf(['BT /F1 24 Tf 72 720 Td (Hello PDF) Tj ET'])))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    await app.service.settle()
    const pages = app.service.pages({ documentVersionId: imported.data.documentVersionId })
    expect(pages.ok && pages.data.total).toBe(1)
    if (!pages.ok) return
    const blocks = app.service.blocks({ pageId: pages.data.items[0]!.pageId })
    expect(blocks.ok).toBe(true)
    if (!blocks.ok) return
    expect(blocks.data.items.some((item) => item.text.includes('Hello PDF'))).toBe(true)
    const box = blocks.data.items.find((item) => item.text.includes('Hello PDF'))?.locator.bbox
    expect(box).toBeTruthy()
    if (box) expect(box[1]).toBeLessThan(0.2)
    expect(pages.data.items[0]?.previewResourceId).toBeTruthy()
    await app.cleanup()
  })

  it('keeps a picture as an unreadable preview', async () => {
    const canvas = createCanvas(12, 8)
    const context = canvas.getContext('2d')
    context.fillStyle = '#4263EB'
    context.fillRect(0, 0, 12, 8)
    const png = canvas.toBuffer('image/png')
    const jpeg = canvas.toBuffer('image/jpeg')
    const fixtureDir = path.resolve('tests/fixtures')
    fs.mkdirSync(fixtureDir, { recursive: true })
    fs.writeFileSync(path.join(fixtureDir, 'sample.txt'), SAMPLE_TXT)
    fs.writeFileSync(path.join(fixtureDir, 'sample.md'), SAMPLE_MD)
    fs.writeFileSync(path.join(fixtureDir, 'sample.docx'), makeDocx())
    fs.writeFileSync(path.join(fixtureDir, 'sample.pptx'), makePptx())
    fs.writeFileSync(path.join(fixtureDir, 'sample.pdf'), makePdf(['BT /F1 24 Tf 72 720 Td (Hello PDF) Tj ET']))
    fs.writeFileSync(path.join(fixtureDir, 'sample.png'), png)
    fs.writeFileSync(path.join(fixtureDir, 'sample.jpg'), jpeg)
    fs.writeFileSync(path.join(fixtureDir, 'expected-locations.json'), JSON.stringify({
      'sample.txt': ['txt-p-0001', 'txt-p-0002', 'txt-p-0003'],
      'sample.docx': ['docx-p-0001', 'docx-p-0002', 'docx-p-0003'],
      'sample.pptx': [
        { anchor: 'pptx-s001-sh001', slideNumber: 1, bbox: [0, 0, 0.5, 0.2], text: '一次函数' },
        { anchor: 'pptx-s002-sh001', slideNumber: 2, bbox: [0.25, 0.4, 0.5, 0.2], text: '练习' },
      ],
      'sample.pdf': { text: 'Hello PDF', pageNumber: 1 },
    }, null, 2))
    const app = await createHarness()
    const imported = await app.importFile(writeTemp('board.png', png))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    await app.service.settle()
    const job = app.service.job({ jobId: imported.data.jobId })
    expect(job.ok && job.data.state).toBe('partial')
    const detail = app.service.get({ documentVersionId: imported.data.documentVersionId })
    expect(detail.ok && detail.data.warnings.some((warning) => warning.code === 'NO_OCR')).toBe(true)
    const pages = app.service.pages({ documentVersionId: imported.data.documentVersionId })
    expect(pages.ok && pages.data.items[0]?.width).toBe(12)
    expect(pages.ok && pages.data.items[0]?.height).toBe(8)
    const blocks = pages.ok ? app.service.blocks({ pageId: pages.data.items[0]!.pageId }) : null
    expect(blocks?.ok && blocks.data.items[0]?.text.includes('AI 读懂')).toBe(true)
    expect(blocks?.ok && blocks.data.items[0]?.extractionMethod).toBe('none')
    await app.cleanup()
  })
})

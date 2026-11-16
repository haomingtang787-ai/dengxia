import { describe, expect, it } from 'vitest'
import { makeDocx, SAMPLE_TXT } from './helpers/builders'
import { createHarness, writeTemp } from './helpers/app'

describe('missing converter', () => {
  it('still imports text and keeps docx anchors when LibreOffice is absent', async () => {
    const app = await createHarness()
    const text = await app.importFile(writeTemp('note.txt', SAMPLE_TXT))
    const docx = await app.importFile(writeTemp('lesson.docx', makeDocx()))
    expect(text.ok && docx.ok).toBe(true)
    if (!text.ok || !docx.ok) return
    await app.service.settle()
    const textJob = app.service.job({ jobId: text.data.jobId })
    const docxJob = app.service.job({ jobId: docx.data.jobId })
    expect(textJob.ok && textJob.data.state).toBe('succeeded')
    expect(docxJob.ok && docxJob.data.state).toBe('partial')
    const detail = app.service.get({ documentVersionId: docx.data.documentVersionId })
    expect(detail.ok).toBe(true)
    if (detail.ok) {
      const missing = detail.data.warnings.find((warning) => warning.code === 'CONVERTER_MISSING')
      expect(missing?.message).toContain('未找到 LibreOffice')
      expect(detail.data.warnings.some((warning) => warning.code === 'CONVERSION_FAILED')).toBe(false)
    }
    const pages = app.service.pages({ documentVersionId: docx.data.documentVersionId })
    expect(pages.ok && pages.data.total).toBe(0)
    const blocks = app.service.blocks({ documentVersionId: docx.data.documentVersionId, scope: 'unpaged' })
    expect(blocks.ok).toBe(true)
    if (blocks.ok) {
      expect(blocks.data.items.map((item) => item.locator.paragraphAnchor)).toContain('docx-p-0001')
      expect(blocks.data.items.every((item) => item.locator.pageNumber === undefined)).toBe(true)
    }
    const status = await app.service.prerequisites()
    expect(status.ok && status.data.sandbox.windowsSandboxVerified).toBe(false)
    expect(status.ok && status.data.sandbox.officeConversionWillRun).toBe(false)
    expect(status.ok && status.data.capabilities.ocr).toBe(false)
    await app.cleanup()
  })
})

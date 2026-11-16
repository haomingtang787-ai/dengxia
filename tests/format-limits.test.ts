import { describe, expect, it } from 'vitest'
import { makePdf } from './helpers/builders'
import { createHarness, writeTemp } from './helpers/app'

describe('format limits', () => {
  it('rejects legacy PowerPoint with conversion guidance', async () => {
    const app = await createHarness()
    const file = writeTemp('old.ppt', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))
    const result = await app.importFile(file)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('UNSUPPORTED_FORMAT')
      expect(result.error.message).toContain('PPTX')
      expect(result.error.retryable).toBe(false)
    }
    await app.cleanup()
  })

  it('rejects an oversized file before creating a document', async () => {
    const app = await createHarness({ limits: { maxFileBytes: 32 } })
    const result = await app.importFile(writeTemp('big.txt', 'x'.repeat(80)))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('LIMIT_EXCEEDED')
    const list = app.service.list({})
    expect(list.ok && list.data.total).toBe(0)
    await app.cleanup()
  })

  it('fails a PDF that exceeds the page cap', async () => {
    const app = await createHarness({ limits: { maxPages: 1 } })
    const pdf = makePdf(['BT /F1 18 Tf 72 720 Td (One) Tj ET', 'BT /F1 18 Tf 72 720 Td (Two) Tj ET'])
    const result = await app.importFile(writeTemp('two.pdf', pdf))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await app.service.settle()
    const job = app.service.job({ jobId: result.data.jobId })
    expect(job.ok && job.data.state).toBe('failed')
    if (job.ok) expect(job.data.error?.code).toBe('LIMIT_EXCEEDED')
    await app.cleanup()
  })
})

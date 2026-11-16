import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SAMPLE_TXT } from './helpers/builders'
import { createHarness, writeTemp } from './helpers/app'

describe('idempotency', () => {
  it('returns the original document for a repeated import request id', async () => {
    const app = await createHarness()
    const file = writeTemp('note.txt', SAMPLE_TXT)
    const requestId = randomUUID()
    const first = await app.importFile(file, requestId)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = await app.service.import('window-a', { handle: randomUUID(), requestId })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.data).toEqual(first.data)
    const listed = app.service.list({})
    expect(listed.ok && listed.data.total).toBe(1)
    await app.cleanup()
  })

  it('reuses the existing document when the same file is imported twice', async () => {
    const app = await createHarness()
    const file = writeTemp('same.txt', SAMPLE_TXT)
    const first = await app.importFile(file)
    const second = await app.importFile(file)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.data.duplicate).toBe(true)
    expect(second.data.documentId).toBe(first.data.documentId)
    expect(second.data.documentVersionId).toBe(first.data.documentVersionId)
    const listed = app.service.list({})
    expect(listed.ok && listed.data.total).toBe(1)
    await app.service.settle()
    const left = app.service.get({ documentVersionId: first.data.documentVersionId })
    expect(left.ok).toBe(true)
    const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    if (left.ok) expect(left.data.sha256).toBe(digest)
    await app.cleanup()
  })

  it('returns the existing retry job when the request id is reused', async () => {
    const app = await createHarness()
    const file = writeTemp('same.txt', '只有一段。\n')
    const imported = await app.importFile(file)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    await app.service.settle()
    const requestId = randomUUID()
    const first = await app.service.retry({ jobId: imported.data.jobId, requestId })
    const second = await app.service.retry({ jobId: imported.data.jobId, requestId })
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) expect(second.data.jobId).toBe(first.data.jobId)
    const job = app.service.job(first.ok ? { jobId: first.data.jobId } : { jobId: '' })
    expect(job.ok && job.data.state).not.toBe('failed')
    await app.service.settle()
    await app.cleanup()
  })
})

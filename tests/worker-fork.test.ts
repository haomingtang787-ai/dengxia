import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ForkWorker } from '../src/providers/forkWorker'
import { SAMPLE_TXT } from './helpers/builders'
import { createHarness, writeTemp } from './helpers/app'

describe('worker process', () => {
  it('parses a text file in a separate node process', async () => {
    const app = await createHarness({ worker: new ForkWorker(path.resolve('out/worker/documentWorker.mjs')) })
    const imported = await app.importFile(writeTemp('fork.txt', SAMPLE_TXT))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    await app.service.settle()
    const job = app.service.job({ jobId: imported.data.jobId })
    expect(job.ok && job.data.state).toBe('succeeded')
    const blocks = app.service.blocks({ documentVersionId: imported.data.documentVersionId, scope: 'unpaged' })
    expect(blocks.ok && blocks.data.items).toHaveLength(3)
    expect(app.events.some((event) => event.state === 'succeeded' && event.seq > 1)).toBe(true)
    await app.cleanup()
  })
})

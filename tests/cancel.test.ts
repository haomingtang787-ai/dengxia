import { describe, expect, it } from 'vitest'
import { SAMPLE_TXT } from './helpers/builders'
import { createHarness, ScriptedWorker, waitFor, writeTemp } from './helpers/app'

describe('cancel', () => {
  it('stays non-cancelled until the worker promise settles, then commits cancelled', async () => {
    const worker = new ScriptedWorker()
    const app = await createHarness({ worker })
    const imported = await app.importFile(writeTemp('note.txt', SAMPLE_TXT))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    await waitFor(() => {
      const job = app.service.job({ jobId: imported.data.jobId })
      return job.ok && job.data.state === 'running'
    }, 'running')
    const pending = app.service.cancel({ jobId: imported.data.jobId })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const midway = app.service.job({ jobId: imported.data.jobId })
    expect(midway.ok && midway.data.state).toBe('running')
    if (midway.ok) expect(midway.data.stage).toBe('canceling')
    const finished = await pending
    expect(finished.ok && finished.data.state).toBe('cancelled')
    const stored = app.service.job({ jobId: imported.data.jobId })
    expect(stored.ok && stored.data.state).toBe('cancelled')
    await app.cleanup()
  })
})

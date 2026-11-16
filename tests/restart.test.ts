import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocumentService } from '../src/documents/service'
import { InProcessWorker } from '../src/providers/workerHost'
import { SettingsStore } from '../src/providers/settings'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { SAMPLE_TXT } from './helpers/builders'
import { createHarness, FakeOffice, ScriptedWorker, waitFor, writeTemp } from './helpers/app'

describe('restart', () => {
  it('marks a running job interrupted and lets a new process retry it', async () => {
    const worker = new ScriptedWorker()
    const first = await createHarness({ worker })
    const file = writeTemp('note.txt', SAMPLE_TXT)
    const imported = await first.importFile(file)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    await waitFor(() => {
      const job = first.service.job({ jobId: imported.data.jobId })
      return job.ok && job.data.state === 'running'
    }, 'running')
    const office = new FakeOffice()
    const db = AppDatabase.open(path.join(first.root, 'library.sqlite'))
    migrate(db)
    const second = new DocumentService({
      db,
      root: first.root,
      worker: new InProcessWorker(),
      office,
      dialogs: { async pickDocuments() { return { cancelled: true, files: [] } }, async pickExecutable() { return { cancelled: true, path: null } } },
      settings: new SettingsStore(path.join(first.root, 'settings.json')),
      events: { jobsChanged() {}, focus() { return true } },
    })
    const interrupted = second.job({ jobId: imported.data.jobId })
    expect(interrupted.ok && interrupted.data.state).toBe('interrupted')
    const retried = await second.retry({ jobId: imported.data.jobId, requestId: randomUUID() })
    expect(retried.ok).toBe(true)
    if (!retried.ok) return
    expect(retried.data.jobId).not.toBe(imported.data.jobId)
    await second.settle()
    const done = second.job({ jobId: retried.data.jobId })
    expect(done.ok && done.data.state).toBe('succeeded')
    const source = second.job({ jobId: imported.data.jobId })
    expect(source.ok && source.data.state).toBe('interrupted')
    await second.close()
    await first.cleanup()
  })
})

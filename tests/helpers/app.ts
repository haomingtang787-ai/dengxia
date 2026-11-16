import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { LIMITS, type Limits } from '../../src/shared/constants'
import type { ImportResult, JobChangedEvent, PreviewFocus, Result } from '../../src/shared/contract'
import { DocumentService, type NativeDialogs } from '../../src/documents/service'
import type { ParseDeps, ParseResult, ParseTask, ProgressReport } from '../../src/documents/parseTypes'
import type { WorkerHandle, WorkerHost } from '../../src/providers/workerHost'
import { InProcessWorker } from '../../src/providers/workerHost'
import type { OfficeDescription, OfficeGateway } from '../../src/providers/officeGateway'
import { SettingsStore } from '../../src/providers/settings'
import { AppDatabase } from '../../src/storage/database'
import { migrate } from '../../src/storage/migrate'
import { Store } from '../../src/storage/store'

export class FakeOffice implements OfficeGateway {
  description: OfficeDescription = { path: null, fileFound: false }

  async describe(): Promise<OfficeDescription> {
    return this.description
  }
}

export class ScriptedWorker implements WorkerHost {
  readonly started: ParseTask[] = []

  start(task: ParseTask, onProgress: (progress: ProgressReport) => void): WorkerHandle {
    this.started.push(task)
    let rejectDone: (error: Error) => void = () => undefined
    let resolveExit: () => void = () => undefined
    const done = new Promise<ParseResult>((_resolve, reject) => {
      rejectDone = reject
    })
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    onProgress({ stage: 'extract', completed: 0, total: 1 })
    return {
      done,
      exited,
      kill: () => {
        setTimeout(() => {
          rejectDone(new Error('cancelled'))
          resolveExit()
        }, 40)
      },
    }
  }
}

export type Harness = {
  root: string
  service: DocumentService
  events: JobChangedEvent[]
  focuses: PreviewFocus[]
  office: OfficeGateway
  db: AppDatabase
  importFile: (filePath: string, requestId?: string, windowId?: string) => Promise<Result<ImportResult>>
  prepare: (filePath: string) => void
  cleanup: () => Promise<void>
}

export async function createHarness(options?: {
  limits?: Partial<Limits>
  worker?: WorkerHost
  deps?: ParseDeps
  repair?: boolean
  office?: OfficeGateway
  backupDir?: string
  restart?: () => void
}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'))
  const db = AppDatabase.open(path.join(root, 'library.sqlite'))
  migrate(db)
  const store = new Store(db)
  const events: JobChangedEvent[] = []
  const focuses: PreviewFocus[] = []
  const office = options?.office ?? new FakeOffice()
  let queued: Array<{ path: string; name: string; sizeBytes: number }> = []
  const dialogs: NativeDialogs = {
    async pickDocuments() {
      return queued.length ? { cancelled: false, files: queued } : { cancelled: true, files: [] }
    },
    async pickExecutable() {
      return { cancelled: true, path: null }
    },
    async pickDirectory() {
      return options?.backupDir ?? null
    },
  }
  const service = new DocumentService({
    db,
    root,
    worker: options?.worker ?? new InProcessWorker(options?.deps),
    office,
    dialogs,
    settings: new SettingsStore(path.join(root, 'settings.json')),
    limits: { ...LIMITS, ...options?.limits },
    repair: options?.repair,
    restart: options?.restart,
    events: {
      jobsChanged(event) {
        const row = store.getJob(event.jobId)
        if (!row || row.seq !== event.seq || row.state !== event.state) {
          throw new Error(`jobs.changed emitted before the database row matched ${event.jobId}`)
        }
        events.push(event)
      },
      focus(_windowId, target) {
        focuses.push(target)
        return true
      },
    },
  })
  return {
    root,
    service,
    events,
    focuses,
    office,
    db,
    prepare(filePath) {
      const stat = fs.statSync(filePath)
      queued = [{ path: filePath, name: path.basename(filePath), sizeBytes: stat.size }]
    },
    async importFile(filePath, requestId = randomUUID(), windowId = 'window-a') {
      const stat = await fs.promises.stat(filePath)
      queued = [{ path: filePath, name: path.basename(filePath), sizeBytes: stat.size }]
      const picked = await service.pick(windowId)
      if (!picked.ok) return picked
      const handle = picked.data.files[0]?.handle
      if (!handle) return { ok: false, requestId, error: { code: 'NOT_FOUND', message: 'picker returned no handle', retryable: false } }
      return service.import(windowId, { handle, requestId })
    },
    async cleanup() {
      await service.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

export async function waitFor(check: () => boolean, label: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 3000) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error(`timed out waiting for ${label}`)
}

export function writeTemp(name: string, bytes: Uint8Array | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-file-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, bytes)
  return file
}

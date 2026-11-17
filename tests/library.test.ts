import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SAMPLE_TXT } from './helpers/builders'
import { createHarness, waitFor, writeTemp } from './helpers/app'
import { AppDatabase } from '../src/storage/database'

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-library-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('文稿整理、复习统计与备份', () => {
  it('搜索、筛选、重命名、置顶与重复导入', async () => {
    const app = await createHarness()
    const file = writeTemp('整理测试.txt', SAMPLE_TXT)
    const first = await app.importFile(file)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await app.service.settle()

    const duplicate = await app.importFile(file)
    expect(duplicate.ok).toBe(true)
    if (duplicate.ok) {
      expect(duplicate.data.duplicate).toBe(true)
      expect(duplicate.data.documentId).toBe(first.data.documentId)
    }

    const listed = app.service.list({ offset: 0, limit: 100 })
    expect(listed.ok && listed.data.total).toBe(1)
    if (!listed.ok) return
    expect(listed.data.items[0].displayName).toBe('整理测试.txt')
    expect(listed.data.items[0].pinned).toBe(false)

    const renamed = app.service.rename({
      documentVersionId: first.data.documentVersionId,
      displayName: '线性代数复习.txt',
    })
    expect(renamed.ok && renamed.data.displayName).toBe('线性代数复习.txt')

    const pinned = app.service.pin({ documentVersionId: first.data.documentVersionId, pinned: true })
    expect(pinned.ok && pinned.data.pinned).toBe(true)
    const afterPin = app.service.list({ offset: 0, limit: 100 })
    expect(afterPin.ok && afterPin.data.items[0].pinned).toBe(true)

    const search = app.service.list({ offset: 0, limit: 100, query: '线性' })
    expect(search.ok && search.data.total).toBe(1)
    const filteredOut = app.service.list({ offset: 0, limit: 100, format: 'pdf' })
    expect(filteredOut.ok && filteredOut.data.total).toBe(0)
    const filteredIn = app.service.list({ offset: 0, limit: 100, format: 'txt' })
    expect(filteredIn.ok && filteredIn.data.total).toBe(1)

    const pinnedOff = app.service.pin({ documentVersionId: first.data.documentVersionId, pinned: false })
    expect(pinnedOff.ok && pinnedOff.data.pinned).toBe(false)
    await app.cleanup()
  })

  it('本机占用、统计与整库备份', async () => {
    const backupRoot = tempDir()
    const app = await createHarness({ backupDir: backupRoot })
    const file = writeTemp('备份测试.txt', SAMPLE_TXT)
    const imported = await app.importFile(file)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    await waitFor(() => {
      const job = app.service.job({ jobId: imported.data.jobId })
      return job.ok && (job.data.state === 'succeeded' || job.data.state === 'partial')
    }, 'parse before backup')

    const usage = app.service.storage()
    expect(usage.ok).toBe(true)
    if (usage.ok) {
      expect(usage.data.documents).toBe(1)
      expect(usage.data.databaseBytes).toBeGreaterThan(0)
      expect(usage.data.totalBytes).toBeGreaterThan(usage.data.databaseBytes)
    }
    const stats = app.service.stats()
    expect(stats.ok && stats.data.documents).toBe(1)

    const backup = await app.service.backup('window-a')
    expect(backup.ok).toBe(true)
    if (!backup.ok) return
    const target = backup.data.path
    expect(fs.existsSync(path.join(target, 'library.sqlite'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'manifest.json'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'settings.json'))).toBe(false)
    expect(fs.existsSync(path.join(target, 'work'))).toBe(false)
    const snapshot = AppDatabase.open(path.join(target, 'library.sqlite'))
    try {
      expect(snapshot.get<{ total: number }>('SELECT COUNT(*) AS total FROM documents')?.total).toBe(1)
      expect(snapshot.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')?.version).toBe(13)
    } finally {
      snapshot.close()
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8')) as {
      version: string
      counts: { documents: number }
    }
    expect(manifest.counts.documents).toBe(1)
    expect(manifest.version).toBe('unknown')
    await app.cleanup()
  })
})


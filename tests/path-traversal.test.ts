import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readManagedPreview, resourceIdFromUrl } from '../src/retrieval/resources'
import { resolveInside } from '../src/storage/paths'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { Store } from '../src/storage/store'
import { listZipEntries } from '../src/documents/zip'
import { makeSlipDocx } from './helpers/builders'
import { createHarness, writeTemp } from './helpers/app'

describe('path traversal', () => {
  it('rejects relative escapes and absolute paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-root-'))
    expect(resolveInside(root, '../etc/passwd')).toBeNull()
    expect(resolveInside(root, '/etc/passwd')).toBeNull()
    expect(resolveInside(root, 'originals/../../outside')).toBeNull()
    expect(resolveInside(root, 'artifacts/ok.png')).toBe(path.resolve(root, 'artifacts/ok.png'))
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('rejects a zip entry that climbs out of the archive', () => {
    expect(() => listZipEntries(makeSlipDocx())).toThrow(/不安全路径/)
  })

  it('does not write a slipped zip entry outside the library during import', async () => {
    const escaped = path.join(os.tmpdir(), `desk-escaped-${randomUUID()}.txt`)
    const app = await createHarness()
    const file = writeTemp('slip.docx', makeSlipDocx())
    const imported = await app.importFile(file)
    expect(imported.ok).toBe(true)
    if (imported.ok) {
      await app.service.settle()
      const job = app.service.job({ jobId: imported.data.jobId })
      expect(job.ok && job.data.state).toBe('failed')
      if (job.ok) expect(job.data.error?.code).toBe('PARSE_FAILED')
    }
    expect(fs.existsSync(escaped)).toBe(false)
    expect(fs.existsSync(path.join(app.root, '..', 'escaped.txt'))).toBe(false)
    await app.cleanup()
  })

  it('serves only managed preview bytes inside the library root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-art-'))
    const db = AppDatabase.open(path.join(root, 'library.sqlite'))
    migrate(db)
    const store = new Store(db)
    const outside = path.join(os.tmpdir(), `passwd-link-${randomUUID()}`)
    fs.writeFileSync(outside, 'secret')
    const artifacts = path.join(root, 'artifacts')
    fs.mkdirSync(artifacts, { recursive: true })
    let relpath = 'artifacts/escape.png'
    let outsideDir: string | null = null
    try {
      fs.symlinkSync(outside, path.join(artifacts, 'escape.png'))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || code !== 'EPERM') throw error
      // Windows without Developer Mode or elevation cannot create file
      // symlinks. A directory junction also resolves outside the library root
      // after realpath, so the same guard is exercised without weakening it.
      outsideDir = path.join(os.tmpdir(), `desk-outside-${randomUUID()}`)
      fs.mkdirSync(outsideDir, { recursive: true })
      fs.writeFileSync(path.join(outsideDir, 'escape.png'), 'secret')
      fs.symlinkSync(outsideDir, path.join(artifacts, 'escape-dir'), 'junction')
      relpath = 'artifacts/escape-dir/escape.png'
    }
    const version = '11111111-1111-4111-8111-111111111111'
    const document = '22222222-2222-4222-8222-222222222222'
    const now = new Date().toISOString()
    store.insertDocument({ id: document, display_name: 'x', created_at: now })
    store.insertVersion({
      id: version,
      document_id: document,
      sha256: 'abc',
      format: 'png',
      size_bytes: 1,
      original_relpath: 'originals/a',
      status: 'stored',
      parser_version: 'test',
      created_at: now,
    })
    store.insertArtifact({
      id: '33333333-3333-4333-8333-333333333333',
      document_version_id: version,
      page_id: null,
      kind: 'page-image',
      relpath,
      mime: 'image/png',
      sha256: 'nope',
    })
    expect(readManagedPreview(store, root, '33333333-3333-4333-8333-333333333333').status).toBe(403)
    expect(resourceIdFromUrl('app-resource://../../etc/passwd')).toBeNull()
    expect(resourceIdFromUrl('app-resource://33333333-3333-4333-8333-333333333333/extra')).toBeNull()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { force: true })
    if (outsideDir) fs.rmSync(outsideDir, { recursive: true, force: true })
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './helpers/app'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { SettingsStore } from '../src/providers/settings'
import { BudgetService } from '../src/ai/budget'
import { Store } from '../src/storage/store'

const apps: Harness[] = []
const temps: string[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.cleanup()
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-061-'))
  temps.push(root)
  return root
}

function seedBlock(app: Harness, text = '矩阵的特征值之和等于迹，特征值之积等于行列式。') {
  const store = new Store(app.db)
  const docId = randomUUID()
  const versionId = randomUUID()
  const pageId = randomUUID()
  const blockId = randomUUID()
  store.insertDocument({ id: docId, display_name: '信任层测试.pdf', created_at: '2026-11-17T10:00:00.000Z' })
  store.insertVersion({
    id: versionId,
    document_id: docId,
    sha256: 'd'.repeat(64),
    format: 'pdf',
    size_bytes: 1,
    original_relpath: `originals/${versionId}.pdf`,
    status: 'ready',
    parser_version: '9',
    created_at: '2026-11-17T10:00:00.000Z',
  })
  store.insertPage({
    id: pageId,
    document_version_id: versionId,
    ordinal: 1,
    source_kind: 'pdf',
    source_number: 1,
    image_relpath: null,
    width: null,
    height: null,
    status: 'ready',
  })
  store.insertBlock({
    id: blockId,
    document_version_id: versionId,
    page_id: pageId,
    ordinal: 1,
    kind: 'paragraph',
    text,
    locator_json: '{"kind":"pdf","pageNumber":1}',
    extraction_method: 'pdf-text',
    review_state: 'unverified',
  })
  return { docId, versionId, pageId, blockId, text }
}

describe('0.6.1 信任层', () => {
  it('备份 manifest 带数据库哈希与完整性，正常恢复可验证', async () => {
    const source = await createHarness()
    apps.push(source)
    const backupPath = path.join(tempRoot(), 'backup')
    const result = await source.service.writeBackup(backupPath)
    expect(result.files).toBeGreaterThan(0)

    const manifest = JSON.parse(fs.readFileSync(path.join(backupPath, 'manifest.json'), 'utf8')) as {
      database?: { sha256?: string; sizeBytes?: number; integrity?: string }
      files?: number
      bytes?: number
    }
    expect(manifest.database?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.database?.sizeBytes).toBeGreaterThan(0)
    expect(manifest.database?.integrity).toBe('ok')
    expect(manifest.files).toBeGreaterThan(0)
    expect(manifest.bytes).toBeGreaterThan(0)

    const dest = await createHarness({ backupDir: backupPath })
    apps.push(dest)
    const preview = await dest.service.inspectRestore('window-a')
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.data.verification).toBe('sha256')
    expect(preview.data.databaseSha256).toBe(manifest.database?.sha256)
  })

  it('库被改一个字节时恢复预览拒绝，不进入 applyRestore', async () => {
    const source = await createHarness()
    apps.push(source)
    const backupPath = path.join(tempRoot(), 'backup')
    await source.service.writeBackup(backupPath)
    const dbFile = path.join(backupPath, 'library.sqlite')
    const before = fs.readFileSync(dbFile)
    const changed = Buffer.from(before)
    changed[Math.floor(changed.length / 2)] = changed[Math.floor(changed.length / 2)] ^ 0xff
    fs.writeFileSync(dbFile, changed)

    const dest = await createHarness({ backupDir: backupPath })
    apps.push(dest)
    const preview = await dest.service.inspectRestore('window-a')
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.error.message).toContain('校验')
  })

  it('哈希对得上但不是 SQLite 时 integrity_check 仍拒绝', async () => {
    const source = await createHarness()
    apps.push(source)
    const backupPath = path.join(tempRoot(), 'backup')
    await source.service.writeBackup(backupPath)
    const dbFile = path.join(backupPath, 'library.sqlite')
    const fake = Buffer.from('this is not a sqlite database')
    fs.writeFileSync(dbFile, fake)
    const manifestFile = path.join(backupPath, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
      database?: { sha256?: string; sizeBytes?: number }
    }
    const { createHash } = await import('node:crypto')
    manifest.database = {
      ...(manifest.database ?? {}),
      sha256: createHash('sha256').update(fake).digest('hex'),
      sizeBytes: fake.length,
    }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8')

    const dest = await createHarness({ backupDir: backupPath })
    apps.push(dest)
    const preview = await dest.service.inspectRestore('window-a')
    expect(preview.ok).toBe(false)
    if (!preview.ok) expect(preview.error.message).toContain('SQLite')
  })

  it('旧备份没有哈希时仍可预览，但标为 legacy', async () => {
    const source = await createHarness()
    apps.push(source)
    const backupPath = path.join(tempRoot(), 'backup')
    await source.service.writeBackup(backupPath)
    const manifestFile = path.join(backupPath, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
    delete manifest.database
    delete manifest.files
    delete manifest.bytes
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8')

    const dest = await createHarness({ backupDir: backupPath })
    apps.push(dest)
    const preview = await dest.service.inspectRestore('window-a')
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.data.verification).toBe('legacy')
    expect(preview.data.databaseSha256).toBeNull()
  })

  it('高亮所在 block 文字变了会标记失效，并能清理', async () => {
    const app = await createHarness()
    apps.push(app)
    const block = seedBlock(app)
    const created = app.service.createHighlight({
      documentVersionId: block.versionId,
      pageId: block.pageId,
      blockId: block.blockId,
      startOffset: 0,
      endOffset: 5,
    })
    expect(created.ok).toBe(true)
    app.db.run('UPDATE blocks SET text = ? WHERE id = ?', '矩阵的迹等', block.blockId)

    const listed = app.service.highlights({ documentVersionId: block.versionId })
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.items[0]?.valid).toBe(false)
    expect(listed.data.items[0]?.reason).toBe('quote_changed')

    const cleaned = app.service.cleanupHighlights({ documentVersionId: block.versionId })
    expect(cleaned.ok).toBe(true)
    if (!cleaned.ok) return
    expect(cleaned.data.deleted).toBe(1)
    const after = app.service.highlights({ documentVersionId: block.versionId })
    expect(after.ok && after.data.items).toHaveLength(0)
  })

  it('没有 usage 的模型调用标为估算，不会静默当成真实 0', () => {
    const root = tempRoot()
    const db = AppDatabase.open(path.join(root, 'library.sqlite'))
    migrate(db)
    const settings = new SettingsStore(path.join(root, 'settings.json'))
    settings.save({ libreOfficePath: null, ai: null, pinnedDocumentIds: [], budget: { monthlyTokens: 1000, hardStop: false } })
    db.run(
      `INSERT INTO ai_usage(session_id, document_version_id, kind, prompt_tokens, cached_tokens, completion_tokens, created_at)
       VALUES (NULL, NULL, 'chat', 0, 0, 0, ?)`,
      new Date().toISOString(),
    )
    const budget = new BudgetService(db, settings)
    try {
      const status = budget.status()
      expect(status.estimatedCalls).toBe(1)
      expect(status.estimated).toBe(true)
      expect(status.used).toBe(0)

      db.run(
        `INSERT INTO ai_usage(session_id, document_version_id, kind, prompt_tokens, cached_tokens, completion_tokens, created_at)
         VALUES (NULL, NULL, 'chat', 20, 0, 10, ?)`,
        new Date().toISOString(),
      )
      const after = budget.status()
      expect(after.used).toBe(30)
      expect(after.estimatedCalls).toBe(1)
      expect(after.estimated).toBe(true)
    } finally {
      db.close()
    }
  })
})

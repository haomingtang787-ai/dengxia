import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { isUtcIso } from '../src/domain/ids'

describe('storage', () => {
  it('enforces foreign keys and records the migration', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-db-'))
    const db = AppDatabase.open(path.join(dir, 'library.sqlite'))
    migrate(db)
    expect(db.pragmaForeignKeys()).toBe(1)
    const migration = db.get<{ version: number; applied_at: string }>('SELECT version, applied_at FROM schema_migrations')
    expect(migration?.version).toBe(1)
    expect(migration && isUtcIso(migration.applied_at)).toBe(true)
    const latest = db.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')
    expect(latest?.version).toBe(14)
    const columns = db.all<{ name: string }>('PRAGMA table_info(lecture_cards)')
    expect(columns.some((column) => column.name === 'last_graded_at')).toBe(true)
    expect(() => db.run('INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'v', 'missing', 'abc', 'txt', 1, 'originals/a', 'stored', 't', new Date().toISOString())).toThrow(/FOREIGN KEY/)
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})


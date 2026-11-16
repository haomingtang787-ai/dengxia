import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makePptx, SAMPLE_TXT } from './helpers/builders'
import { createHarness, ScriptedWorker, writeTemp, type Harness } from './helpers/app'

const VERSION_TABLES = [
  'pages',
  'blocks',
  'block_readings',
  'image_readings',
  'page_research',
  'artifacts',
  'issues',
  'jobs',
  'lectures',
  'study_sessions',
  'material_digests',
  'ai_usage',
] as const

function countByVersion(app: Harness, table: string, versionId: string): number {
  return app.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE document_version_id = ?`, versionId)[0]?.n ?? 0
}

function countBy(app: Harness, sql: string, value: string): number {
  return app.db.all<{ n: number }>(sql, value)[0]?.n ?? 0
}

describe('document delete', () => {
  it('removes the whole document with its rows and files, leaving other documents intact', async () => {
    const app = await createHarness()
    const kept = await app.importFile(writeTemp('kept.txt', SAMPLE_TXT))
    const doomed = await app.importFile(writeTemp('doomed.pptx', makePptx()))
    expect(kept.ok && doomed.ok).toBe(true)
    if (!kept.ok || !doomed.ok) return
    await app.service.settle()

    const versionId = doomed.data.documentVersionId
    expect(countBy(app, 'SELECT COUNT(*) AS n FROM document_versions WHERE id = ?', versionId)).toBe(1)
    expect(countByVersion(app, 'pages', versionId)).toBeGreaterThan(0)
    expect(countByVersion(app, 'blocks', versionId)).toBeGreaterThan(0)
    expect(countByVersion(app, 'artifacts', versionId)).toBeGreaterThan(0)
    expect(countByVersion(app, 'jobs', versionId)).toBe(1)
    const originalDir = path.join(app.root, 'originals', doomed.data.documentId)
    const artifactDir = path.join(app.root, 'artifacts', doomed.data.documentId)
    expect(fs.existsSync(originalDir)).toBe(true)
    expect(fs.existsSync(artifactDir)).toBe(true)

    const deleted = await app.service.delete({ documentVersionId: versionId })
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) return
    expect(deleted.data).toEqual({ documentId: doomed.data.documentId, removedVersions: 1 })

    for (const table of VERSION_TABLES) {
      expect(countByVersion(app, table, versionId)).toBe(0)
    }
    expect(countBy(app, 'SELECT COUNT(*) AS n FROM document_versions WHERE id = ?', versionId)).toBe(0)
    expect(countBy(app, 'SELECT COUNT(*) AS n FROM documents WHERE id = ?', doomed.data.documentId)).toBe(0)
    expect(fs.existsSync(originalDir)).toBe(false)
    expect(fs.existsSync(artifactDir)).toBe(false)

    const detail = app.service.get({ documentVersionId: versionId })
    expect(detail.ok).toBe(false)
    if (!detail.ok) expect(detail.error.code).toBe('NOT_FOUND')

    const list = app.service.list({ offset: 0, limit: 50 })
    expect(list.ok).toBe(true)
    if (list.ok) {
      expect(list.data.total).toBe(1)
      expect(list.data.items[0]?.documentVersionId).toBe(kept.data.documentVersionId)
    }
    const keptDetail = app.service.get({ documentVersionId: kept.data.documentVersionId })
    expect(keptDetail.ok).toBe(true)
    expect(fs.existsSync(path.join(app.root, 'originals', kept.data.documentId))).toBe(true)

    const again = await app.service.delete({ documentVersionId: versionId })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe('NOT_FOUND')

    await app.cleanup()
  })

  it('takes lectures, cards, misses, usage rows and retry-chained jobs down with the document', async () => {
    const app = await createHarness()
    const imported = await app.importFile(writeTemp('course.txt', SAMPLE_TXT))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    await app.service.settle()
    const versionId = imported.data.documentVersionId
    const now = new Date().toISOString()
    const lectureId = randomUUID()
    const cardId = randomUUID()
    const missId = randomUUID()

    // 造一门课、一张卡、一道错题和用量行，验证它们都跟着文稿一起消失。
    app.db.run(
      `INSERT INTO lectures (id, request_id, document_version_id, title, subject, source_name, greeting, thesis, tonight, next_sitting, raw_text, habit_stamp, created_at)
       VALUES (?, ?, ?, '标题', '数学', 'course.txt', '开场', '论点', '今晚', '下次', '原文', '习惯', ?)`,
      lectureId,
      randomUUID(),
      versionId,
      now,
    )
    app.db.run(
      `INSERT INTO lecture_cards (lecture_id, ordinal, id, front, back, box, due) VALUES (?, 1, ?, '正面', '背面', 0, ?)`,
      lectureId,
      cardId,
      Date.now(),
    )
    app.db.run(
      `INSERT INTO misses (id, lecture_id, prompt, explain, at) VALUES (?, ?, '题目', '解析', ?)`,
      missId,
      lectureId,
      Date.now(),
    )
    app.db.run(
      `INSERT INTO ai_usage (session_id, document_version_id, kind, prompt_tokens, cached_tokens, completion_tokens, created_at)
       VALUES (NULL, ?, 'lecture', 10, 0, 5, ?)`,
      versionId,
      now,
    )
    const existingJob = countBy(app, 'SELECT COUNT(*) AS n FROM jobs WHERE document_version_id = ?', versionId)
    expect(existingJob).toBe(1)
    const firstJob = app.db.all<{ id: string }>('SELECT id FROM jobs WHERE document_version_id = ?', versionId)[0]!
    const retryId = randomUUID()
    app.db.run(
      `INSERT INTO jobs (id, document_version_id, request_id, retry_of, state, stage, completed, total, seq, error_code, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'failed', 'done', 0, NULL, 0, NULL, NULL, ?, ?)`,
      retryId,
      versionId,
      randomUUID(),
      firstJob.id,
      now,
      now,
    )
    expect(countBy(app, 'SELECT COUNT(*) AS n FROM jobs WHERE document_version_id = ?', versionId)).toBe(2)

    const deleted = await app.service.delete({ documentVersionId: versionId })
    expect(deleted.ok).toBe(true)

    expect(countBy(app, 'SELECT COUNT(*) AS n FROM lectures WHERE document_version_id = ?', versionId)).toBe(0)
    expect(countBy(app, 'SELECT COUNT(*) AS n FROM lecture_cards WHERE lecture_id = ?', lectureId)).toBe(0)
    expect(countBy(app, 'SELECT COUNT(*) AS n FROM misses WHERE lecture_id = ?', lectureId)).toBe(0)
    expect(countBy(app, 'SELECT COUNT(*) AS n FROM ai_usage WHERE document_version_id = ?', versionId)).toBe(0)
    expect(countBy(app, 'SELECT COUNT(*) AS n FROM jobs WHERE document_version_id = ?', versionId)).toBe(0)

    await app.cleanup()
  })

  it('stops an in-flight parse before deleting the document', async () => {
    const app = await createHarness({ worker: new ScriptedWorker() })
    const imported = await app.importFile(writeTemp('busy.txt', SAMPLE_TXT))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    const versionId = imported.data.documentVersionId

    const deleted = await app.service.delete({ documentVersionId: versionId })
    expect(deleted.ok).toBe(true)
    expect(app.service.get({ documentVersionId: versionId }).ok).toBe(false)
    expect(countBy(app, 'SELECT COUNT(*) AS n FROM jobs WHERE document_version_id = ?', versionId)).toBe(0)
    expect(fs.existsSync(path.join(app.root, 'originals', imported.data.documentId))).toBe(false)

    await app.cleanup()
  })
})

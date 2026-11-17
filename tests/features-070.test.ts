import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { TeacherService } from '../src/teaching/teacherService'
import { buildTeacherNotePrompt } from '../src/study/prompt'
import { parseTeacherNote } from '../src/study/parse'

let root: string
let db: AppDatabase
let teacher: TeacherService

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-070-'))
  db = AppDatabase.open(path.join(root, 'library.sqlite'))
  migrate(db)
  teacher = new TeacherService({ db, now: () => Date.parse('2026-11-17T10:00:00.000Z') })
})

afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('0.7.0 老师地基', () => {
  it('迁移到 schema 12，默认人格是“老师”，重复迁移不丢数据', () => {
    const latest = db.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')?.version
    expect(latest).toBe(15)

    const overview = teacher.overview()
    expect(overview.ok).toBe(true)
    if (!overview.ok) return
    expect(overview.data.persona.name).toBe('老师')
    expect(overview.data.profile.goal).toBe('')
    expect(overview.data.memories).toEqual([])

    const docId = randomUUID()
    db.run('INSERT INTO documents(id, display_name, created_at) VALUES (?, ?, ?)', docId, '迁移不能丢.pdf', '2026-11-17T10:00:00.000Z')
    migrate(db)
    expect(db.get<{ total: number }>('SELECT COUNT(*) AS total FROM documents')?.total).toBe(1)
    expect(db.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')?.version).toBe(15)
  })

  it('人格与档案可保存，重开库后仍是保存值', () => {
    const savedPersona = teacher.savePersona({
      name: '周老师',
      pronoun: 'she',
      tone: 'warm-rigorous',
      boundaries: ['不替我思考'],
    })
    expect(savedPersona.ok).toBe(true)
    if (savedPersona.ok) expect(savedPersona.data.name).toBe('周老师')

    const savedProfile = teacher.saveProfile({
      goal: '考试',
      level: '学过但忘',
      subjects: ['线性代数', '数据结构'],
      examDate: '2027-01-10',
      weeklyMinutes: 420,
      notes: '先给例子，再给定义',
    })
    expect(savedProfile.ok).toBe(true)

    db.close()
    db = AppDatabase.open(path.join(root, 'library.sqlite'))
    migrate(db)
    const reopened = new TeacherService({ db }).overview()
    expect(reopened.ok).toBe(true)
    if (!reopened.ok) return
    expect(reopened.data.persona.name).toBe('周老师')
    expect(reopened.data.profile.goal).toBe('考试')
    expect(reopened.data.profile.level).toBe('学过但忘')
    expect(reopened.data.profile.subjects).toEqual(['线性代数', '数据结构'])
    expect(reopened.data.profile.weeklyMinutes).toBe(420)
    expect(reopened.data.profile.notes).toBe('先给例子，再给定义')
  })

  it('同 kind + subject + concept 的记忆更新旧条，不堆重复', () => {
    const first = teacher.memorySave({
      kind: 'misconception',
      subject: '线性代数',
      concept: '特征值 / 特征向量',
      statement: '容易把特征值和特征向量说反',
      evidence: '第 3 讲作答把 v 写成了 λ',
      confidence: 0.72,
      userConfirmed: false,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = teacher.memorySave({
      kind: 'misconception',
      subject: '线性代数',
      concept: '特征值 / 特征向量',
      statement: '第 2 次追问仍然混，需要先问 λ 和 v 谁对应谁',
      evidence: '第 3 讲 + 第 4 讲两次作答',
      confidence: 0.82,
      userConfirmed: false,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.id).toBe(first.data.id)

    const listed = teacher.memoryList()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.data.items).toHaveLength(1)
    expect(listed.data.items[0]?.statement).toContain('第 2 次追问')
    expect(listed.data.items[0]?.confidence).toBe(0.82)
  })

  it('活跃记忆最多 40 条，旧条会归档；重置清空记忆但保留默认人格', () => {
    for (let index = 0; index < 42; index += 1) {
      const result = teacher.memorySave({
        kind: 'preference',
        subject: '学习',
        concept: `偏好 ${index}`,
        statement: `偏好 ${index}`,
        evidence: '测试',
        confidence: 0.5,
        userConfirmed: false,
      })
      expect(result.ok).toBe(true)
    }
    const active = teacher.memoryList()
    expect(active.ok).toBe(true)
    if (!active.ok) return
    expect(active.data.items.length).toBe(40)
    expect(active.data.items.every((item) => item.status === 'active')).toBe(true)

    const reset = teacher.reset()
    expect(reset.ok).toBe(true)
    if (!reset.ok) return
    expect(reset.data.persona.name).toBe('老师')
    expect(reset.data.memories).toEqual([])
  })

  it('删除课堂会级联删手记，记忆来源置空但不丢记忆', () => {
    const docId = randomUUID()
    const versionId = randomUUID()
    const sessionId = randomUUID()
    db.run('INSERT INTO documents(id, display_name, created_at) VALUES (?, ?, ?)', docId, '删除测试.pdf', '2026-11-17T10:00:00.000Z')
    db.run(
      `INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      versionId, docId, 'b'.repeat(64), 'pdf', 4, 'originals/b.pdf', 'ready', 'test', '2026-11-17T10:00:00.000Z',
    )
    db.run(
      `INSERT INTO study_sessions(
        id, request_id, document_version_id, title, subject, source_name, overview, outline_json,
        habits_json, warnings_json, truncated, material_chars, material_chunks, status, summary_json,
        teacher_snapshot_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId, randomUUID(), versionId, '删除测试', '测试', '删除测试.pdf', '总览', '[]',
      '{}', '[]', 0, 10, 1, 'ready', '', '', '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:00.000Z',
    )
    teacher.saveNote(sessionId, { summary: '这次课的手记', worked: [], stuck: [], next: [] })
    expect(teacher.noteForSession(sessionId)?.summary).toContain('手记')
    const memory = teacher.memorySave({
      kind: 'mastery',
      subject: '测试',
      concept: '来源',
      statement: '这条记忆来自这堂课',
      evidence: '课堂作答',
      confidence: 0.6,
      sourceSessionId: sessionId,
      sourceDocumentVersionId: versionId,
      userConfirmed: true,
    })
    expect(memory.ok).toBe(true)
    if (!memory.ok) return

    db.run('DELETE FROM study_sessions WHERE id = ?', sessionId)
    expect(teacher.noteForSession(sessionId)).toBeNull()
    const listed = teacher.memoryList()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const kept = listed.data.items.find((item) => item.id === memory.data.id)
    expect(kept).toBeDefined()
    expect(kept?.sourceSessionId).toBeNull()
    expect(kept?.sourceDocumentVersionId).toBe(versionId)
  })

  it('下课手记提示词要求四段加观察，解析缺失字段时给空数组', () => {
    const prompt = buildTeacherNotePrompt({
      teacherName: '周老师',
      title: '光合作用',
      overview: '这页讲场所和反应式。',
      units: [],
      messages: [],
      checks: [{ unitOrdinal: 0, segmentIndex: 0, question: '场所？', answer: '叶绿体', createdAt: 'x' }],
    })
    expect(prompt.system).toContain('老师手记')
    expect(prompt.system).toContain('memories')
    expect(prompt.user).toContain('叶绿体')
    expect(prompt.user).toContain('memories')

    const parsed = parseTeacherNote(JSON.stringify({ summary: '这次学到场所。' }))
    expect(parsed.summary).toBe('这次学到场所。')
    expect(parsed.worked).toEqual([])
    expect(parsed.stuck).toEqual([])
    expect(parsed.next).toEqual([])
    expect(parsed.memories).toEqual([])
  })

  it('手记解析最多保留两条观察记忆，类型不合法的不入库', () => {
    const parsed = parseTeacherNote(JSON.stringify({
      summary: '这次学到场所和反应式。',
      worked: [],
      stuck: ['反应式还没配平'],
      next: [],
      memories: [
        { kind: 'misconception', subject: '生物', concept: '场所', statement: '容易把场所记反。' },
        { kind: 'preference', subject: '生物', concept: '', statement: '更喜欢先看例子。' },
        { kind: 'mastery', subject: '生物', concept: '反应式', statement: '这条不该被保留。' },
      ],
    }))
    expect(parsed.memories).toHaveLength(2)
    expect(parsed.memories[0]).toMatchObject({ kind: 'misconception', subject: '生物', concept: '场所' })
  })

  it('下课时写入观察记忆：最多两条、去重、不降级已确认记忆', () => {
    const observations = [
      { kind: 'misconception' as const, subject: '线代', concept: '特征值', statement: '容易把特征值和特征向量说反。' },
      { kind: 'preference' as const, subject: '线代', concept: '', statement: '更喜欢先看具体例子。' },
      { kind: 'mastery' as const, subject: '线代', concept: '正交', statement: '第三条不该写入。' },
    ]
    const saved = teacher.saveObservations(null, null, observations)
    expect(saved).toHaveLength(2)
    expect(saved.every((item) => item.userConfirmed === false)).toBe(true)
    expect(saved.every((item) => item.status === 'active')).toBe(true)

    const repeated = teacher.saveObservations(null, null, [observations[0]])
    const afterRepeat = teacher.memoryList()
    expect(afterRepeat.ok).toBe(true)
    if (!afterRepeat.ok) return
    expect(afterRepeat.data.items).toHaveLength(2)
    expect(repeated[0].id).toBe(saved[0].id)

    const target = afterRepeat.data.items.find((item) => item.id === saved[0].id)!
    const confirmed = teacher.memorySave({
      ...target,
      statement: '确认后的说法：先分清数配向量。',
      userConfirmed: true,
    })
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok) return
    expect(confirmed.data.userConfirmed).toBe(true)

    teacher.saveObservations(null, null, [{ ...observations[0], statement: '新的观察，不该覆盖确认。' }])
    const afterConfirmed = teacher.memoryList()
    expect(afterConfirmed.ok).toBe(true)
    if (!afterConfirmed.ok) return
    const kept = afterConfirmed.data.items.find((item) => item.id === target.id)
    expect(kept?.userConfirmed).toBe(true)
    expect(kept?.statement).toBe('确认后的说法：先分清数配向量。')
  })

  it('老师手记可更新、可删除', () => {
    const fixture = sessionFixture()
    teacher.saveNote(fixture.sessionId, {
      summary: '初版手记。',
      worked: ['讲通了场所'],
      stuck: [],
      next: ['下次配平'],
    })
    const updated = teacher.noteSave({
      sessionId: fixture.sessionId,
      summary: '改后的手记。',
      worked: ['讲通了场所', '会自己举例'],
      stuck: ['反应式仍没配平'],
      next: ['先做一道配平题'],
    })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.data.summary).toBe('改后的手记。')
    expect(updated.data.worked).toHaveLength(2)
    expect(teacher.noteForSession(fixture.sessionId)?.summary).toBe('改后的手记。')

    const removed = teacher.noteDelete({ sessionId: fixture.sessionId })
    expect(removed.ok).toBe(true)
    if (!removed.ok) return
    expect(removed.data.deleted).toBe(true)
    expect(teacher.noteForSession(fixture.sessionId)).toBeNull()
  })
})

function sessionFixture(): { sessionId: string; versionId: string } {
  const docId = randomUUID()
  const versionId = randomUUID()
  const sessionId = randomUUID()
  db.run('INSERT INTO documents(id, display_name, created_at) VALUES (?, ?, ?)', docId, '手记编辑测试.pdf', '2026-11-17T10:00:00.000Z')
  db.run(
    `INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    versionId, docId, 'c'.repeat(64), 'pdf', 4, 'originals/c.pdf', 'ready', 'test', '2026-11-17T10:00:00.000Z',
  )
  db.run(
    `INSERT INTO study_sessions(
      id, request_id, document_version_id, title, subject, source_name, overview, outline_json,
      habits_json, warnings_json, truncated, material_chars, material_chunks, status, summary_json,
      teacher_snapshot_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId, randomUUID(), versionId, '手记编辑测试', '测试', '手记编辑测试.pdf', '总览', '[]',
    '{}', '[]', 0, 10, 1, 'ready', '', '', '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:00.000Z',
  )
  return { sessionId, versionId }
}


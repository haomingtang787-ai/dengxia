import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore } from '../src/providers/settings'
import { AppDatabase } from '../src/storage/database'
import { CURRENT_SCHEMA_VERSION, migrate } from '../src/storage/migrate'
import { StudyService } from '../src/study/service'

const DOC_ID = randomUUID()
const VERSION_ID = randomUUID()
const PAGE_ID = randomUUID()

let db: AppDatabase
let settings: SettingsStore

beforeEach(() => {
  db = AppDatabase.open(':memory:')
  migrate(db)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-study-miss-test-'))
  settings = new SettingsStore(path.join(root, 'settings.json'))
  settings.save({
    libreOfficePath: null,
    ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'k' },
  })
  db.run('INSERT INTO documents(id, display_name, created_at) VALUES (?, ?, ?)', DOC_ID, '错题账本课件', '2026-11-17T00:00:00.000Z')
  db.run(
    `INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    VERSION_ID, DOC_ID, 'b'.repeat(64), 'pdf', 4, 'originals/b.pdf', 'ready', 'test', '2026-11-17T00:00:00.000Z',
  )
  db.run(
    `INSERT INTO pages(id, document_version_id, ordinal, source_kind, source_number, image_relpath, width, height, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    PAGE_ID, VERSION_ID, 0, 'pdf', 2, 'artifacts/page.png', 100, 100, 'ready',
  )
  db.run(
    `INSERT INTO blocks(id, document_version_id, page_id, ordinal, kind, text, locator_json, extraction_method, review_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), VERSION_ID, PAGE_ID, 0, 'page_text', '两个向量正交，就是内积为 0。', '{}', 'pdf-text', 'unverified',
  )
})

const PLAN = {
  title: '正交',
  subject: '线性代数',
  overview: '这一页只讲正交的定义。',
  opening: '先看这一页的把垂直翻译成内积。',
  units: [{
    title: '正交的定义',
    source: '第 2 页',
    minutes: 6,
    keyPoints: ['正交是内积为 0'],
    segments: [{
      source: '两个向量正交，就是内积为 0。',
      explain: '先看原文：正交不是画出来的垂直，而是内积这个数等于 0。',
      check: '零向量和任意向量正交吗？',
    }, {
      source: '两个向量正交，就是内积为 0。',
      explain: '再看边界：零向量和任何向量的内积都是 0，所以它和谁都正交。',
      check: '为什么零向量要单独看？',
    }],
  }],
}

const QUIZ = {
  questions: [
    { prompt: '为什么内积为 0 可以定义正交？', hint: '回到内积式子。', source: '两个向量正交，就是内积为 0。' },
    { prompt: '零向量和任意向量正交吗？', hint: '看内积是否为 0。', source: '两个向量正交，就是内积为 0。' },
  ],
}

function fakeFetch() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const system = String(body.messages?.[0]?.content ?? '')
    let content = ''
    if (system.includes('课程设计')) content = JSON.stringify(PLAN)
    else if (system.includes('正在出题')) content = JSON.stringify(QUIZ)
    else if (system.includes('正在判题')) {
      content = JSON.stringify({
        feedback: '第一题没有说清内积为 0 的几何意义；第二题答对了。',
        gaps: ['内积为 0 的几何意义'],
        results: [
          { index: 1, correct: false, explain: '正交不是画出来的垂直，而是内积为 0。' },
          { index: 2, correct: true, explain: '' },
        ],
      })
    } else {
      content = '先看第 2 页：内积为 0 就是正交。'
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function service() {
  return new StudyService({
    db,
    settings,
    habits: () => ({
      name: '小明',
      pace: 'slow',
      style: 'define',
      minutes: 25,
      window: 'evening',
      avoid: 'long',
    }),
    images: {
      vision: vi.fn(),
      ocr: vi.fn(),
      visionEmbedded: vi.fn(),
    } as never,
    fetchImpl: fakeFetch() as unknown as typeof fetch,
  })
}

describe('1.0.1 课堂错题账本', () => {
  it('迁移到 schema 15 并创建 study_misses', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(15)
    expect(db.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')?.version).toBe(15)
    expect(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='study_misses'")?.name).toBe('study_misses')
  })

  it('旧 v14 库补迁移到 v15，旧表不丢', () => {
    db.exec('DROP TABLE study_misses')
    db.run('DELETE FROM schema_migrations WHERE version = 15')
    migrate(db)
    expect(db.get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations')?.version).toBe(15)
    expect(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='misses'")?.name).toBe('misses')
    expect(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='study_misses'")?.name).toBe('study_misses')
  })

  it('判题后把答错的题写进账本，答对不写；重练后消除', async () => {
    const svc = service()
    const created = await svc.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '正交' })
    expect(created.ok).toBe(true)
    const sessionId = created.ok ? created.data.sessionId : ''

    const quiz = await svc.tool({ sessionId, tool: 'quiz', unitOrdinal: 0 })
    expect(quiz.ok).toBe(true)
    const questions = quiz.ok
      ? (quiz.data.artifacts.find((artifact) => artifact.kind === 'quiz')?.body.questions ?? [])
      : []
    expect(questions).toHaveLength(2)

    const graded = await svc.tool({
      sessionId,
      tool: 'quiz-grade',
      unitOrdinal: 0,
      answers: [
        { questionId: questions[0].id, answer: '因为垂直。' },
        { questionId: questions[1].id, answer: '是，零向量内积为零。' },
      ],
    })
    expect(graded.ok).toBe(true)

    const summary = svc.reviewSummary()
    expect(summary.ok ? summary.data.misses : -1).toBe(1)
    const misses = svc.misses({ limit: 10 })
    expect(misses.ok).toBe(true)
    if (misses.ok) {
      expect(misses.data.items).toHaveLength(1)
      expect(misses.data.items[0].prompt).toContain('内积为 0')
      expect(misses.data.items[0].answer).toBe('因为垂直。')
      expect(misses.data.items[0].explain).toContain('内积为 0')
    }

    const missId = misses.ok ? misses.data.items[0].id : ''
    const gradedMiss = svc.gradeMiss({ missId, remembered: true })
    expect(gradedMiss.ok).toBe(true)
    const after = svc.reviewSummary()
    expect(after.ok ? after.data.misses : -1).toBe(0)
  })
})

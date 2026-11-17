import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore } from '../src/providers/settings'
import { AppDatabase } from '../src/storage/database'
import { CURRENT_SCHEMA_VERSION, backfillStudyCourses, migrate } from '../src/storage/migrate'
import { StudyStore } from '../src/storage/studyStore'
import { StudyService } from '../src/study/service'
import type { StudyUnit } from '../src/shared/study'

const DOC_ID = randomUUID()
let root: string
let db: AppDatabase
let settings: SettingsStore

const PLAN = {
  title: '光合作用',
  subject: '生物',
  overview: '这份材料讲光合作用的场所和色素。',
  opening: '我们从第 12 页的叶绿体开始。',
  units: [{
    title: '光合作用的场所',
    source: '第 12 页',
    minutes: 6,
    keyPoints: ['叶绿体是场所', '叶绿素吸收光能'],
    segments: [
      { source: '光合作用发生在叶绿体。', explain: '先看场所：叶绿体是进行光合作用的地方。', check: '为什么场所是叶绿体？' },
      { source: '叶绿体里的叶绿素吸收光能。', explain: '再看色素：叶绿素负责吸光，但它不是场所本身。', check: '叶绿体和叶绿素是一回事吗？' },
    ],
  }],
}

function configure() {
  settings.save({
    libreOfficePath: null,
    ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'k' },
  })
}

function seedDocument() {
  db.run('INSERT INTO documents(id, display_name, created_at) VALUES (?, ?, ?)', DOC_ID, '光合作用课件', '2026-11-17T10:00:00.000Z')
  db.run(
    `INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    versionId, DOC_ID, 'a'.repeat(64), 'pdf', 10, 'originals/a.pdf', 'ready', 'test', '2026-11-17T10:00:00.000Z',
  )
  seedPage(11, '光合作用发生在叶绿体。叶绿体里的叶绿素吸收光能。', [0.12, 0.2, 0.5, 0.12])
}

let versionId: string

function seedPage(ordinal: number, text: string, bbox?: [number, number, number, number]) {
  const pageId = randomUUID()
  db.run(
    `INSERT INTO pages(id, document_version_id, ordinal, source_kind, source_number, image_relpath, width, height, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    pageId, versionId, ordinal, 'pdf', ordinal + 1, 'artifacts/page.png', 1000, 1414, 'ready',
  )
  db.run(
    `INSERT INTO blocks(id, document_version_id, page_id, ordinal, kind, text, locator_json, extraction_method, review_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), versionId, pageId, 0, 'page_text', text, bbox ? JSON.stringify({ bbox }) : '{}', 'pdf-text', 'unverified',
  )
}

function seedSession(subject: string, title: string, courseId: string | null = null): string {
  const id = randomUUID()
  db.run(
    `INSERT INTO study_sessions(
      id, request_id, document_version_id, course_id, title, subject, source_name, overview, outline_json,
      habits_json, warnings_json, truncated, material_chars, material_chunks, status, summary_json,
      teacher_snapshot_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, randomUUID(), versionId, courseId, title, subject, '光合作用课件', '这份材料讲光合作用的场所。',
    JSON.stringify(['光合作用的场所']),
    JSON.stringify({ name: '小明', pace: 'slow', style: 'story', minutes: 25, window: 'evening', avoid: 'long' }),
    '[]', 0, 500, 1, 'ready', '', '', '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:00.000Z',
  )
  return id
}

function seedUnit(sessionId: string) {
  db.run(
    `INSERT INTO study_units(id, session_id, ordinal, title, source, minutes, key_points_json, segments_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), sessionId, 0, '光合作用的场所', '第 12 页', 6,
    JSON.stringify(['叶绿体是场所', '叶绿素吸收光能']),
    JSON.stringify([
      { source: '光合作用发生在叶绿体。', explain: '先看场所：叶绿体是进行光合作用的地方。', check: '为什么场所是叶绿体？' },
      { source: '叶绿体里的叶绿素吸收光能。', explain: '再看色素：叶绿素负责吸光，但它不是场所本身。', check: '叶绿体和叶绿素是一回事吗？' },
    ]),
  )
}

function service(fetchImpl: typeof fetch) {
  return new StudyService({
    db,
    settings,
    images: {} as never,
    habits: () => ({ name: '小明', pace: 'slow', style: 'story', minutes: 25, window: 'evening', avoid: 'long' }),
    fetchImpl,
  })
}

function fakeFetch(chatContent = '先看第 12 页这句话：光合作用发生在叶绿体。它说明场所是叶绿体。') {
  const mock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
    const system = String(body.messages[0]?.content ?? '')
    const content = system.includes('课程设计师')
      ? JSON.stringify(PLAN)
      : system.includes('课件阅读器')
        ? JSON.stringify({
            range: '第 12 页',
            topics: ['光合作用的场所'],
            keyPoints: ['叶绿体是场所'],
            quotes: ['光合作用发生在叶绿体。'],
            formulas: [],
            examples: [],
            pitfalls: [],
          })
        : chatContent
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return mock as unknown as typeof fetch
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-073-'))
  db = AppDatabase.open(path.join(root, 'library.sqlite'))
  migrate(db)
  versionId = randomUUID()
  settings = new SettingsStore(path.join(root, 'settings.json'))
  configure()
  seedDocument()
})

afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('0.7.3 schema 与课程分组', () => {
  it('schema 升到 14，课程、课件归属和消息引用都有列', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(14)
    const courseColumns = db.all<{ name: string }>('PRAGMA table_info(study_courses)').map((row) => row.name)
    expect(courseColumns).toContain('sort_order')
    const sessionColumns = db.all<{ name: string }>('PRAGMA table_info(study_sessions)').map((row) => row.name)
    expect(sessionColumns).toContain('course_id')
    const messageColumns = db.all<{ name: string }>('PRAGMA table_info(study_messages)').map((row) => row.name)
    expect(messageColumns).toContain('citations_json')
  })

  it('旧会话按 subject 回填课程，空 subject 归未分类', () => {
    const a = seedSession('线性代数', '正交基')
    const b = seedSession('线性代数', '对称矩阵')
    const c = seedSession('', '没写科目')
    backfillStudyCourses(db)
    const courses = db.all<{ name: string }>('SELECT name FROM study_courses ORDER BY sort_order, name')
    expect(courses.map((row) => row.name)).toEqual(['线性代数', '未分类'])
    const assigned = db.all<{ id: string; course_id: string }>('SELECT id, course_id FROM study_sessions ORDER BY created_at')
    expect(assigned.find((row) => row.id === a)?.course_id).toBeTruthy()
    expect(assigned.find((row) => row.id === b)?.course_id).toBe(assigned.find((row) => row.id === a)?.course_id)
    expect(assigned.find((row) => row.id === c)?.course_id).toBeTruthy()
  })
})

describe('0.7.3 课程 CRUD 与一份课件一个对话', () => {
  it('课程可建、改名、排序；删课程会带走课件会话和用量', async () => {
    const app = service(fakeFetch())
    const first = await app.createCourse({ name: '线性代数' })
    const second = await app.createCourse({ name: '概率论' })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    const linear = first.data.items.find((item) => item.name === '线性代数')
    const probability = second.data.items.find((item) => item.name === '概率论')
    expect(linear && probability).toBeTruthy()

    const renamed = await app.renameCourse({ courseId: linear!.courseId, name: '线代' })
    expect(renamed.ok).toBe(true)
    if (renamed.ok) expect(renamed.data.items.some((item) => item.name === '线代')).toBe(true)

    const reordered = await app.reorderCourses({ ids: [probability!.courseId, linear!.courseId] })
    expect(reordered.ok).toBe(true)
    if (reordered.ok) expect(reordered.data.items[0]?.name).toBe('概率论')

    const sessionId = seedSession('线代', '正交基', linear!.courseId)
    seedUnit(sessionId)
    const store = new StudyStore(db)
    store.insertUsage({
      sessionId, documentVersionId: versionId, kind: 'chat',
      promptTokens: 100, cachedTokens: 50, cacheMissTokens: 50,
      completionTokens: 10, reasoningTokens: 0, providerReported: true,
      model: 'deepseek-flash', createdAt: '2026-11-17T10:01:00.000Z',
    })
    const deleted = await app.deleteCourse({ courseId: linear!.courseId })
    expect(deleted.ok).toBe(true)
    if (deleted.ok) expect(deleted.data.items.some((item) => item.courseId === linear!.courseId)).toBe(false)
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM study_sessions WHERE id = ?', sessionId)?.count).toBe(0)
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM ai_usage WHERE session_id = ?', sessionId)?.count).toBe(0)
  })

  it('开课时可以指定课程，详情带回 courseId，消息仍是一串', async () => {
    const app = service(fakeFetch())
    const createdCourse = await app.createCourse({ name: '生物' })
    expect(createdCourse.ok).toBe(true)
    if (!createdCourse.ok) return
    const courseId = createdCourse.data.items[0]!.courseId
    const created = await app.create({
      requestId: randomUUID(),
      documentVersionId: versionId,
      title: '光合作用课件',
      courseId,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.courseId).toBe(courseId)
    expect(created.data.units).toHaveLength(1)
    expect(created.data.messages).toHaveLength(1)
    expect(created.data.messages[0]?.citations).toEqual([])
  })
})

describe('0.7.3 对照讲义引用', () => {
  it('老师回答提到第 12 页时，citation 落库并带原句和 bbox', async () => {
    const app = service(fakeFetch())
    const created = await app.create({ requestId: randomUUID(), documentVersionId: versionId, title: '光合作用课件' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sent = await app.send({ sessionId: created.data.sessionId, content: '为什么是叶绿体？', unitOrdinal: 0 })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    const last = sent.data.messages.at(-1)
    expect(last?.role).toBe('assistant')
    expect(last?.citations).toHaveLength(1)
    expect(last?.citations[0]?.pageNumber).toBe(12)
    expect(last?.citations[0]?.quote).toContain('光合作用发生在叶绿体')
    expect(last?.citations[0]?.bbox).toEqual([0.12, 0.2, 0.5, 0.12])

    const stored = db.get<{ citations_json: string }>(
      'SELECT citations_json FROM study_messages WHERE id = ?',
      last!.id,
    )
    expect(stored?.citations_json).not.toBe('[]')
  })

  it('回答没有自报页码时，用当前讲原句匹配页码', async () => {
    const app = service(fakeFetch('叶绿体是场所，叶绿素只是色素。'))
    const created = await app.create({ requestId: randomUUID(), documentVersionId: versionId, title: '光合作用课件' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sent = await app.send({ sessionId: created.data.sessionId, content: '再讲一次', unitOrdinal: 0 })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    expect(sent.data.messages.at(-1)?.citations[0]?.pageNumber).toBe(12)
  })

  it('扫描页 OCR 是乱码时，引用原句用讲稿校对文本，找不到逐字匹配就不画框', async () => {
    seedPage(1, '17/E = 1(B) = 2B = B2 = ab, + azbz + ... + anbn / F = arc(0)1 cost & BE.d(B, B) = 0151', [0.1, 0.1, 0.5, 0.2])
    const app = service(fakeFetch('对照第 2 页，内积的式子是逐项相乘再相加。'))
    const created = await app.create({ requestId: randomUUID(), documentVersionId: versionId, title: '内积与正交' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    db.run(
      'UPDATE study_units SET source = ?, segments_json = ? WHERE session_id = ?',
      '第 2 页：1(α, β) = α₁β₁ + α₂β₂ + … + αₙβₙ',
      JSON.stringify([{ source: '1(α, β) = α₁β₁ + α₂β₂ + … + αₙβₙ', explain: '先看内积定义。', check: '' }]),
      created.data.sessionId,
    )
    const sent = await app.send({ sessionId: created.data.sessionId, content: '这一页的式子怎么读？', unitOrdinal: 0 })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    const citation = sent.data.messages.at(-1)?.citations[0]
    expect(citation?.pageNumber).toBe(2)
    expect(citation?.quote).toContain('α₁β₁')
    expect(citation?.bbox).toBeNull()
    expect(citation?.blockId).toBeNull()
  })

  it('提示词带当前讲页码与原句，并把“先指页再解释”写进 system', async () => {
    const fetchImpl = fakeFetch()
    const app = service(fetchImpl)
    const created = await app.create({ requestId: randomUUID(), documentVersionId: versionId, title: '光合作用课件' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await app.send({ sessionId: created.data.sessionId, content: '为什么是叶绿体？', unitOrdinal: 0 })
    const calls = (fetchImpl as unknown as { mock: { calls: Array<[unknown, RequestInit]> } }).mock.calls
    const chatCall = JSON.parse(String(calls.at(-1)?.[1]?.body)) as { messages: Array<{ content: string }> }
    expect(chatCall.messages[1]?.content).toContain('当前讲的讲义页')
    expect(chatCall.messages[1]?.content).toContain('第 12 页')

    // 独立构建再锁一次契约，避免只依赖 mock 的调用顺序。
    const unit: StudyUnit = {
      id: randomUUID(),
      ordinal: 0,
      title: '光合作用的场所',
      source: '第 12 页',
      minutes: 6,
      keyPoints: ['叶绿体是场所'],
      segments: [{ source: '光合作用发生在叶绿体。', explain: '先看场所。', check: '' }],
    }
    const prompt = (await import('../src/study/prompt')).buildStudyChatPrompt({
      overview: '这份材料讲光合作用。',
      outline: ['光合作用的场所'],
      units: [unit],
      unit,
      messages: [],
      question: '为什么是叶绿体？',
      habits: { name: '小明', pace: 'slow', style: 'story', minutes: 25, window: 'evening', avoid: 'long' },
      slide: { pages: [12], excerpts: [{ page: 12, text: '光合作用发生在叶绿体。叶绿体里的叶绿素吸收光能。' }] },
    })
    expect(prompt.system).toContain('先指出')
    expect(prompt.user).toContain('当前讲的讲义页')
    expect(prompt.user).toContain('第 12 页')
    expect(prompt.user).toContain('光合作用发生在叶绿体')
  })
})

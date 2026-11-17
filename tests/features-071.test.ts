import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../src/storage/database'
import { CURRENT_SCHEMA_VERSION, migrate } from '../src/storage/migrate'
import { StudyStore, type StudyArtifactRow } from '../src/storage/studyStore'
import { SettingsStore } from '../src/providers/settings'
import { StudyService } from '../src/study/service'
import { routeStudySkill, routeStudyToolIntent, searchQueryFrom, searchStudyUnits, outlineStudyUnits, teachbackAnswerFrom } from '../src/study/tools'
import type { StudySkill, StudyUnit } from '../src/shared/study'

let root: string
let db: AppDatabase
let settings: SettingsStore
let sessionId: string
let versionId: string

const DOC_ID = randomUUID()
const UNIT_1 = randomUUID()
const UNIT_2 = randomUUID()

function seedSession() {
  sessionId = randomUUID()
  db.run('INSERT INTO documents(id, display_name, created_at) VALUES (?, ?, ?)', DOC_ID, '存储器课件', '2026-11-17T10:00:00.000Z')
  db.run(
    `INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    versionId, DOC_ID, 'a'.repeat(64), 'pdf', 10, 'originals/a.pdf', 'ready', 'test', '2026-11-17T10:00:00.000Z',
  )
  db.run(
    `INSERT INTO study_sessions(
      id, request_id, document_version_id, title, subject, source_name, overview, outline_json,
      habits_json, warnings_json, truncated, material_chars, material_chunks, status, summary_json,
      teacher_snapshot_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sessionId, randomUUID(), versionId, '存储器', '计算机组成', '存储器课件',
    '这门课讲存储器的层次、SRAM/DRAM 与地址映射。',
    JSON.stringify(['存储器的层次', 'SRAM 与 DRAM']),
    JSON.stringify({ name: '小明', pace: 'slow', style: 'story', minutes: 25, window: 'evening', avoid: 'long' }),
    '[]', 0, 500, 1, 'ready', '', '', '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:00.000Z',
  )
  const units = [
    {
      id: UNIT_1,
      ordinal: 0,
      title: '存储器的层次',
      source: '第 1 页',
      minutes: 8,
      keyPoints: ['寄存器最快', '越靠近 CPU 越快越小'],
      segments: [
        { source: '存储器按层次组织，越靠近 CPU 越快、越小、越贵。', explain: '先看速度与容量的取舍。', check: '为什么缓存比内存小？' },
        { source: '寄存器在 CPU 内部，容量最小。', explain: '寄存器是离运算器最近的一层。', check: '寄存器为什么不做大？' },
      ],
    },
    {
      id: UNIT_2,
      ordinal: 1,
      title: 'SRAM 与 DRAM',
      source: '第 3 页',
      minutes: 10,
      keyPoints: ['SRAM 靠触发器', 'DRAM 靠电容', 'DRAM 需要刷新'],
      segments: [
        { source: 'SRAM 用触发器存储一位，速度快但面积大。', explain: '触发器是双稳态电路，不需要刷新。', check: 'SRAM 为什么不需要刷新？' },
        { source: 'DRAM 用电容存储电荷，需要周期性刷新。', explain: '电容会漏电，所以必须刷新。', check: 'DRAM 为什么必须刷新？' },
      ],
    },
  ]
  for (const unit of units) {
    db.run(
      `INSERT INTO study_units(id, session_id, ordinal, title, source, minutes, key_points_json, segments_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      unit.id, sessionId, unit.ordinal, unit.title, unit.source, unit.minutes,
      JSON.stringify(unit.keyPoints), JSON.stringify(unit.segments),
    )
  }
}

function fakeFetch(onPrompt: (system: string, user: string) => string) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> }
    const system = String(body.messages?.[0]?.content ?? '')
    const user = String(body.messages?.[1]?.content ?? '')
    return new Response(JSON.stringify({
      choices: [{ message: { content: onPrompt(system, user) } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
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

function units(): StudyUnit[] {
  return new StudyStore(db).listUnits(sessionId).map((row) => ({
    id: row.id,
    ordinal: Number(row.ordinal),
    title: row.title,
    source: row.source,
    minutes: Number(row.minutes),
    keyPoints: JSON.parse(row.key_points_json) as string[],
    segments: JSON.parse(row.segments_json) as StudyUnit['segments'],
  }))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-071-'))
  db = AppDatabase.open(path.join(root, 'library.sqlite'))
  migrate(db)
  versionId = randomUUID()
  settings = new SettingsStore(path.join(root, 'settings.json'))
  settings.save({
    libreOfficePath: null,
    ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'k' },
  })
  seedSession()
})

afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('0.7.1 技能路由', () => {
  it('7 个技能都能被显式选择', () => {
    const skills: Array<Exclude<StudySkill, 'auto'>> = ['diagnose', 'explain', 'socratic', 'quiz', 'error', 'review', 'teachback']
    for (const skill of skills) expect(routeStudySkill('随便问一句', skill)).toBe(skill)
  })

  it('auto 从自然语言里只选一个主技能', () => {
    expect(routeStudySkill('带我学，先问我')).toBe('diagnose')
    expect(routeStudySkill('考考我这一讲')).toBe('quiz')
    expect(routeStudySkill('我讲给你听')).toBe('teachback')
    expect(routeStudySkill('我哪里错了')).toBe('error')
    expect(routeStudySkill('安排一下复习')).toBe('review')
    expect(routeStudySkill('多问我几个为什么')).toBe('socratic')
    expect(routeStudySkill('这一句是什么意思')).toBe('explain')
  })

  it('自然语言先选一次性工具；普通问题仍然走讲解', () => {
    expect(routeStudyToolIntent('考考我这一讲')).toBe('quiz')
    expect(routeStudyToolIntent('题测一下')).toBe('quiz')
    expect(routeStudyToolIntent('列一下复习大纲')).toBe('outline')
    expect(routeStudyToolIntent('总结这一讲')).toBe('summary')
    expect(routeStudyToolIntent('总结')).toBe('summary')
    expect(routeStudyToolIntent('找原文：DRAM 刷新？')).toBe('search')
    expect(routeStudyToolIntent('读原文：DRAM 刷新？')).toBe('search')
    expect(searchQueryFrom('找原文：DRAM 刷新？')).toBe('DRAM 刷新')
    expect(routeStudyToolIntent('我讲给你听：DRAM 是电容，靠刷新保持数据，因为电容会漏电。')).toBe('teachback')
    expect(teachbackAnswerFrom('我讲给你听：DRAM 是电容，靠刷新保持数据，因为电容会漏电。')).toContain('DRAM')
    expect(routeStudyToolIntent('这一句是什么意思')).toBeNull()
  })

  it('study.send 说“考考我”时直接落题测 artifact，不陪聊一遍', async () => {
    const app = service(fakeFetch(() => JSON.stringify({
      questions: [{ prompt: 'DRAM 为什么需要刷新？', hint: '从电容漏电想。', source: 'DRAM 用电容存储电荷。' }],
    })))
    const sent = await app.send({ sessionId, content: '考考我这一讲', unitOrdinal: 1 })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    expect(sent.data.artifacts.some((item) => item.kind === 'quiz' && item.scope === 'unit:1')).toBe(true)
    expect(sent.data.messages.at(-1)?.content).toContain('我出了 1 道题')
  })

  it('study.send 默认 direct/auto；非法 skill 直接拒绝', async () => {
    const app = service(fakeFetch((system) => system.includes('私教') ? '这是讲解。' : '{}'))
    const invalid = await app.send({ sessionId, content: '讲一下', skill: 'function-call' })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('INVALID_ARGUMENT')

    const sent = await app.send({ sessionId, content: '这一句是什么意思' })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    expect(sent.data.messages.at(-1)?.content).toContain('这是讲解')
  })
})

describe('0.7.1 工具与落点', () => {
  it('search 只在当前课程里找；没命中明确说没找到', () => {
    const matches = searchStudyUnits(units(), 'DRAM')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]?.unitOrdinal).toBe(1)
    expect(matches[0]?.source).toContain('电容')
    expect(searchStudyUnits(units(), '完全不存在的东西')).toEqual([])
  })

  it('outline 只从课程结构抽；单讲只返回一条', () => {
    const all = outlineStudyUnits(units())
    expect(all).toHaveLength(2)
    expect(all[1]?.points).toEqual(['SRAM 靠触发器', 'DRAM 靠电容', 'DRAM 需要刷新'])
    const one = outlineStudyUnits(units(), 1)
    expect(one).toHaveLength(1)
    expect(one[0]?.title).toBe('SRAM 与 DRAM')
  })

  it('study_artifacts：同 kind/scope 更新不重复，删除课程级联删除 artifact', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(15)
    const store = new StudyStore(db)
    const first: StudyArtifactRow = {
      id: randomUUID(), session_id: sessionId, kind: 'outline', scope: 'course',
      title: '课程大纲', body_json: JSON.stringify({ items: [] }),
      created_at: '2026-11-17T10:00:00.000Z', updated_at: '2026-11-17T10:00:00.000Z',
    }
    store.upsertArtifact(first)
    store.upsertArtifact({ ...first, id: randomUUID(), title: '更新后的大纲', body_json: JSON.stringify({ items: [1] }) })
    const listed = store.listArtifacts(sessionId)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.title).toBe('更新后的大纲')
    store.deleteSession(sessionId)
    expect(store.listArtifacts(sessionId)).toEqual([])
  })

  it('search/outline 工具落 artifact，detail 能读到', async () => {
    const app = service(fakeFetch(() => ''))
    const search = await app.tool({ sessionId, tool: 'search', query: 'DRAM' })
    expect(search.ok).toBe(true)
    if (!search.ok) return
    expect(search.data.artifacts.some((item) => item.kind === 'search' && item.body.matches?.length)).toBe(true)

    const missing = await app.tool({ sessionId, tool: 'search', query: '完全不存在的词' })
    expect(missing.ok).toBe(true)
    if (!missing.ok) return
    const artifact = missing.data.artifacts.find((item) => item.kind === 'search')
    expect(artifact?.body.matches).toEqual([])
    expect(artifact?.body.message).toContain('没找到')

    const outline = await app.tool({ sessionId, tool: 'outline', unitOrdinal: 1 })
    expect(outline.ok).toBe(true)
    if (!outline.ok) return
    const outlineArtifact = outline.data.artifacts.find((item) => item.kind === 'outline' && item.scope === 'unit:1')
    expect(outlineArtifact?.body.items).toHaveLength(1)
    expect(outlineArtifact?.body.items?.[0]?.title).toBe('SRAM 与 DRAM')
  })

  it('summary 生成后落库，第二次更新同一条', async () => {
    const app = service(fakeFetch((system) => system.includes('学习总结') ? '这一讲把存储层次和 SRAM/DRAM 的取舍讲清了。' : '{}'))
    const first = await app.tool({ sessionId, tool: 'summary', unitOrdinal: 1 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const firstArtifact = first.data.artifacts.find((item) => item.kind === 'summary' && item.scope === 'unit:1')
    expect(firstArtifact?.body.text).toContain('存储层次')
    expect(firstArtifact?.body.citations?.[0]?.pageNumber).toBe(3)

    const second = await app.tool({ sessionId, tool: 'summary', unitOrdinal: 1 })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.artifacts.filter((item) => item.kind === 'summary' && item.scope === 'unit:1')).toHaveLength(1)
  })

  it('quiz 出 1–3 道开放题，题面不夹答案；提交后判分写回同一 artifact', async () => {
    const app = service(fakeFetch((system) => {
      if (system.includes('出题')) {
        return JSON.stringify({
          questions: [
            { prompt: '为什么 DRAM 需要刷新？', hint: '从电容和漏电想。', source: 'DRAM 用电容存储电荷，需要周期性刷新。' },
            { prompt: 'SRAM 和 DRAM 各牺牲了什么？', hint: '速度和面积。', source: 'SRAM 用触发器存储一位，速度快但面积大。' },
          ],
        })
      }
      if (system.includes('判题')) {
        return JSON.stringify({
          feedback: '第一题抓住了漏电，第二题漏了面积代价。',
          gaps: ['SRAM 的面积代价没有说'],
          results: [
            { index: 1, correct: true, explain: '漏电和刷新讲对了。' },
            { index: 2, correct: false, explain: 'SRAM 的面积代价没有说。' },
          ],
        })
      }
      return '{}'
    }))
    const quiz = await app.tool({ sessionId, tool: 'quiz', unitOrdinal: 1 })
    expect(quiz.ok).toBe(true)
    if (!quiz.ok) return
    const artifact = quiz.data.artifacts.find((item) => item.kind === 'quiz' && item.scope === 'unit:1')
    expect(artifact?.body.questions?.length).toBe(2)
    expect(artifact?.body.questions?.[0]).not.toHaveProperty('answer')
    expect(artifact?.body.questions?.[0]?.pageNumber).toBe(3)
    expect(artifact?.body.graded).toBe(false)

    const graded = await app.tool({
      sessionId,
      tool: 'quiz-grade',
      unitOrdinal: 1,
      answers: [
        { questionId: artifact!.body.questions![0]!.id, answer: '电容会漏电，所以要定期补充电荷。' },
        { questionId: artifact!.body.questions![1]!.id, answer: 'SRAM 快，DRAM 慢。' },
      ],
    })
    expect(graded.ok).toBe(true)
    if (!graded.ok) return
    const updated = graded.data.artifacts.find((item) => item.kind === 'quiz' && item.scope === 'unit:1')
    expect(updated?.body.graded).toBe(true)
    expect(updated?.body.feedback).toContain('漏电')
    expect(updated?.body.questions?.length).toBe(2)
    expect(updated?.body.questions?.[1]?.pageNumber).toBe(3)
    expect(updated?.body.results).toHaveLength(2)
    expect(updated?.body.results?.[1]?.explain).toContain('面积代价')
    const miss = db.get<{ page_number: number | null }>(
      'SELECT page_number FROM study_misses WHERE session_id = ? AND question_id = ?',
      sessionId, artifact!.body.questions![1]!.id,
    )
    expect(miss?.page_number).toBe(3)
  })

  it('题测可以只答一题就判，未答的题保留可继续答', async () => {
    const app = service(fakeFetch((system, user) => {
      if (system.includes('出题')) {
        return JSON.stringify({
          questions: [
            { prompt: '为什么 DRAM 需要刷新？', hint: '从电容和漏电想。', source: 'DRAM 用电容存储电荷，需要周期性刷新。' },
            { prompt: 'SRAM 和 DRAM 各牺牲了什么？', hint: '速度和面积。', source: 'SRAM 用触发器存储一位，速度快但面积大。' },
          ],
        })
      }
      if (system.includes('判题')) {
        const answered = user.includes('第 2 题') ? 2 : 1
        return JSON.stringify({
          feedback: answered === 1 ? '第一题抓住了漏电。' : '第二题说到了面积代价。',
          gaps: [],
          results: [{ index: answered, correct: true, explain: `第 ${answered} 题答对了。` }],
        })
      }
      return '{}'
    }))
    const quiz = await app.tool({ sessionId, tool: 'quiz', unitOrdinal: 1 })
    expect(quiz.ok).toBe(true)
    if (!quiz.ok) return
    const artifact = quiz.data.artifacts.find((item) => item.kind === 'quiz' && item.scope === 'unit:1')
    const questions = artifact?.body.questions ?? []
    expect(questions).toHaveLength(2)

    const first = await app.tool({
      sessionId,
      tool: 'quiz-grade',
      unitOrdinal: 1,
      answers: [{ questionId: questions[0].id, answer: '电容会漏电，所以要定期补充电荷。' }],
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const afterFirst = first.data.artifacts.find((item) => item.kind === 'quiz' && item.scope === 'unit:1')
    expect(afterFirst?.body.answers).toHaveLength(1)
    expect(afterFirst?.body.results).toHaveLength(1)
    expect(afterFirst?.body.graded).toBe(false)
    expect(afterFirst?.body.results?.[0]?.index).toBe(1)

    const second = await app.tool({
      sessionId,
      tool: 'quiz-grade',
      unitOrdinal: 1,
      answers: [{ questionId: questions[1].id, answer: 'SRAM 快但面积大，DRAM 慢但面积小。' }],
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const afterSecond = second.data.artifacts.find((item) => item.kind === 'quiz' && item.scope === 'unit:1')
    expect(afterSecond?.body.answers).toHaveLength(2)
    expect(afterSecond?.body.results).toHaveLength(2)
    expect(afterSecond?.body.graded).toBe(true)
  })

  it('teachback 空答案拒绝；有缺口时写入 gaps', async () => {
    const app = service(fakeFetch((system) => system.includes('复述') ? JSON.stringify({
      feedback: '你讲清了 DRAM 的电容，但没讲 SRAM 的触发器。',
      covered: ['DRAM 用电容'],
      gaps: ['SRAM 用触发器'],
    }) : '{}'))
    const empty = await app.tool({ sessionId, tool: 'teachback', unitOrdinal: 1, answer: '短' })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error.code).toBe('INVALID_ARGUMENT')

    const result = await app.tool({ sessionId, tool: 'teachback', unitOrdinal: 1, answer: 'DRAM 是电容，靠刷新保持数据，因为电容会漏电。' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const artifact = result.data.artifacts.find((item) => item.kind === 'teachback' && item.scope === 'unit:1')
    expect(artifact?.body.gaps).toContain('SRAM 用触发器')
  })
})

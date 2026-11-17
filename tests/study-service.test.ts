import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore } from '../src/providers/settings'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { TeacherService } from '../src/teaching/teacherService'

const DOC_ID = randomUUID()
const VERSION_ID = randomUUID()
const PAGE_ID = randomUUID()

let db: AppDatabase
let root: string
let settings: SettingsStore

beforeEach(() => {
  db = AppDatabase.open(':memory:')
  migrate(db)
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-study-test-'))
  settings = new SettingsStore(path.join(root, 'settings.json'))
  db.run('INSERT INTO documents(id, display_name, created_at) VALUES (?, ?, ?)', DOC_ID, '光合作用课件', '2026-11-16T00:00:00.000Z')
  db.run(
    `INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    VERSION_ID, DOC_ID, 'a'.repeat(64), 'pdf', 4, 'originals/a.pdf', 'ready', 'test', '2026-11-16T00:00:00.000Z',
  )
  db.run(
    `INSERT INTO pages(id, document_version_id, ordinal, source_kind, source_number, image_relpath, width, height, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    PAGE_ID, VERSION_ID, 1, 'pdf', 1, 'artifacts/page.png', 100, 100, 'ready',
  )
  db.run(
    `INSERT INTO blocks(id, document_version_id, page_id, ordinal, kind, text, locator_json, extraction_method, review_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), VERSION_ID, PAGE_ID, 0, 'page_text', '光合作用发生在叶绿体。CO2 + H2O -> Glucose。', '{}', 'pdf-text', 'unverified',
  )
})

function configure() {
  settings.save({
    libreOfficePath: null,
    ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'k' },
  })
}

const PLAN = {
  title: '光合作用',
  subject: '生物',
  overview: '这页材料讲光合作用的场所和简化反应式。',
  opening: '我们从叶绿体开始。',
  units: [{
    title: '光合作用的场所',
    source: '第 1 页',
    minutes: 6,
    keyPoints: ['叶绿体是场所'],
    segments: [{
      source: '光合作用发生在叶绿体。',
      explain: '先看场所：叶绿体是绿色植物进行光合作用的地方。',
      check: '为什么说场所是叶绿体？',
    }, {
      source: '光合作用发生在叶绿体。',
      explain: '再抠一个词：场所不是色素。叶绿体是细胞里的结构，叶绿素只是里面的色素。',
      check: '叶绿体和叶绿素是一回事吗？',
    }],
  }],
}

const SUMMARY = {
  overview: '你已经能说出光合作用的场所和原料。',
  mastered: ['叶绿体是场所'],
  weak: ['反应式还不完整'],
  pitfalls: ['不要把简化式当成完整总反应式'],
  next: ['补上 O2 与配平'],
}

const NOTE = {
  summary: '这次课讲通了场所，但反应式还没配平。',
  worked: ['叶绿体是光合作用的场所'],
  stuck: ['反应式还不完整'],
  next: ['下次先补 O2 与配平'],
  memories: [
    { kind: 'strategy', subject: '生物', concept: '反应式', statement: '先看一个配平例子，再让学生自己配。' },
  ],
}

function configuredService(fetchImpl: typeof fetch, habits = {
  name: '小明', pace: 'slow' as const, style: 'define' as const, minutes: 25 as const, window: 'evening' as const, avoid: 'long' as const,
}, teacher?: TeacherService) {
  return import('../src/study/service').then(({ StudyService }) =>
    new StudyService({
      db,
      settings,
      habits: () => habits,
      teacher,
      images: {
        vision: vi.fn(async () => ({
          ok: true as const,
          requestId: 'r',
          data: { reading: { id: 'v', documentVersionId: VERSION_ID, pageId: PAGE_ID, kind: 'vision' as const, text: 'AI 图知识点', engine: 'deepseek-flash', createdAt: 'x' } },
        })),
        ocr: vi.fn(async () => ({
          ok: true as const,
          requestId: 'r',
          data: { reading: { id: 'o', documentVersionId: VERSION_ID, pageId: PAGE_ID, kind: 'ocr' as const, text: 'OCR 兜底', engine: 'windows-ocr', createdAt: 'x' } },
        })),
      } as never,
      fetchImpl,
    }),
  )
}

function fakeFetch() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const system = String(body.messages?.[0]?.content ?? '')
    if (system.includes('课件阅读器')) {
      const user = String(body.messages?.[1]?.content ?? '')
      const range = /页码范围：(.+?)。/.exec(user)?.[1] ?? '第 1 段'
      const DIGEST = {
        range,
        topics: ['光合作用的场所'],
        keyPoints: ['叶绿体是光合作用的场所', '光能转成化学能'],
        formulas: ['CO2 + H2O -> Glucose'],
        examples: [],
        pitfalls: ['叶绿体不是叶绿素'],
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(DIGEST) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (system.includes('课程设计')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(PLAN) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (system.includes('学习分析')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(SUMMARY) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (system.includes('老师手记')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(NOTE) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '这句的关键是叶绿体。你问的正是场所。' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

describe('AI 私教学习会话', () => {
  it('完整读取整份材料，按习惯拆成逐句讲稿并保存开场', async () => {
    configure()
    const fetchImpl = fakeFetch()
    const service = await configuredService(fetchImpl as unknown as typeof fetch)
    const created = await service.create({
      requestId: randomUUID(),
      documentVersionId: VERSION_ID,
      title: '光合作用课件',
    })

    expect(created.ok).toBe(true)
    if (created.ok) {
      expect(created.data.title).toBe('光合作用')
      expect(created.data.overview).toContain('光合作用')
      expect(created.data.units).toHaveLength(1)
      expect(created.data.units[0].segments[0].source).toContain('光合作用发生在叶绿体')
      expect(created.data.messages).toHaveLength(1)
      expect(created.data.messages[0].role).toBe('assistant')
      expect(created.data.messages[0].content).toContain('叶绿体')
      expect(created.data.status).toBe('ready')
    }
    const planCall = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(planCall.messages[0].content).toContain('课程设计')
    expect(planCall.messages[1].content).toContain('小明')
    expect(planCall.messages[1].content).toContain('光合作用发生在叶绿体')
    expect(planCall.messages[1].content).toContain('逐句')
  })

  it('多轮对话会带上课程、本讲和已有消息，并保存用户与老师回复', async () => {
    configure()
    const fetchImpl = fakeFetch()
    const service = await configuredService(fetchImpl as unknown as typeof fetch)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '光合作用课件' })
    expect(created.ok).toBe(true)
    const sessionId = created.ok ? created.data.sessionId : ''
    const sent = await service.send({
      sessionId,
      content: '为什么一定是叶绿体？',
      unitOrdinal: 0,
    })
    expect(sent.ok).toBe(true)
    if (sent.ok) {
      expect(sent.data.messages).toHaveLength(3)
      expect(sent.data.messages[1].content).toContain('为什么')
      expect(sent.data.messages[2].content).toContain('叶绿体')
    }
    const chatCall = JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body))
    expect(chatCall.messages[0].content).toContain('私教')
    expect(chatCall.messages[1].content).toContain('光合作用发生在叶绿体')
    expect(chatCall.messages[1].content).toContain('为什么一定是叶绿体')
  })

  it('最后生成结构化学习分析总结并持久化', async () => {
    configure()
    const fetchImpl = fakeFetch()
    const service = await configuredService(fetchImpl as unknown as typeof fetch)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '光合作用课件' })
    expect(created.ok).toBe(true)
    const sessionId = created.ok ? created.data.sessionId : ''
    await service.send({ sessionId, content: '我还是不懂', unitOrdinal: 0 })
    const finished = await service.finish({ sessionId })

    expect(finished.ok).toBe(true)
    if (finished.ok) {
      expect(finished.data.status).toBe('finished')
      expect(finished.data.summary?.mastered).toContain('叶绿体是场所')
      expect(finished.data.summary?.weak).toContain('反应式还不完整')
      expect(finished.data.summary?.next).toContain('补上 O2 与配平')
    }
    const summaryCall = JSON.parse(String((fetchImpl.mock.calls.at(-1)?.[1] as RequestInit).body))
    expect(summaryCall.messages[0].content).toContain('学习分析')
    expect(summaryCall.messages[1].content).toContain('我还是不懂')
  })

  it('老师人格、档案和相关记忆进入开课/追问提示，下课时写入老师手记', async () => {
    configure()
    const fetchImpl = fakeFetch()
    const teacher = new TeacherService({ db, now: () => Date.parse('2026-11-17T10:00:00.000Z') })
    teacher.savePersona({ name: '周老师', pronoun: 'she', tone: 'warm-rigorous', boundaries: ['不替我思考'] })
    teacher.saveProfile({
      goal: '考试', level: '学过但忘', subjects: ['生物'], weeklyMinutes: 300, notes: '先给例子，再给定义',
    })
    teacher.memorySave({
      kind: 'misconception',
      subject: '生物',
      concept: '叶绿体',
      statement: '容易把叶绿体和叶绿素混为一谈',
      evidence: '上次课把色素说成场所',
      confidence: 0.9,
      userConfirmed: true,
    })
    const service = await configuredService(
      fetchImpl as unknown as typeof fetch,
      { name: '小明', pace: 'slow', style: 'define', minutes: 25, window: 'evening', avoid: 'long' },
      teacher,
    )
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '光合作用课件' })
    expect(created.ok).toBe(true)
    const sessionId = created.ok ? created.data.sessionId : ''

    const planCall = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(planCall.messages[1].content).toContain('周老师')
    expect(planCall.messages[1].content).toContain('容易把叶绿体和叶绿素混为一谈')
    expect(planCall.messages[1].content).toContain('先给例子，再给定义')

    await service.send({ sessionId, content: '叶绿素和叶绿体有什么区别？', unitOrdinal: 0 })
    const chatCall = JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body))
    expect(chatCall.messages[0].content).toContain('周老师')
    expect(chatCall.messages[1].content).toContain('容易把叶绿体和叶绿素混为一谈')

    const finished = await service.finish({ sessionId })
    expect(finished.ok).toBe(true)
    if (finished.ok) {
      expect(finished.data.summary?.mastered).toContain('叶绿体是场所')
      expect(finished.data.teacherNote?.summary).toContain('反应式')
      expect(finished.data.teacherNote?.stuck).toContain('反应式还不完整')
    }
    const noteCall = JSON.parse(String((fetchImpl.mock.calls.at(-1)?.[1] as RequestInit).body))
    expect(noteCall.messages[0].content).toContain('老师手记')
    expect(noteCall.messages[1].content).toContain('光合作用')
    const overview = teacher.overview()
    expect(overview.ok).toBe(true)
    if (overview.ok) {
      const observation = overview.data.memories.find((item) => item.concept === '反应式')
      expect(observation?.userConfirmed).toBe(false)
      expect(observation?.statement).toContain('配平')
      const source = observation
        ? db.get<{ source_session_id: string | null; source_document_version_id: string | null }>(
          'SELECT source_session_id, source_document_version_id FROM teacher_memory WHERE id = ?',
          observation.id,
        )
        : null
      expect(source?.source_session_id).toBe(sessionId)
      expect(source?.source_document_version_id).toBe(VERSION_ID)
    }
    const snapshot = db.get<{ teacher_snapshot_json: string }>(
      'SELECT teacher_snapshot_json FROM study_sessions WHERE id = ?',
      sessionId,
    )
    expect(snapshot?.teacher_snapshot_json).toContain('周老师')
  })

  it('老师手记生成失败不阻断学习总结', async () => {
    configure()
    const base = fakeFetch()
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const system = String(body.messages?.[0]?.content ?? '')
      if (system.includes('老师手记')) throw new Error('note model down')
      return base(url, init)
    })
    const teacher = new TeacherService({ db })
    const service = await configuredService(fetchImpl as unknown as typeof fetch, undefined, teacher)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '光合作用课件' })
    expect(created.ok).toBe(true)
    const sessionId = created.ok ? created.data.sessionId : ''
    const finished = await service.finish({ sessionId })

    expect(finished.ok).toBe(true)
    if (finished.ok) {
      expect(finished.data.summary?.mastered).toContain('叶绿体是场所')
      expect(finished.data.teacherNote).toBeNull()
    }
    expect(db.get<{ max: number }>('SELECT MAX(version) AS max FROM schema_migrations')?.max).toBe(15)
  })

  it('同一 requestId 重复创建不会再调用模型', async () => {
    configure()
    const fetchImpl = fakeFetch()
    const service = await configuredService(fetchImpl as unknown as typeof fetch)
    const requestId = randomUUID()
    const first = await service.create({ requestId, documentVersionId: VERSION_ID, title: '光合作用课件' })
    const second = await service.create({ requestId, documentVersionId: VERSION_ID, title: '光合作用课件' })
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) expect(second.data.sessionId).toBe(first.data.sessionId)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('第一次只给一句逐句稿时会自检并让模型重出，不把半成品落库', async () => {
    configure()
    const thin = {
      ...PLAN,
      units: [{ ...PLAN.units[0], segments: [PLAN.units[0].segments[0]] }],
    }
    let planCalls = 0
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const system = String(body.messages?.[0]?.content ?? '')
      if (system.includes('课程设计')) {
        planCalls += 1
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(planCalls === 1 ? thin : PLAN) } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const service = await configuredService(fetchImpl as unknown as typeof fetch)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '光合作用课件' })
    expect(created.ok).toBe(true)
    expect(planCalls).toBe(2)
    if (created.ok) expect(created.data.units[0].segments).toHaveLength(2)
  })

  it('图片页走 AI 视觉理解，整份材料不是只收文字块', async () => {
    configure()
    const imagePageId = randomUUID()
    db.run(
      `INSERT INTO pages(id, document_version_id, ordinal, source_kind, source_number, image_relpath, width, height, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      imagePageId, VERSION_ID, 2, 'image', null, 'artifacts/page2.png', 100, 100, 'ready',
    )
    const fetchImpl = fakeFetch()
    const service = await configuredService(fetchImpl as unknown as typeof fetch)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '光合作用课件' })
    expect(created.ok).toBe(true)
    const planCall = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(planCall.messages[1].content).toContain('AI 图知识点')
  })

  it('幻灯片页只要标了图片，也会先走 AI 视觉再进课程设计', async () => {
    configure()
    const slidePageId = randomUUID()
    db.run(
      `INSERT INTO pages(id, document_version_id, ordinal, source_kind, source_number, image_relpath, width, height, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      slidePageId, VERSION_ID, 2, 'slide', 2, 'artifacts/slide2.png', 1280, 720, 'ready',
    )
    db.run(
      `INSERT INTO blocks(id, document_version_id, page_id, ordinal, kind, text, locator_json, extraction_method, review_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(), VERSION_ID, slidePageId, 2, 'slide_text', '叶片把光能转成化学能。', '{}', 'pptx-xml', 'unverified',
    )
    db.run(
      `INSERT INTO blocks(id, document_version_id, page_id, ordinal, kind, text, locator_json, extraction_method, review_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(), VERSION_ID, slidePageId, 3, 'image_region', '', '{}', 'pptx-xml', 'needs_review',
    )
    const fetchImpl = fakeFetch()
    const service = await configuredService(fetchImpl as unknown as typeof fetch)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '光合作用课件' })
    expect(created.ok).toBe(true)
    const planCall = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(planCall.messages[1].content).toContain('AI 图知识点')
    expect(planCall.messages[1].content).toContain('叶片把光能转成化学能')
  })

  it('80 页材料不再截断：先逐段读懂，再据分段理解拆课，靠后页面不丢', async () => {
    configure()
    const pageText = `${'光合作用的知识点。'.repeat(150)}`
    for (let index = 0; index < 80; index += 1) {
      const pageId = randomUUID()
      db.run(
        `INSERT INTO pages(id, document_version_id, ordinal, source_kind, source_number, image_relpath, width, height, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        pageId, VERSION_ID, index + 2, 'slide', index + 2, null, 1280, 720, 'ready',
      )
      db.run(
        `INSERT INTO blocks(id, document_version_id, page_id, ordinal, kind, text, locator_json, extraction_method, review_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(), VERSION_ID, pageId, index + 4, 'slide_text', pageText, '{}', 'pptx-xml', 'unverified',
      )
    }
    const fetchImpl = fakeFetch()
    const service = await configuredService(fetchImpl as unknown as typeof fetch)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '光合作用课件' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.materialChars).toBeGreaterThan(100_000)
    expect(created.data.truncated).toBe(false)
    expect(created.data.materialChunks).toBeGreaterThan(1)
    const bodies = fetchImpl.mock.calls.map((call) => String((call[1] as RequestInit).body))
    // 每一段都真的读到了模型的眼里：分段理解的请求覆盖到最后一页。
    expect(bodies.slice(0, -1).join('\n')).toContain('【第 81 页 / 幻灯片】')
    const planBody = bodies[bodies.length - 1]!
    expect(planBody).toContain('分成')
    expect(planBody).toContain('逐段')
    expect(planBody).toContain('第 1 段')
  })

  it('80 页课件允许拆出超过 12 讲，最多 24 讲', async () => {
    configure()
    const units = Array.from({ length: 13 }, (_, index) => ({
      ...PLAN.units[0],
      title: `第 ${index + 1} 讲`,
      source: `第 ${index + 1} 页`,
    }))
    const plan = { ...PLAN, units }
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const system = String(body.messages?.[0]?.content ?? '')
      if (system.includes('课程设计')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const service = await configuredService(fetchImpl as unknown as typeof fetch)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '光合作用课件' })
    expect(created.ok).toBe(true)
    if (created.ok) expect(created.data.units).toHaveLength(13)
  })

  it('没有配置模型时不给开始，提示先配置', async () => {
    const service = await configuredService(fakeFetch() as unknown as typeof fetch)
    const result = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '光合作用课件' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('AI_NOT_CONFIGURED')
  })
})


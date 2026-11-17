import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore } from '../src/providers/settings'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { StudyService } from '../src/study/service'
import { buildStudyPlanPrompt } from '../src/study/prompt'
import { buildDigestPrompt, toChunks } from '../src/study/digest'
import { DEFAULT_HABITS } from '../src/teaching/habits'

const DOC_ID = randomUUID()
const VERSION_ID = randomUUID()

const PLAN = {
  title: '半导体存储器',
  subject: '计算机组成',
  overview: '这份讲义讲存储器的分类与寻址。',
  opening: '我们从存储层次开始。',
  units: [{
    title: '存储器分类',
    source: '第 1–3 段',
    minutes: 6,
    keyPoints: ['按位置分为内存与外存'],
    segments: [{
      source: '半导体存储器按位置可分为内存存储器与外存存储器。',
      explain: '先分清位置，再谈速度和容量。',
      check: '内存和外存最根本的区别是什么？',
    }, {
      source: '半导体存储器按位置可分为内存存储器与外存存储器。',
      explain: '换个角度：位置不同，访问速度和单位容量差好几个量级。',
      check: '',
    }],
  }],
}

const SUMMARY = {
  overview: '你能说出存储器的分类。',
  mastered: ['按位置分类'],
  weak: ['寻址范围计算'],
  pitfalls: ['把 SRAM 和 DRAM 混为一谈'],
  next: ['做两道寻址题'],
}

/** 70k 字的长材料：触发分段理解路径。 */
const LONG_TEXT = `半导体存储器按位置可分为内存存储器与外存存储器。${'存储单元按行列编址，地址线数量决定寻址范围。'.repeat(3200)}`

let db: AppDatabase

beforeEach(() => {
  db = AppDatabase.open(':memory:')
  migrate(db)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-cost-'))
  const settings = new SettingsStore(path.join(root, 'settings.json'))
  settings.save({
    libreOfficePath: null,
    ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'k' },
  })
  void settings
  db.run('INSERT INTO documents(id, display_name, created_at) VALUES (?, ?, ?)', DOC_ID, '存储器讲义', '2026-11-16T00:00:00.000Z')
  db.run(
    `INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    VERSION_ID, DOC_ID, 'b'.repeat(64), 'docx', 10, 'originals/b.docx', 'ready', 'test', '2026-11-16T00:00:00.000Z',
  )
  db.run(
    `INSERT INTO blocks(id, document_version_id, page_id, ordinal, kind, text, locator_json, extraction_method, review_state)
     VALUES (?, ?, NULL, 1, 'paragraph', ?, ?, 'docx-xml', 'unverified')`,
    randomUUID(), VERSION_ID, LONG_TEXT, JSON.stringify({ documentVersionId: VERSION_ID, paragraphAnchor: 'docx-p-0001' }),
  )
})

function fakeFetch() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const system = String(body.messages?.[0]?.content ?? '')
    const reply = (content: string, promptTokens = 120, cachedTokens = 60) =>
      new Response(JSON.stringify({
        choices: [{ message: { content } }],
        usage: {
          prompt_tokens: promptTokens,
          prompt_tokens_details: { cached_tokens: cachedTokens },
          completion_tokens: 40,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (system.includes('课件阅读器')) {
      return reply(JSON.stringify({
        range: '第 1 段',
        topics: ['存储器分类'],
        keyPoints: ['按位置分为内存与外存'],
        quotes: ['半导体存储器按位置可分为内存存储器与外存存储器。'],
        formulas: [],
        examples: [],
        pitfalls: [],
      }), 20_000, 8_000)
    }
    if (system.includes('课程设计')) return reply(JSON.stringify(PLAN), 9_000, 3_000)
    if (system.includes('学习分析')) return reply(JSON.stringify(SUMMARY), 1_000, 900)
    return reply('寻址范围等于 2 的地址线次方。', 500, 400)
  })
}

function buildService(fetchImpl: ReturnType<typeof fakeFetch>) {
  const images = {
    vision: vi.fn(async () => ({ ok: false, error: { message: 'no' } })),
    ocr: vi.fn(async () => ({ ok: false, error: { message: 'no' } })),
    visionEmbedded: vi.fn(async () => ({ ok: false, error: { message: 'no' } })),
  }
  return new StudyService({
    db,
    settings: {
      load: () => ({ libreOfficePath: null, ai: { baseUrl: 'x', model: 'm', apiKey: 'k' } }),
    } as never,
    images: images as never,
    habits: () => DEFAULT_HABITS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
}

function digestCalls(fetchImpl: ReturnType<typeof fakeFetch>): number {
  return fetchImpl.mock.calls.filter((call) => {
    const raw = String((call[1] as RequestInit).body)
    return raw.includes('课件阅读器')
  }).length
}

describe('开课成本：分段理解复用与 token 用量', () => {
  it('同一份长材料第二次开课直接复用分段理解，不再调读材料接口', async () => {
    const fetchImpl = fakeFetch()
    const service = buildService(fetchImpl)
    const first = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '存储器讲义' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data.materialChunks).toBeGreaterThan(1)
    const firstDigestCalls = digestCalls(fetchImpl)
    expect(firstDigestCalls).toBeGreaterThan(0)

    const second = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '再开一门' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(digestCalls(fetchImpl)).toBe(firstDigestCalls)
    expect(second.data.warnings.some((warning) => warning.includes('复用上一次'))).toBe(true)
  })

  it('每次调用的 token 与缓存命中落进 ai_usage，并归到课程名下', async () => {
    const fetchImpl = fakeFetch()
    const service = buildService(fetchImpl)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '存储器讲义' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sessionId = created.data.sessionId

    const sent = await service.send({ sessionId, content: '地址线 16 根能寻多大？' })
    expect(sent.ok).toBe(true)
    const finished = await service.finish({ sessionId })
    expect(finished.ok).toBe(true)

    const rows = db.all<{ kind: string; session_id: string | null; prompt_tokens: number; cached_tokens: number }>(
      'SELECT kind, session_id, prompt_tokens, cached_tokens FROM ai_usage ORDER BY id',
    )
    expect(rows.length).toBeGreaterThan(3)
    expect(rows.some((row) => row.kind === 'digest')).toBe(true)
    expect(rows.some((row) => row.kind === 'plan')).toBe(true)
    expect(rows.some((row) => row.kind === 'chat')).toBe(true)
    expect(rows.some((row) => row.kind === 'summary')).toBe(true)
    // 开课阶段没有 sessionId 的行在建好课后被归到这门课名下。
    expect(rows.every((row) => row.session_id === sessionId)).toBe(true)
    if (!finished.ok) return

    const usage = finished.data.usage
    expect(usage.calls).toBe(rows.length)
    expect(usage.promptTokens).toBeGreaterThan(0)
    expect(usage.cachedTokens).toBeGreaterThan(0)
    expect(usage.cachedTokens).toBeLessThanOrEqual(usage.promptTokens)
  })

  it('材料变化后缓存失效，重新分段理解', async () => {
    const fetchImpl = fakeFetch()
    const service = buildService(fetchImpl)
    const first = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '存储器讲义' })
    expect(first.ok).toBe(true)
    const callsAfterFirst = digestCalls(fetchImpl)
    db.run('UPDATE blocks SET text = text || ?', '新增了一节：交叉存取的原理与代价。')
    const second = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '新版本' })
    expect(second.ok).toBe(true)
    expect(digestCalls(fetchImpl)).toBeGreaterThan(callsAfterFirst)
  })

  it('清除对话只删消息、课程与总结保留；清总结回到未生成；删课程整门消失', async () => {
    const fetchImpl = fakeFetch()
    const service = buildService(fetchImpl)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '存储器讲义' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sessionId = created.data.sessionId

    await service.send({ sessionId, content: '地址线 16 根能寻多大？' })
    await service.finish({ sessionId })

    const clearedChat = service.clearChat({ sessionId })
    expect(clearedChat.ok).toBe(true)
    if (!clearedChat.ok) return
    expect(clearedChat.data.messages).toHaveLength(0)
    expect(clearedChat.data.units.length).toBeGreaterThan(0)
    expect(clearedChat.data.summary).not.toBeNull()

    const clearedSummary = service.clearSummary({ sessionId })
    expect(clearedSummary.ok).toBe(true)
    if (!clearedSummary.ok) return
    expect(clearedSummary.data.summary).toBeNull()

    const del = service.deleteSession({ sessionId })
    expect(del.ok).toBe(true)
    if (!del.ok) return
    expect(del.data.items.some((item) => item.sessionId === sessionId)).toBe(false)
    expect(service.get({ sessionId }).ok).toBe(false)
  })
})

describe('重试提示的前缀稳定性', () => {
  const habits = DEFAULT_HABITS

  it('拆课重试把不合格说明放末尾，前缀与第一次完全一致', () => {
    const base = buildStudyPlanPrompt({ title: '讲义', subject: '', material: '材料', habits, truncated: false })
    const repair = buildStudyPlanPrompt({ title: '讲义', subject: '', material: '材料', habits, truncated: false, repairNote: 'JSON 没闭合' })
    expect(repair.user.startsWith(base.user)).toBe(true)
  })

  it('分段理解重试同样只增末尾，前缀稳定命中缓存', () => {
    const [chunk] = toChunks(`【第 1 页】${'甲'.repeat(2000)}`)
    const base = buildDigestPrompt(chunk!)
    const repair = buildDigestPrompt(chunk!, '字段缺了 quotes')
    expect(repair.startsWith(base)).toBe(true)
  })
})

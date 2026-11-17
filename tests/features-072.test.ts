import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiClient, parseAiUsage } from '../src/ai/client'
import { AppDatabase } from '../src/storage/database'
import { CURRENT_SCHEMA_VERSION, migrate } from '../src/storage/migrate'
import { StudyStore } from '../src/storage/studyStore'
import { SettingsStore } from '../src/providers/settings'
import { StudyService } from '../src/study/service'
import { buildStudyChatPrompt } from '../src/study/prompt'
import type { StudySkill, StudyUnit } from '../src/shared/study'

let root: string
let db: AppDatabase
let settings: SettingsStore
let versionId: string
let firstSession: string
let secondSession: string

const DOC_ID = randomUUID()

function seedSession(id: string, title: string) {
  db.run('INSERT INTO study_sessions(id, request_id, document_version_id, title, subject, source_name, overview, outline_json, habits_json, warnings_json, truncated, material_chars, material_chunks, status, summary_json, teacher_snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, randomUUID(), versionId, title, '计算机组成', '存储器课件',
    '这门课讲存储器的层次与地址映射。', JSON.stringify(['存储器的层次']),
    JSON.stringify({ name: '小明', pace: 'slow', style: 'story', minutes: 25, window: 'evening', avoid: 'long' }),
    '[]', 0, 500, 1, 'ready', '', '', '2026-11-17T10:00:00.000Z', '2026-11-17T10:00:00.000Z')
  db.run(
    `INSERT INTO study_units(id, session_id, ordinal, title, source, minutes, key_points_json, segments_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), id, 0, '存储器的层次', '第 1 页', 8,
    JSON.stringify(['寄存器最快', '越靠近 CPU 越快越小']),
    JSON.stringify([
      { source: '存储器按层次组织，越靠近 CPU 越快、越小、越贵。', explain: '先看速度与容量的取舍。', check: '为什么缓存比内存小？' },
      { source: '寄存器在 CPU 内部，容量最小。', explain: '寄存器是离运算器最近的一层。', check: '寄存器为什么不做大？' },
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

function units(sessionId: string): StudyUnit[] {
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

function prompt(sessionId: string, skill: StudySkill, mode: 'direct' | 'guided') {
  return buildStudyChatPrompt({
    overview: '这门课讲存储器的层次与地址映射。',
    outline: ['存储器的层次'],
    units: units(sessionId),
    unit: units(sessionId)[0],
    messages: [],
    question: '为什么缓存比内存小？',
    habits: { name: '小明', pace: 'slow', style: 'story', minutes: 25, window: 'evening', avoid: 'long' },
    skill: skill === 'auto' ? 'explain' : skill,
    mode,
  })
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-072-'))
  db = AppDatabase.open(path.join(root, 'library.sqlite'))
  migrate(db)
  versionId = randomUUID()
  settings = new SettingsStore(path.join(root, 'settings.json'))
  settings.save({
    libreOfficePath: null,
    ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'k' },
  })
  db.run('INSERT INTO documents(id, display_name, created_at) VALUES (?, ?, ?)', DOC_ID, '存储器课件', '2026-11-17T10:00:00.000Z')
  db.run(
    `INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    versionId, DOC_ID, 'a'.repeat(64), 'docx', 10, 'originals/a.docx', 'ready', 'test', '2026-11-17T10:00:00.000Z',
  )
  firstSession = randomUUID()
  secondSession = randomUUID()
  seedSession(firstSession, '存储器 A')
  seedSession(secondSession, '存储器 B')
})

afterEach(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('0.7.2 usage 解析', () => {
  it('DeepSeek 顶层 prompt_cache_hit_tokens 在 details 缺失时仍能读到', () => {
    const usage = parseAiUsage({
      model: 'deepseek-flash',
      usage: {
        prompt_tokens: 120,
        completion_tokens: 40,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 40,
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    })
    expect(usage.promptTokens).toBe(120)
    expect(usage.cachedTokens).toBe(80)
    expect(usage.cacheMissTokens).toBe(40)
    expect(usage.completionTokens).toBe(40)
    expect(usage.reasoningTokens).toBe(12)
    expect(usage.providerReported).toBe(true)
    expect(usage.model).toBe('deepseek-flash')
  })

  it('只有 prompt_tokens_details 时按 prompt 总数补出未命中数', () => {
    const usage = parseAiUsage({
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: { cached_tokens: 60 },
        completion_tokens: 20,
      },
    })
    expect(usage.cachedTokens).toBe(60)
    expect(usage.cacheMissTokens).toBe(40)
    expect(usage.providerReported).toBe(true)
  })

  it('没有 usage 时不伪装成真实 0，并标出未回报', () => {
    const usage = parseAiUsage({ choices: [{ message: { content: 'ok' } }] })
    expect(usage.providerReported).toBe(false)
    expect(usage.promptTokens).toBe(0)
    expect(usage.cachedTokens).toBe(0)
    expect(usage.cacheMissTokens).toBe(0)
    expect(usage.completionTokens).toBe(0)
  })

  it('prompt_tokens 缺失时用命中+未命中反推', () => {
    const usage = parseAiUsage({
      usage: { prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36, completion_tokens: 10 },
    })
    expect(usage.promptTokens).toBe(100)
    expect(usage.cachedTokens).toBe(64)
    expect(usage.cacheMissTokens).toBe(36)
  })
})

describe('0.7.2 存储与会话聚合', () => {
  it('schema 升到 13，ai_usage 能区分真实回报与估算', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(13)
    const columns = db.all<{ name: string }>('PRAGMA table_info(ai_usage)').map((row) => row.name)
    expect(columns).toContain('cache_miss_tokens')
    expect(columns).toContain('reasoning_tokens')
    expect(columns).toContain('provider_reported')
    expect(columns).toContain('model')
  })

  it('会话聚合同时给出真实回报次数和估算次数', () => {
    const store = new StudyStore(db)
    store.insertUsage({
      sessionId: firstSession, documentVersionId: versionId, kind: 'chat',
      promptTokens: 100, cachedTokens: 60, cacheMissTokens: 40,
      completionTokens: 20, reasoningTokens: 5,
      providerReported: true, model: 'deepseek-flash', createdAt: '2026-11-17T10:01:00.000Z',
    })
    store.insertUsage({
      sessionId: firstSession, documentVersionId: versionId, kind: 'chat',
      promptTokens: 0, cachedTokens: 0, cacheMissTokens: 0,
      completionTokens: 0, reasoningTokens: 0,
      providerReported: false, model: '', createdAt: '2026-11-17T10:02:00.000Z',
    })
    const usage = store.usageOfSession(firstSession)
    expect(usage.calls).toBe(2)
    expect(usage.promptTokens).toBe(100)
    expect(usage.cachedTokens).toBe(60)
    expect(usage.cacheMissTokens).toBe(40)
    expect(usage.completionTokens).toBe(20)
    expect(usage.reasoningTokens).toBe(5)
    expect(usage.reportedCalls).toBe(1)
    expect(usage.estimatedCalls).toBe(1)
    const kinds = store.usageKinds(firstSession)
    expect(kinds).toHaveLength(1)
    expect(kinds[0]).toMatchObject({ kind: 'chat', calls: 2, estimatedCalls: 1 })
  })

  it('两门课并发发消息时用量不串到对方名下', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> }
      const question = String(body.messages?.[1]?.content ?? '')
      calls += 1
      // 第一门课先发、后回；第二门课后发、先回。旧的可变字段会把第一条回复记到第二门课。
      await new Promise((resolve) => setTimeout(resolve, question.includes('A 课') ? 60 : 10))
      return new Response(JSON.stringify({
        choices: [{ message: { content: '这是回答。' } }],
        usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30, completion_tokens: 20 },
        model: 'deepseek-flash',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const svc = service(fetchImpl)
    const [a, b] = await Promise.all([
      svc.send({ sessionId: firstSession, content: 'A 课：缓存为什么小？' }),
      svc.send({ sessionId: secondSession, content: 'B 课：寄存器为什么小？' }),
    ])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    const rows = db.all<{ session_id: string }>('SELECT session_id FROM ai_usage ORDER BY id')
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.session_id))).toEqual(new Set([firstSession, secondSession]))
    expect(calls).toBe(2)
  })
})

describe('0.7.2 前缀缓存', () => {
  it('换技能和模式时 system 完全不变，变化只落在 user 末尾', () => {
    const explain = prompt(firstSession, 'explain', 'direct')
    const socratic = prompt(firstSession, 'socratic', 'guided')
    expect(explain.system).toBe(socratic.system)
    expect(explain.system).not.toContain('苏格拉底')
    const cut = (text: string) => {
      const positions = ['这次是', '这一轮只启用'].map((mark) => text.indexOf(mark)).filter((index) => index >= 0)
      return positions.length ? Math.min(...positions) : text.length
    }
    const cutA = cut(explain.user)
    const cutB = cut(socratic.user)
    expect(cutA).toBeGreaterThan(explain.user.indexOf('学生现在问'))
    expect(cutB).toBeGreaterThan(socratic.user.indexOf('学生现在问'))
    expect(explain.user.slice(0, cutA)).toBe(socratic.user.slice(0, cutB))
  })
})

describe('0.7.2 DeepSeek 官方余额', () => {
  it('能读 CNY 余额；非官方地址给出可读拒绝', async () => {
    const official = new AiClient(
      { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'k' },
      vi.fn(async () => new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '2.00', topped_up_balance: '10.34' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    )
    const infos = await official.balance()
    expect(infos).toEqual([{ currency: 'CNY', totalBalance: '12.34', grantedBalance: '2.00', toppedUpBalance: '10.34' }])

    const proxy = new AiClient(
      { baseUrl: 'https://example.com/v1', model: 'm', apiKey: 'k' },
      vi.fn() as unknown as typeof fetch,
    )
    await expect(proxy.balance()).rejects.toThrow('仅支持 DeepSeek 官方地址')
  })

  it('usageAudit 返回按 kind 明细和余额', async () => {
    const store = new StudyStore(db)
    store.insertUsage({
      sessionId: firstSession, documentVersionId: versionId, kind: 'chat',
      promptTokens: 100, cachedTokens: 60, cacheMissTokens: 40,
      completionTokens: 20, reasoningTokens: 0,
      providerReported: true, model: 'deepseek-flash', createdAt: '2026-11-17T10:01:00.000Z',
    })
    store.insertUsage({
      sessionId: firstSession, documentVersionId: versionId, kind: 'plan',
      promptTokens: 500, cachedTokens: 0, cacheMissTokens: 500,
      completionTokens: 100, reasoningTokens: 0,
      providerReported: true, model: 'deepseek-flash', createdAt: '2026-11-17T10:02:00.000Z',
    })
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('/user/balance')
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '9.99', granted_balance: '0', topped_up_balance: '9.99' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const audit = await service(fetchImpl).usageAudit({ sessionId: firstSession })
    expect(audit.ok).toBe(true)
    if (!audit.ok) return
    expect(audit.data.usage.calls).toBe(2)
    expect(audit.data.kinds.map((row) => row.kind)).toEqual(['chat', 'plan'])
    expect(audit.data.balance?.[0]?.totalBalance).toBe('9.99')
    expect(audit.data.balanceError).toBeNull()
    expect(audit.data.officialNote).toContain('用量信息')
  })
})

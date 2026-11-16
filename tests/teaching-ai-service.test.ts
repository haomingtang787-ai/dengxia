import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AiService } from '../src/ai/service'
import { SettingsStore } from '../src/providers/settings'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { Store } from '../src/storage/store'
import { TeachingService } from '../src/teaching/service'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-ai-'))
const opened: AppDatabase[] = []
afterAll(() => {
  for (const db of opened) db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function setup(messages: unknown[]) {
  const db = AppDatabase.open(path.join(dir, `${randomUUID()}.sqlite`))
  opened.push(db)
  migrate(db)
  const store = new Store(db)
  const documentId = randomUUID()
  const versionId = randomUUID()
  store.insertDocument({ id: documentId, display_name: 'a.txt', created_at: new Date().toISOString() })
  store.insertVersion({
    id: versionId,
    document_id: documentId,
    sha256: 'd'.repeat(64),
    format: 'txt',
    size_bytes: 0,
    original_relpath: `originals/${versionId}.txt`,
    status: 'ready',
    parser_version: 'test',
    created_at: new Date().toISOString(),
  })
  const teaching = new TeachingService({ db })
  const settings = new SettingsStore(path.join(dir, `${randomUUID()}-settings.json`))
  const fetchImpl = vi.fn(async () => {
    const content = messages.shift()
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  const ai = new AiService({ settings, teaching, fetchImpl: fetchImpl as unknown as typeof fetch })
  return { ai, settings, teaching, fetchImpl, versionId, db }
}

const draftJson = {
  title: '光合作用',
  subject: '生物',
  greeting: '我们开始。',
  thesis: '光能变化学能',
  tonight: '先上两讲。',
  units: [
    { title: '光反应', minutes: 4, teaching: '光反应在类囊体薄膜上，把光能存下来。', pause: '没有光会怎样？', terms: [{ word: '类囊体', meaning: '膜上的结构' }], weight: 'core' },
    { title: '暗反应', minutes: 5, teaching: '暗反应在基质里固定二氧化碳。', weight: 'support' },
  ],
  summary: { outline: ['光反应', '暗反应'], mustKnow: ['光反应在膜上'], pitfalls: ['场所记反'], mnemonic: '光膜暗质' },
  cards: [{ front: '光反应在哪', back: '类囊体薄膜' }],
  quizzes: [{ prompt: '暗反应在哪', choices: ['基质', '膜上'], answer: 0, explain: '基质' }],
}

describe('模型服务', () => {
  it('没配置时明确告诉用户去配置，不会偷偷退回本地', async () => {
    const { ai } = setup([draftJson])
    const result = await ai.makeLecture({
      requestId: randomUUID(),
      documentVersionId: randomUUID(),
      title: 't',
      sourceName: 'a.txt',
      blocks: [{ kind: 'paragraph', text: '光反应。' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('AI_NOT_CONFIGURED')
      expect(result.error.message).toContain('配置')
    }
  })

  it('保存配置后状态只暴露 hasKey，不返回密钥', () => {
    const { ai, settings } = setup([draftJson])
    const saved = ai.saveConfig({ baseUrl: 'https://api.example.com/v1/', model: 'm', apiKey: 'sk-test' })
    expect(saved.ok).toBe(true)
    if (saved.ok) {
      expect(saved.data.configured).toBe(true)
      expect(saved.data.baseUrl).toBe('https://api.example.com/v1')
      expect(saved.data.hasKey).toBe(true)
      expect(JSON.stringify(saved.data)).not.toContain('sk-test')
    }
    expect(settings.load().ai?.apiKey).toBe('sk-test')
  })

  it('密钥留空保存时沿用旧密钥', () => {
    const { ai } = setup([draftJson])
    ai.saveConfig({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-1' })
    const again = ai.saveConfig({ baseUrl: 'https://api.example.com/v1', model: 'm2', apiKey: '' })
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.data.model).toBe('m2')
  })

  it('模型返回后确实落库成一份讲解', async () => {
    const { ai, settings, teaching, versionId, fetchImpl } = setup([draftJson])
    settings.save({ libreOfficePath: null, ai: { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' } })
    const created = await ai.makeLecture({
      requestId: randomUUID(),
      documentVersionId: versionId,
      title: '光合作用',
      subject: '生物',
      sourceName: 'a.txt',
      blocks: [{ kind: 'paragraph', text: '光反应在膜上。暗反应在基质里。' }],
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.unitCount).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const detail = teaching.get({ lectureId: created.data.lectureId })
    expect(detail.ok).toBe(true)
    if (detail.ok) {
      expect(detail.data.units[0].title).toBe('光反应')
      expect(detail.data.greeting).toBe('我们开始。')
      expect(detail.data.cards).toHaveLength(1)
      expect(detail.data.quizzes).toHaveLength(1)
    }
  })

  it('拉取模型列表：地址拼对、用保存的密钥、去重', async () => {
    const { settings, teaching } = setup([])
    settings.save({ libreOfficePath: null, ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-deep' } })
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const api = new AiService({ settings, teaching, fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await api.models({})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://api.deepseek.com/v1/models')
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-deep')
  })

  it('没有密钥时先要求填密钥，不去打网络', async () => {
    const { settings, teaching } = setup([])
    const fetchImpl = vi.fn()
    const api = new AiService({ settings, teaching, fetchImpl: fetchImpl as unknown as typeof fetch })
    const result = await api.models({ baseUrl: 'https://api.deepseek.com/v1' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('密钥')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('拉取失败把状态码带回来', async () => {
    const { settings, teaching } = setup([])
    settings.save({ libreOfficePath: null, ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'k' } })
    const api = new AiService({
      settings,
      teaching,
      fetchImpl: (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch,
    })
    const result = await api.models({})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('AI_FAILED')
      expect(result.error.message).toContain('401')
    }
  })

  it('模型报错时把原因带回来，而不是成功', async () => {
    const { settings, teaching } = setup([])
    settings.save({ libreOfficePath: null, ai: { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' } })
    const api = new AiService({
      settings,
      teaching,
      fetchImpl: (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch,
    })
    const result = await api.makeLecture({
      requestId: randomUUID(),
      documentVersionId: randomUUID(),
      title: 't',
      sourceName: 'a.txt',
      blocks: [{ kind: 'paragraph', text: 'x' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('AI_FAILED')
      expect(result.error.message).toContain('401')
    }
  })
})

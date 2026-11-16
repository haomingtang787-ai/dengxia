import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageService } from '../src/images/service'
import { SettingsStore } from '../src/providers/settings'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { Store } from '../src/storage/store'

const DOC_ID = randomUUID()
const VERSION_ID = randomUUID()
const PAGE_ID = randomUUID()

let db: AppDatabase
let store: Store
let root: string
let settings: SettingsStore

beforeEach(() => {
  db = AppDatabase.open(':memory:')
  migrate(db)
  store = new Store(db)
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-research-test-'))
  settings = new SettingsStore(path.join(root, 'settings.json'))
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'artifacts', 'page.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))
  db.run('INSERT INTO documents(id, display_name, created_at) VALUES (?, ?, ?)', DOC_ID, '一页课件', '2026-11-16T00:00:00.000Z')
  db.run(
    `INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    VERSION_ID, DOC_ID, 'a'.repeat(64), 'png', 4, 'originals/page.png', 'ready', 'test', '2026-11-16T00:00:00.000Z',
  )
  db.run(
    `INSERT INTO pages(id, document_version_id, ordinal, source_kind, source_number, image_relpath, width, height, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    PAGE_ID, VERSION_ID, 1, 'pdf', 1, 'artifacts/page.png', 100, 100, 'ready',
  )
  db.run(
    `INSERT INTO artifacts(id, document_version_id, page_id, kind, relpath, mime, sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), VERSION_ID, PAGE_ID, 'page-image', 'artifacts/page.png', 'image/png', 'b'.repeat(64),
  )
  db.run(
    `INSERT INTO blocks(id, document_version_id, page_id, ordinal, kind, text, locator_json, extraction_method, review_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(), VERSION_ID, PAGE_ID, 0, 'page_text', '光合作用发生在叶绿体。CO2 + H2O -> Glucose。', '{}', 'none', 'unverified',
  )
})

function service(fetchImpl?: typeof fetch) {
  return new ImageService({ store, root, settings, fetchImpl })
}

function configure() {
  settings.save({
    libreOfficePath: null,
    ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'k' },
  })
}

describe('自动读懂', () => {
  it('上传图片页后优先让 AI 读懂，不再先跑本机 OCR', async () => {
    db.run("UPDATE pages SET source_kind = 'image' WHERE id = ?", PAGE_ID)
    configure()
    const runOcr = vi.fn(async () => '作者：张三\nC02 + H20 一 > GIucose')
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/v1/tools/search')) {
        return new Response(JSON.stringify({
          results: [{
            rerank_score: 1.9,
            title: '光合作用与叶绿体',
            url: 'https://example.com/biology',
            snippet: '叶绿体是光合作用的场所。',
            summary: '光合作用发生在叶绿体。',
            content: '',
            site_name: 'Example 生物',
            site_icon: null,
            date: null,
            authority: 2,
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (String(url).endsWith('/v1/chat/completions')) {
        const body = JSON.parse(String(init?.body))
        const system = String(body.messages?.[0]?.content ?? '')
        if (system.includes('学科老师')) {
          return new Response(JSON.stringify({ choices: [{ message: { content: '## 知识点\n1. 光合作用发生在叶绿体。\n## 概念关系\n光能转化为化学能。\n## 讲课提示\n强调场所与原料。' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '## 核对结论\n页面说法与资料一致 [1]。' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected ${String(url)}`)
    })
    const svc = new ImageService({
      store,
      root,
      settings,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runOcr,
      visionPayload: async () => ({ mime: 'image/jpeg', base64: 'AA' }),
    })

    const result = await svc.auto({ documentVersionId: VERSION_ID, pageId: PAGE_ID })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.ocr).toBe('skipped')
      expect(result.data.vision).toBe('created')
      expect(result.data.research).toBe('created')
      expect(result.data.errors).toEqual([])
    }
    expect(runOcr).not.toHaveBeenCalled()
    expect(store.listImageReadings(VERSION_ID).map((row) => row.kind)).toEqual(['vision'])
    expect(store.listImageReadings(VERSION_ID)[0].text).toContain('光合作用')
    expect(store.listPageResearch(VERSION_ID)).toHaveLength(1)
    const searchCall = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('/v1/tools/search'))
    const searchBody = JSON.parse(String((searchCall?.[1] as RequestInit).body))
    expect(searchBody.query).toContain('光合作用')
    expect(searchBody.query).not.toContain('张三')
    const visionCall = fetchImpl.mock.calls.find(([url]) => String(url).endsWith('/v1/chat/completions'))
    const visionBody = JSON.parse(String((visionCall?.[1] as RequestInit).body))
    const visionSystem = String(visionBody.messages[0].content)
    const visionPrompt = String(visionBody.messages[1].content[0].text)
    expect(visionSystem).toContain('非知识信息')
    expect(visionPrompt).toContain('不要输出整页 OCR 转写')
    expect(visionPrompt).toContain('知识点')
  })

  it('没有模型密钥时退回本机 OCR，但跳过读图和查证', async () => {
    db.run("UPDATE pages SET source_kind = 'image' WHERE id = ?", PAGE_ID)
    const runOcr = vi.fn(async () => '光合作用发生在叶绿体。')
    const svc = new ImageService({
      store,
      root,
      settings,
      runOcr,
      fetchImpl: (async () => { throw new Error('不应该联网') }) as unknown as typeof fetch,
    })

    const result = await svc.auto({ documentVersionId: VERSION_ID, pageId: PAGE_ID })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.ocr).toBe('created')
      expect(result.data.vision).toBe('skipped')
      expect(result.data.research).toBe('skipped')
    }
    expect(runOcr).toHaveBeenCalledTimes(1)
    expect(store.listImageReadings(VERSION_ID)).toHaveLength(1)
  })

  it('AI 读图失败时退回本机 OCR，但保留失败原因', async () => {
    db.run("UPDATE pages SET source_kind = 'image' WHERE id = ?", PAGE_ID)
    configure()
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).endsWith('/v1/tools/search')) {
        return new Response(JSON.stringify({ results: [{ title: '资料', url: 'https://example.com/a', summary: '摘要', snippet: '短摘要' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (String(url).endsWith('/v1/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '查证完成' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected ${String(url)}`)
    })
    const runOcr = vi.fn(async () => '光合作用发生在叶绿体。')
    const svc = new ImageService({
      store,
      root,
      settings,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runOcr,
      visionPayload: async () => { throw new Error('图片过大') },
    })

    const result = await svc.auto({ documentVersionId: VERSION_ID, pageId: PAGE_ID })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.ocr).toBe('created')
      expect(result.data.vision).toBe('failed')
      expect(result.data.research).toBe('created')
      expect(result.data.errors[0]).toContain('读图')
    }
    expect(store.listImageReadings(VERSION_ID).some((row) => row.kind === 'ocr')).toBe(true)
    expect(store.listImageReadings(VERSION_ID).some((row) => row.kind === 'vision')).toBe(false)
  })
})

describe('联网查证', () => {
  it('已有 AI 读图和本机 OCR 时，查证只用 AI 知识点，不把 OCR 错字带进去', async () => {
    configure()
    db.run("UPDATE pages SET source_kind = 'image' WHERE id = ?", PAGE_ID)
    db.run(
      `INSERT INTO image_readings(id, document_version_id, page_id, kind, text, engine, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(), VERSION_ID, PAGE_ID, 'ocr', 'C02 + H20 一 > GIucose', 'windows-ocr', '2026-11-16T00:00:00.000Z',
    )
    db.run(
      `INSERT INTO image_readings(id, document_version_id, page_id, kind, text, engine, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(), VERSION_ID, PAGE_ID, 'vision', '## 知识点\n光合作用发生在叶绿体。\nCO2 + H2O -> Glucose', 'deepseek-flash', '2026-11-16T00:00:00.000Z',
    )
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).endsWith('/v1/tools/search')) {
        return new Response(JSON.stringify({ results: [{ title: '资料', url: 'https://example.com/a', summary: '摘要', snippet: '短摘要' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '查证完成' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const result = await service(fetchImpl as unknown as typeof fetch).researchVerify({ documentVersionId: VERSION_ID, pageId: PAGE_ID })

    expect(result.ok).toBe(true)
    const searchBody = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(searchBody.query).toContain('光合作用')
    expect(searchBody.query).not.toContain('C02')
    const chatBody = JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body))
    expect(chatBody.messages[1].content).toContain('光合作用发生在叶绿体')
    expect(chatBody.messages[1].content).not.toContain('C02')
  })

  it('用这一页文字搜索，模型核对后把答案和来源落库', async () => {
    configure()
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).endsWith('/v1/tools/search')) {
        return new Response(JSON.stringify({
          results: [{
            rerank_score: 2.1,
            title: '光合作用与叶绿体',
            url: 'https://example.com/photosynthesis',
            snippet: '叶绿体是光合作用的场所。',
            summary: '光合作用发生在叶绿体，光能被转化成化学能。',
            content: '',
            site_name: 'Example 生物',
            site_icon: null,
            date: '2026-09-01T00:00:00+00:00',
            authority: 3,
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (String(url).endsWith('/v1/chat/completions')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '页面说法与资料一致。核对来源 [1]。' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected ${String(url)}`)
    })

    const result = await service(fetchImpl as unknown as typeof fetch).researchVerify({ documentVersionId: VERSION_ID, pageId: PAGE_ID })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.research.query).toContain('光合作用')
      expect(result.data.research.answer).toContain('一致')
      expect(result.data.research.sources).toHaveLength(1)
      expect(result.data.research.sources[0].title).toBe('光合作用与叶绿体')
      expect(result.data.research.engine).toBe('deepseek-flash+search')
    }
    expect(store.listPageResearch(VERSION_ID)).toHaveLength(1)

    const searchBody = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(searchBody.query).toContain('光合作用')
    expect(searchBody.count).toBe(5)
    const chatBody = JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body))
    expect(chatBody.messages[1].content).toContain('光合作用与叶绿体')
    expect(chatBody.messages[1].content).toContain('光合作用发生在叶绿体')
    expect(chatBody.thinking).toEqual({ type: 'disabled' })
  })

  it('没有配置模型时拒绝查证', async () => {
    const result = await service().researchVerify({ documentVersionId: VERSION_ID, pageId: PAGE_ID })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT')
      expect(result.error.message).toContain('密钥')
    }
  })

  it('搜索没有结果时不调用模型，并给出可理解的提示', async () => {
    configure()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const result = await service(fetchImpl as unknown as typeof fetch).researchVerify({ documentVersionId: VERSION_ID, pageId: PAGE_ID })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('没有搜到')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('列表会返回这一份文稿已保存的查证结果', async () => {
    configure()
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).endsWith('/v1/tools/search')) {
        return new Response(JSON.stringify({ results: [{ title: '资料', url: 'https://example.com/a', summary: '摘要', snippet: '短摘要' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '查证完成' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const svc = service(fetchImpl as unknown as typeof fetch)
    await svc.researchVerify({ documentVersionId: VERSION_ID, pageId: PAGE_ID })
    const list = svc.researchList({ documentVersionId: VERSION_ID })
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.data.items[0].pageId).toBe(PAGE_ID)
  })

  it('图片页没有读数时先自动 OCR，不把预览提示当成页面文字', async () => {
    configure()
    db.run('UPDATE pages SET source_kind = ? WHERE id = ?', 'image', PAGE_ID)
    db.run(
      `INSERT INTO blocks(id, document_version_id, page_id, ordinal, kind, text, locator_json, extraction_method, review_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(), VERSION_ID, PAGE_ID, 9, 'page_text', '图像已作为预览保留。打开文稿后可以点「识别这一页文字」或「让模型看懂这一页」读取图中文字和图表。', '{}', 'none', 'unverified',
    )
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).endsWith('/v1/tools/search')) {
        return new Response(JSON.stringify({ results: [{ title: '资料', url: 'https://example.com/a', summary: '摘要', snippet: '短摘要' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '查证完成' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const svc = new ImageService({
      store,
      root,
      settings,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runOcr: async () => '叶绿体是光合作用的场所',
    })
    const result = await svc.researchVerify({ documentVersionId: VERSION_ID, pageId: PAGE_ID })
    expect(result.ok).toBe(true)
    const searchBody = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(searchBody.query).toContain('叶绿体')
    const chatBody = JSON.parse(String((fetchImpl.mock.calls[1][1] as RequestInit).body))
    expect(chatBody.messages[1].content).not.toContain('图像已作为预览保留')
    expect(store.listImageReadings(VERSION_ID).some((row) => row.kind === 'ocr')).toBe(true)
  })
})

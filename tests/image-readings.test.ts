import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageService } from '../src/images/service'
import { normalizeOcrText } from '../src/ocr/windows'
import { SettingsStore } from '../src/providers/settings'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { Store } from '../src/storage/store'

const DOC_ID = randomUUID()
const VERSION_ID = randomUUID()
const PAGE_ID = randomUUID()
const ARTIFACT_ID = randomUUID()

let db: AppDatabase
let store: Store
let root: string
let settings: SettingsStore

beforeEach(() => {
  db = AppDatabase.open(':memory:')
  migrate(db)
  store = new Store(db)
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-image-test-'))
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
    PAGE_ID, VERSION_ID, 1, 'image', 1, 'artifacts/page.png', 100, 100, 'ready',
  )
  db.run(
    `INSERT INTO artifacts(id, document_version_id, page_id, kind, relpath, mime, sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ARTIFACT_ID, VERSION_ID, PAGE_ID, 'page-image', 'artifacts/page.png', 'image/png', 'b'.repeat(64),
  )
})

function service(over: { ocr?: (file: string) => Promise<string>; fetchImpl?: typeof fetch } = {}) {
  return new ImageService({
    store,
    root,
    settings,
    runOcr: over.ocr ?? (async () => '光 合 作 用 发 生 在 叶 绿 体 。'),
    fetchImpl: over.fetchImpl,
    visionPayload: async () => ({ mime: 'image/jpeg', base64: 'ZmFrZQ==' }),
  })
}

describe('OCR 文本归一化', () => {
  it('去掉汉字之间的空格，保留英文单词间距', () => {
    expect(normalizeOcrText('案 头 OCR 测 试\n光 合 作 用 发 生 在 叶 绿 体 。')).toBe('案头 OCR 测试\n光合作用发生在叶绿体。')
  })
})

describe('图片阅读服务', () => {
  it('OCR 结果落库，重复识别是更新不是新增', async () => {
    const api = service()
    const first = await api.ocr({ documentVersionId: VERSION_ID, pageId: PAGE_ID })
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.data.reading.text).toBe('光合作用发生在叶绿体。')
    const second = await service({ ocr: async () => '暗 反 应 在 基 质 。' }).ocr({ documentVersionId: VERSION_ID, pageId: PAGE_ID })
    expect(second.ok).toBe(true)
    const readings = store.listImageReadings(VERSION_ID)
    expect(readings).toHaveLength(1)
    expect(readings[0].text).toBe('暗反应在基质。')
    expect(readings[0].kind).toBe('ocr')
  })

  it('图片页面不存在时返回 NOT_FOUND，不去跑 OCR', async () => {
    const ocr = vi.fn(async () => 'x')
    const api = service({ ocr })
    const result = await api.ocr({ documentVersionId: VERSION_ID, pageId: randomUUID() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')
    expect(ocr).not.toHaveBeenCalled()
  })

  it('没有配置模型时视觉理解明确要求先配置', async () => {
    const result = await service().vision({ documentVersionId: VERSION_ID, pageId: PAGE_ID })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ARGUMENT')
      expect(result.error.message).toContain('模型')
    }
  })

  it('视觉理解用图像模型，返回的文字落库', async () => {
    settings.save({ libreOfficePath: null, ai: { baseUrl: 'https://api.example.com/v1', model: 'text-model', visionModel: 'vision-model', apiKey: 'k' } })
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: '## 图中文字\n光合作用\n## 讲解要点\n光反应在膜上。' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const result = await service({ fetchImpl: fetchImpl as unknown as typeof fetch }).vision({ documentVersionId: VERSION_ID, pageId: PAGE_ID })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.reading.text).toContain('光反应在膜上')
      expect(result.data.reading.kind).toBe('vision')
      expect(result.data.reading.engine).toBe('vision-model')
    }
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(body.model).toBe('vision-model')
    const user = body.messages.find((message: { role: string }) => message.role === 'user')
    expect(user.content[1].image_url.url).toContain('data:image/jpeg;base64,')
    expect(String(body.messages[0].content)).toContain('非知识信息')
  })

  it('不填图像模型时直接用 deepseek-flash 读图', async () => {
    settings.save({ libreOfficePath: null, ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'k' } })
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: '读到了' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const result = await service({ fetchImpl: fetchImpl as unknown as typeof fetch }).vision({ documentVersionId: VERSION_ID, pageId: PAGE_ID })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.reading.engine).toBe('deepseek-flash')
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(body.model).toBe('deepseek-flash')
    const user = body.messages.find((message: { role: string }) => message.role === 'user')
    expect(user.content[1].image_url.url).toContain('data:image/jpeg;base64,')
  })
})

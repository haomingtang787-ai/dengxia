import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageService } from '../src/images/service'
import { SettingsStore } from '../src/providers/settings'
import { Store } from '../src/storage/store'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { StudyService } from '../src/study/service'
import { DEFAULT_HABITS } from '../src/teaching/habits'

const DOC_ID = randomUUID()
const VERSION_ID = randomUUID()
const BLOCK_ID = randomUUID()
const ARTIFACT_ID = randomUUID()

const PLAN = {
  title: '二次函数',
  subject: '数学',
  overview: '这份讲义讲抛物线的开口与对称轴。',
  opening: '我们从图像开始。',
  units: [{
    title: '开口方向',
    source: '第 1 页',
    minutes: 6,
    keyPoints: ['a 的符号决定开口'],
    segments: [{
      source: 'a 大于 0 时开口向上。',
      explain: '先看 a 的符号：它是二次项系数，决定抛物线张口朝哪边。',
      check: '为什么 a 大于 0 就开口向上？',
    }, {
      source: 'a 大于 0 时开口向上。',
      explain: '再换个数：取 a=1，算出对称轴两侧的点，图像只能向上张。',
      check: 'a 变成负数会怎样？',
    }],
  }],
}

const SUMMARY = {
  overview: '你能说出开口方向与 a 的符号的关系。',
  mastered: ['a 的符号决定开口'],
  weak: ['对称轴公式还不熟'],
  pitfalls: ['把 a 的绝对值当成开口大小以外的东西'],
  next: ['练三道对称轴题'],
}

let db: AppDatabase
let root: string
let settings: SettingsStore
let store: Store

beforeEach(() => {
  db = AppDatabase.open(':memory:')
  migrate(db)
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-material-'))
  settings = new SettingsStore(path.join(root, 'settings.json'))
  settings.save({
    libreOfficePath: null,
    ai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'k' },
  })
  store = new Store(db)
  db.run('INSERT INTO documents(id, display_name, created_at) VALUES (?, ?, ?)', DOC_ID, '二次函数讲义', '2026-11-16T00:00:00.000Z')
  db.run(
    `INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    VERSION_ID, DOC_ID, 'b'.repeat(64), 'docx', 10, 'originals/b.docx', 'ready', 'test', '2026-11-16T00:00:00.000Z',
  )
  // 一份 DOCX 的内嵌图：没有页，只有块和 artifact。
  const rel = `artifacts/${DOC_ID}/${VERSION_ID}/figure.png`
  const absolute = path.join(root, rel)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const canvas = createCanvas(64, 48)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, 64, 48)
  fs.writeFileSync(absolute, canvas.toBuffer('image/png'))
  store.insertArtifact({
    id: ARTIFACT_ID,
    document_version_id: VERSION_ID,
    page_id: null,
    kind: 'embedded-image',
    relpath: rel,
    mime: 'image/png',
    sha256: 'c'.repeat(64),
  })
  store.insertBlock({
    id: BLOCK_ID,
    document_version_id: VERSION_ID,
    page_id: null,
    ordinal: 2,
    kind: 'image_region',
    text: '',
    locator_json: JSON.stringify({ documentVersionId: VERSION_ID, paragraphAnchor: 'docx-p-0002-img1', artifactId: ARTIFACT_ID }),
    extraction_method: 'docx-xml',
    review_state: 'unverified',
  })
  store.insertBlock({
    id: randomUUID(),
    document_version_id: VERSION_ID,
    page_id: null,
    ordinal: 1,
    kind: 'paragraph',
    text: 'a 大于 0 时开口向上。',
    locator_json: JSON.stringify({ documentVersionId: VERSION_ID, paragraphAnchor: 'docx-p-0001' }),
    extraction_method: 'docx-xml',
    review_state: 'unverified',
  })
})

function fakeFetch() {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const raw = String(init?.body ?? '')
    const system = String(body.messages?.[0]?.content ?? '')
    const reply = (content: string) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (raw.includes('请先把这张课件页读懂')) return reply('图里是抛物线，开口向上，顶点在原点。')
    if (system.includes('课程设计')) return reply(JSON.stringify(PLAN))
    if (system.includes('学习分析')) return reply(JSON.stringify(SUMMARY))
    return reply('这句的关键是 a 的符号。')
  })
}

function buildService(fetchImpl: ReturnType<typeof fakeFetch>) {
  const images = new ImageService({ store, root, settings, fetchImpl: fetchImpl as unknown as typeof fetch })
  return new StudyService({
    db,
    settings,
    images,
    habits: () => DEFAULT_HABITS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
}

describe('内嵌图进入课堂 + 停一下作答', () => {
  it('DOCX 没有页，图片仍会被读懂并进入课程设计，且只读一次', async () => {
    const fetchImpl = fakeFetch()
    const service = buildService(fetchImpl)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '二次函数讲义' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const visionCalls = fetchImpl.mock.calls.filter((call) => String((call[1] as RequestInit).body).includes('先把这张课件页读懂'))
    expect(visionCalls.length).toBe(1)
    const visionBody = JSON.parse(String((visionCalls[0]![1] as RequestInit).body))
    expect(JSON.stringify(visionBody)).toContain('data:image/jpeg;base64')
    const planBody = fetchImpl.mock.calls
      .map((call) => String((call[1] as RequestInit).body))
      .find((body) => body.includes('课程设计'))
    expect(planBody).toContain('图里是抛物线')

    // 再开一门同一份材料：读图结果从 block_readings 复用，不再调用视觉模型。
    const again = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '再开一门' })
    expect(again.ok).toBe(true)
    const visionCallsAfter = fetchImpl.mock.calls.filter((call) => String((call[1] as RequestInit).body).includes('先把这张课件页读懂'))
    expect(visionCallsAfter.length).toBe(1)
  })

  it('作答只记录真实回答，问题的出处由小讲决定，总结会带上它', async () => {
    const fetchImpl = fakeFetch()
    const service = buildService(fetchImpl)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '二次函数讲义' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sessionId = created.data.sessionId

    const invalid = service.check({ sessionId, unitOrdinal: 9, segmentIndex: 0, answer: '随便' })
    expect(invalid.ok).toBe(false)

    const saved = service.check({ sessionId, unitOrdinal: 0, segmentIndex: 0, answer: '因为 a 大于 0，抛物线开口向上。' })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.data.checks).toHaveLength(1)
    expect(saved.data.checks[0]!.question).toBe('为什么 a 大于 0 就开口向上？')
    expect(saved.data.checks[0]!.answer).toContain('开口向上')

    // 同一句再答一次只更新，不堆记录。
    const updated = service.check({ sessionId, unitOrdinal: 0, segmentIndex: 0, answer: 'a 是二次项系数，取正值时两端都向上。' })
    expect(updated.ok && updated.data.checks).toHaveLength(1)

    const finished = await service.finish({ sessionId })
    expect(finished.ok).toBe(true)
    const summaryBody = fetchImpl.mock.calls
      .map((call) => String((call[1] as RequestInit).body))
      .find((body) => body.includes('学习分析'))
    expect(summaryBody).toContain('学生答：a 是二次项系数')
    expect(summaryBody).toContain('为什么 a 大于 0 就开口向上？')
  })

  it('没有图片可读的块不会让整门课失败，只留一条警告', async () => {
    db.run('DELETE FROM artifacts WHERE id = ?', ARTIFACT_ID)
    const fetchImpl = fakeFetch()
    const service = buildService(fetchImpl)
    const created = await service.create({ requestId: randomUUID(), documentVersionId: VERSION_ID, title: '二次函数讲义' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.warnings.some((warning) => warning.includes('内嵌图片'))).toBe(true)
    const planBody = fetchImpl.mock.calls
      .map((call) => String((call[1] as RequestInit).body))
      .find((body) => body.includes('课程设计'))
    expect(planBody).toContain('a 大于 0 时开口向上。')
  })
})

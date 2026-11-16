import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { Store } from '../src/storage/store'
import { TeachingService } from '../src/teaching/service'
import type { LectureDetail } from '../src/shared/teaching'
import { RELEARN_MS } from '../src/teaching/study'

const DOC_ID = randomUUID()
const VERSION_ID = randomUUID()

function draft(over: Record<string, unknown> = {}) {
  return {
    requestId: randomUUID(),
    documentVersionId: VERSION_ID,
    title: '光合作用',
    subject: '生物',
    sourceName: '一页课件',
    greeting: '我们来一起学习光合作用。',
    thesis: '这页讲植物怎么把光变成能量。',
    tonight: '按你每次 15 分钟，今晚先上两讲。',
    nextSitting: '',
    rawText: '光合作用把光能转成化学能。',
    habitStamp: 'steady|story|15|evening|long|',
    units: [
      {
        title: '光合作用的组成',
        minutes: 4,
        source: '第 1 页第 1 段',
        teaching: '光合作用需要光、二氧化碳和水。',
        pause: '停一下：没有光会怎样？',
        terms: [{ word: '光合作用', meaning: '植物用光能合成有机物' }],
        pitfall: '别把原料记成产物',
        weight: 'core',
        example: '一片叶子在阳光下放氧',
      },
      {
        title: '光反应的场所',
        minutes: 5,
        source: '第 1 页第 2 段',
        teaching: '光反应发生在类囊体薄膜上。',
        pause: '停一下：膜上有什么？',
        terms: [],
        pitfall: '',
        weight: 'core',
        example: '',
      },
    ],
    summary: {
      outline: ['光反应', '暗反应'],
      mustKnow: ['光反应场所'],
      pitfalls: ['记反场所'],
      mnemonic: '光在膜，暗在质',
      recital: '光能转化学能',
    },
    cards: [
      { front: '光反应在哪', back: '类囊体薄膜' },
      { front: '暗反应在哪', back: '叶绿体基质' },
    ],
    quizzes: [
      { prompt: '光反应发生在哪里？', choices: ['类囊体薄膜', '叶绿体基质'], answer: 0, explain: '光反应在类囊体薄膜。' },
      { prompt: '暗反应发生在哪里？', choices: ['类囊体薄膜', '叶绿体基质'], answer: 1, explain: '暗反应在基质。' },
    ],
    ...over,
  }
}

describe('授课服务（P2）', () => {
  let db: AppDatabase
  let now: number
  let service: TeachingService

  beforeEach(() => {
    db = AppDatabase.open(':memory:')
    migrate(db)
    const store = new Store(db)
    store.insertDocument({ id: DOC_ID, display_name: '课件.pdf', created_at: '2026-11-16T10:00:00.000Z' })
    store.insertVersion({
      id: VERSION_ID,
      document_id: DOC_ID,
      sha256: 'a'.repeat(64),
      format: 'pdf',
      size_bytes: 1024,
      original_relpath: `originals/${VERSION_ID}.pdf`,
      status: 'ready',
      parser_version: '1',
      created_at: '2026-11-16T10:00:00.000Z',
    })
    now = new Date(2026, 10, 16, 20, 0).getTime()
    service = new TeachingService({ db, now: () => now })
  })

  it('迁移可以重复执行，不破坏已有数据', () => {
    migrate(db)
    migrate(db)
    expect(service.list()).toMatchObject({ ok: true })
  })

  it('已有 v1 的库只补教学表，原有文稿还在', () => {
    const legacy = AppDatabase.open(':memory:')
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE documents (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE document_versions (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), sha256 TEXT NOT NULL,
        format TEXT NOT NULL, size_bytes INTEGER NOT NULL, original_relpath TEXT NOT NULL,
        status TEXT NOT NULL, parser_version TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-11-15T00:00:00.000Z');
      INSERT INTO documents(id, display_name, created_at) VALUES ('doc-old', '旧课件.pdf', '2026-11-15T00:00:00.000Z');
    `)
    legacy.run(
      `INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at)
       VALUES ('ver-old', 'doc-old', ?, 'pdf', 10, 'originals/ver-old.pdf', 'ready', '1', '2026-11-15T00:00:00.000Z')`,
      'b'.repeat(64),
    )
    migrate(legacy)
    expect(legacy.get<{ version: number }>('SELECT version FROM schema_migrations WHERE version = 2')).toBeTruthy()
    expect(legacy.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents')?.n).toBe(1)
    expect(
      legacy.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lectures'")?.name,
    ).toBe('lectures')
  })

  it('建讲解会把小讲、卡片、题目按顺序落库，读回来一致', async () => {
    const body = draft()
    const created = await service.create(body)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.unitCount).toBe(2)

    const detail = await service.get({ lectureId: created.data.lectureId })
    expect(detail.ok).toBe(true)
    if (!detail.ok) return
    const view: LectureDetail = detail.data
    expect(view.units.map((unit) => unit.title)).toEqual(['光合作用的组成', '光反应的场所'])
    expect(view.units[0].terms[0].word).toBe('光合作用')
    expect(view.cards.map((card) => card.id)).toEqual(['c1', 'c2'])
    expect(view.cards[0].due).toBe(now)
    expect(view.quizzes).toHaveLength(2)
    expect(view.quizzes[0]).not.toHaveProperty('answer')
    expect(view.known).toEqual([])
  })

  it('同一个 requestId 重复建不产生第二份讲解', async () => {
    const body = draft()
    const first = await service.create(body)
    const second = await service.create(body)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.data.lectureId).toBe(first.data.lectureId)
    expect(service.list()).toMatchObject({ ok: true })
    const list = await service.list()
    if (!list.ok) return
    expect(list.data.items).toHaveLength(1)
  })

  it('新的讲解排在前面', async () => {
    const first = await service.create(draft({ requestId: randomUUID(), title: '呼吸作用' }))
    now += 60_000
    const second = await service.create(draft({ requestId: randomUUID(), title: '光合作用' }))
    if (!first.ok || !second.ok) return
    const list = await service.list()
    if (!list.ok) return
    expect(list.data.items.map((item) => item.title)).toEqual(['光合作用', '呼吸作用'])
  })

  it('点听懂是幂等的，并记在学习痕迹里', async () => {
    const created = await service.create(draft())
    if (!created.ok) return
    const lectureId = created.data.lectureId
    const marked = await service.markKnown({ lectureId, unitId: 'u1', known: true })
    expect(marked.ok).toBe(true)
    if (!marked.ok) return
    expect(marked.data.known).toEqual(['u1'])

    await service.markKnown({ lectureId, unitId: 'u1', known: true })
    const marks = service.today()
    if (!marks.ok) return
    expect(marks.data.known).toBe(1)
    expect(marks.data.cards).toBe(0)

    const unmarked = await service.markKnown({ lectureId, unitId: 'u1', known: false })
    if (!unmarked.ok) return
    expect(unmarked.data.known).toEqual([])
  })

  it('续学游标可以存下来', async () => {
    const created = await service.create(draft())
    if (!created.ok) return
    const saved = await service.setCursor({ lectureId: created.data.lectureId, cursor: 1 })
    expect(saved).toMatchObject({ ok: true, data: { cursor: 1 } })
    const detail = await service.get({ lectureId: created.data.lectureId })
    if (!detail.ok) return
    expect(detail.data.cursor).toBe(1)
  })

  it('到点卡片能取到，答对升箱、答错回零并留出重学间隔', async () => {
    const created = await service.create(draft())
    if (!created.ok) return
    const lectureId = created.data.lectureId

    const due = await service.dueCards()
    if (!due.ok) return
    expect(due.data.items.map((item) => item.card.id)).toEqual(['c1', 'c2'])

    const right = await service.gradeCard({ lectureId, cardId: 'c1', remembered: true })
    expect(right.ok).toBe(true)
    if (!right.ok) return
    expect(right.data.card.box).toBe(1)
    expect(right.data.card.due).toBe(now + 600_000)

    const after = await service.dueCards()
    if (!after.ok) return
    expect(after.data.items.map((item) => item.card.id)).toEqual(['c2'])

    const wrong = await service.gradeCard({ lectureId, cardId: 'c2', remembered: false })
    if (!wrong.ok) return
    expect(wrong.data.card.box).toBe(0)
    expect(wrong.data.card.due).toBe(now + RELEARN_MS)

    const marks = service.today()
    if (!marks.ok) return
    expect(marks.data.cards).toBe(2)
  })

  it('答错入错题本，同一条不重复；答对给解释', async () => {
    const created = await service.create(draft())
    if (!created.ok) return
    const lectureId = created.data.lectureId

    const wrong = await service.answerQuiz({ lectureId, quizId: 'q1', choice: 1 })
    expect(wrong.ok).toBe(true)
    if (!wrong.ok) return
    expect(wrong.data.correct).toBe(false)
    expect(wrong.data.explain).toBe('光反应在类囊体薄膜。')
    expect(wrong.data.missAdded).toBe(true)

    const again = await service.answerQuiz({ lectureId, quizId: 'q1', choice: 0 })
    if (!again.ok) return
    expect(again.data.correct).toBe(true)
    expect(again.data.missAdded).toBe(false)

    const misses = await service.misses({})
    if (!misses.ok) return
    expect(misses.data.items).toHaveLength(1)
    expect(misses.data.items[0].prompt).toBe('光反应发生在哪里？')

    const marks = service.today()
    if (!marks.ok) return
    expect(marks.data.quizzes).toBe(2)
  })

  it('习惯可以保存，坏值被规范化', async () => {
    const saved = await service.saveHabits({
      name: '  小 明 ',
      pace: 'wild',
      style: 'ask',
      minutes: 30,
      window: 'night',
      avoid: 'formula',
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.data).toMatchObject({ name: '小 明', pace: 'steady', minutes: 25, window: 'night', style: 'ask' })

    const read = await service.habits()
    if (!read.ok) return
    expect(read.data.name).toBe('小 明')
  })

  it('参数不合法时说清楚，找不到讲解返回 NOT_FOUND', async () => {
    const bad = await service.create(draft({ units: [] }))
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error.code).toBe('INVALID_ARGUMENT')

    const missing = await service.get({ lectureId: randomUUID() })
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.error.code).toBe('NOT_FOUND')
  })
})

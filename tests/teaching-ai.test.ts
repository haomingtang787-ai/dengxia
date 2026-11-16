import { describe, expect, it } from 'vitest'
import { buildLecturePrompt } from '../src/ai/prompt'
import { parseLectureResponse } from '../src/ai/parse'
import { buildNote } from '../src/teaching/note'
import { DEFAULT_AI } from '../src/shared/ai'
import type { LectureDetail, MissItem } from '../src/shared/teaching'

const habits = {
  name: '小林',
  pace: 'slow' as const,
  style: 'define' as const,
  minutes: 25 as const,
  window: 'evening' as const,
  avoid: 'long' as const,
}

describe('模型拆讲提示词', () => {
  it('默认地址和模型是 DeepSeek', () => {
    expect(DEFAULT_AI.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(DEFAULT_AI.model).toBe('deepseek-flash')
  })

  it('把习惯、材料与 JSON 合同写进提示词', () => {
    const { system, user } = buildLecturePrompt({
      title: '光合作用',
      subject: '生物',
      blocks: [{ kind: 'paragraph', text: '光反应在类囊体薄膜上。' }],
      habits,
      pageLabel: '第 1 页',
    })
    expect(system).toContain('JSON')
    expect(system).toContain('units')
    expect(system).toContain('cards')
    expect(user).toContain('小林')
    expect(user).toContain('25 分钟')
    expect(user).toContain('光反应在类囊体薄膜上。')
    expect(user).toContain('第 1 页')
  })

  it('材料过长时截断，不超上限', () => {
    const { user } = buildLecturePrompt({
      title: 't',
      subject: '',
      blocks: [{ kind: 'paragraph', text: '啊'.repeat(20000) }],
      habits,
    })
    expect(user.length).toBeLessThan(14000)
  })
})

describe('模型响应解析', () => {
  const meta = { title: '光合作用', subject: '生物', sourceName: 'a.txt' }

  it('剥掉 markdown 代码块再解析', () => {
    const draft = parseLectureResponse(
      '```json\n{"units":[{"title":"光反应","minutes":4,"teaching":"光反应在膜上。"}],"summary":{"outline":["光反应"]},"cards":[{"front":"在哪","back":"膜上"}],"quizzes":[{"prompt":"在哪？","choices":["膜上","基质"],"answer":0,"explain":"膜上"}]}\n```',
      meta,
    )
    expect(draft.units).toHaveLength(1)
    expect(draft.units[0].title).toBe('光反应')
    expect(draft.cards[0].front).toBe('在哪')
    expect(draft.quizzes[0].answer).toBe(0)
  })

  it('缺字段时补默认值，不把讲解写成空', () => {
    const draft = parseLectureResponse('{"units":[{"title":"x","teaching":"y"}]}', meta)
    expect(draft.units[0].minutes).toBeGreaterThanOrEqual(2)
    expect(draft.units[0].terms).toEqual([])
    expect(draft.units[0].weight).toBe('core')
    expect(draft.subject).toBe('生物')
  })

  it('不是 JSON 或没有小讲时明确报错', () => {
    expect(() => parseLectureResponse('我觉得这页很重要', meta)).toThrow('格式')
    expect(() => parseLectureResponse('{"units":[]}', meta)).toThrow('格式')
  })

  it('选项答案越界时报错，不静默改答案', () => {
    expect(() =>
      parseLectureResponse(
        '{"units":[{"title":"x","teaching":"y"}],"quizzes":[{"prompt":"p","choices":["a","b"],"answer":5}]}',
        meta,
      ),
    ).toThrow('答案')
  })
})

describe('课后笔记', () => {
  const detail: LectureDetail = {
    lectureId: 'l',
    documentVersionId: 'v',
    title: '光合作用',
    subject: '生物',
    sourceName: 'a.txt',
    unitCount: 3,
    knownCount: 1,
    createdAt: '2026-11-16T00:00:00.000Z',
    greeting: '',
    thesis: '光能变化学能',
    tonight: '',
    nextSitting: '',
    rawText: '',
    cursor: 0,
    known: ['u1'],
    units: [
      { id: 'u1', title: '光反应', minutes: 4, source: '', teaching: '', pause: '', terms: [], pitfall: '', weight: 'core', example: '' },
      { id: 'u2', title: '暗反应', minutes: 5, source: '', teaching: '', pause: '', terms: [], pitfall: '', weight: 'core', example: '' },
      { id: 'u3', title: '场所', minutes: 5, source: '', teaching: '', pause: '', terms: [], pitfall: '', weight: 'support', example: '' },
    ],
    summary: { outline: ['光反应', '暗反应'], mustKnow: ['光反应在膜上'], pitfalls: ['记反场所'], mnemonic: '光膜暗质', recital: '' },
    cards: [],
    quizzes: [],
  }
  const misses: MissItem[] = [{ id: 'm1', lectureId: 'l', prompt: '暗反应在哪', explain: '基质', at: 0 }]

  it('写清进度、还没懂的小讲、错题与下一坐', () => {
    const note = buildNote({ detail, misses, dueCount: 2, now: new Date(2026, 10, 16) })
    expect(note).toContain('# 光合作用 · 课后笔记')
    expect(note).toContain('2026-11-16')
    expect(note).toContain('1/3')
    expect(note).toContain('暗反应')
    expect(note).toContain('暗反应在哪')
    expect(note).toContain('2 张卡片到点')
  })

  it('没错题时写明没有，不编造', () => {
    const note = buildNote({ detail, misses: [], dueCount: 0, now: new Date(2026, 10, 16) })
    expect(note).toContain('还没有错题')
  })
})

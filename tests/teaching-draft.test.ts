import { describe, expect, it } from 'vitest'
import { buildLocalDraft } from '../src/renderer/teaching/draft'

const HEADING = { kind: 'heading', text: '光合作用' }
const P1 = { kind: 'paragraph', text: '光合作用把光能转成化学能。植物需要光、二氧化碳和水。' }
const P2 = { kind: 'paragraph', text: '光反应发生在类囊体薄膜上，暗反应发生在叶绿体基质里。' }

describe('本地拆讲', () => {
  it('没有文字就不生成讲解', () => {
    expect(buildLocalDraft({ title: '空页', sourceName: '空.pdf', blocks: [] })).toBeNull()
    expect(buildLocalDraft({ title: '空页', sourceName: '空.pdf', blocks: [{ kind: 'paragraph', text: '   ' }] })).toBeNull()
  })

  it('标题独立成讲，后面的段落跟着它', () => {
    const draft = buildLocalDraft({
      title: '光合作用',
      sourceName: '一页课件.pdf',
      blocks: [HEADING, P1, P2],
    })
    expect(draft?.units).toHaveLength(1)
    expect(draft?.units[0].title).toBe('光合作用')
    expect(draft?.units[0].teaching).toContain('光合作用把光能转成化学能')
    expect(draft?.units[0].teaching).toContain('光反应发生在类囊体薄膜上')
  })

  it('两个标题就是两讲，顺序不乱', () => {
    const draft = buildLocalDraft({
      title: '光合作用',
      sourceName: '一页课件.pdf',
      blocks: [HEADING, P1, { kind: 'heading', text: '光反应' }, P2],
    })
    expect(draft?.units.map((unit) => unit.title)).toEqual(['光合作用', '光反应'])
    expect(draft?.summary.outline).toEqual(['光合作用', '光反应'])
  })

  it('没有标题时用第一句当标题，并去掉句末标点', () => {
    const draft = buildLocalDraft({
      title: '一页课件',
      sourceName: '一页课件.pdf',
      blocks: [P1],
    })
    expect(draft?.units[0].title).toBe('光合作用把光能转成化学能')
  })

  it('分钟数按字数估算，至少 2 分钟、最多 12 分钟', () => {
    const short = buildLocalDraft({ title: 't', sourceName: 's', blocks: [{ kind: 'paragraph', text: '短句。' }] })
    expect(short?.units[0].minutes).toBe(2)
    const long = buildLocalDraft({
      title: 't',
      sourceName: 's',
      blocks: [{ kind: 'paragraph', text: '啊'.repeat(2400) }],
    })
    expect(long?.units[0].minutes).toBe(12)
    const mid = buildLocalDraft({ title: 't', sourceName: 's', blocks: [{ kind: 'paragraph', text: '啊'.repeat(600) }] })
    expect(mid?.units[0].minutes).toBe(3)
  })

  it('长标题截到 40 字，卡片与题目留空', () => {
    const draft = buildLocalDraft({
      title: 't',
      sourceName: 's',
      blocks: [{ kind: 'paragraph', text: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十又多了。' }],
    })
    expect(draft?.units[0].title.length).toBeLessThanOrEqual(40)
    expect(draft?.cards).toEqual([])
    expect(draft?.quizzes).toEqual([])
  })
})

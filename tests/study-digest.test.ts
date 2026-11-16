import { describe, expect, it, vi } from 'vitest'
import { digestMaterial, renderDigests, splitMaterial, toChunks } from '../src/study/digest'
import { groundUnits } from '../src/study/ground'
import type { StudyUnit } from '../src/shared/study'

describe('长课件分块理解', () => {
  it('按页边界切块，不把一页劈成两半', () => {
    const text = [
      `【第 1 页】${'甲'.repeat(40)}`,
      `【第 2 页】${'乙'.repeat(40)}`,
      `【第 3 页】${'丙'.repeat(40)}`,
    ].join('\n\n')
    const chunks = splitMaterial(text, 60)
    expect(chunks).toHaveLength(3)
    for (const chunk of chunks) {
      expect([...chunk.matchAll(/【第/g)]).toHaveLength(1)
    }
  })

  it('单页超过上限时按字数硬切，内容不丢', () => {
    const page = `【第 1 页】${'字'.repeat(250)}`
    const chunks = splitMaterial(page, 100)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('').replace(/\s/g, '')).toBe(page.replace(/\s/g, ''))
  })

  it('分段数量有上限，页码范围取自原文', () => {
    const parts = Array.from({ length: 30 }, (_, index) => `【第 ${index + 1} 页】${'内容'.repeat(400)}`)
    const chunks = toChunks(parts.join('\n\n'))
    expect(chunks.length).toBeLessThanOrEqual(12)
    expect(chunks[0]!.range).toContain('第 1 页')
    expect(chunks[chunks.length - 1]!.range).toContain('页')
  })

  it('分段理解成功时保留主题、原文摘录、公式、易错，并渲染进拆课输入', async () => {
    const digest = {
      range: '第 1 页',
      topics: ['开口方向'],
      keyPoints: ['a 大于 0 开口向上'],
      quotes: ['当 a 大于 0 时，抛物线的开口向上。'],
      formulas: ['y = ax^2'],
      examples: [],
      pitfalls: ['不要和顶点坐标混'],
    }
    const complete = vi.fn(async () => JSON.stringify(digest))
    const outcome = await digestMaterial({ complete } as never, `【第 1 页】${'甲'.repeat(50)}`)
    expect(outcome.digests).toHaveLength(1)
    expect(outcome.warnings).toHaveLength(0)
    const rendered = renderDigests(outcome.digests)
    expect(rendered).toContain('主题：开口方向')
    expect(rendered).toContain('原文摘录')
    expect(rendered).toContain('当 a 大于 0 时，抛物线的开口向上。')
    expect(rendered).toContain('公式与符号：y = ax^2')
    expect(rendered).toContain('易错：不要和顶点坐标混')
  })

  it('两段都读不懂时重试一次，再降级为原文前 3000 字并留下警告', async () => {
    const complete = vi.fn(async () => '这不是 JSON')
    const outcome = await digestMaterial({ complete } as never, `【第 1 页】${'甲'.repeat(50)}`)
    expect(complete).toHaveBeenCalledTimes(2)
    expect(outcome.warnings).toHaveLength(1)
    expect(outcome.warnings[0]).toContain('没有读懂')
    expect(outcome.digests[0]!.keyPoints[0]).toContain('甲')
  })

  it('分块理解三路并行，结果顺序仍然按原文段序落回', async () => {
    const text = Array.from({ length: 6 }, (_, index) => `【第 ${index + 1} 页】${'内容'.repeat(7000)}`).join('\n\n')
    const complete = vi.fn(async (_system: string, user: string) => {
      const page = /第 (\d+) 页/.exec(user.split('页码范围：')[1] ?? '')?.[1] ?? '1'
      await new Promise((resolve) => setTimeout(resolve, page === '1' ? 60 : 5))
      return JSON.stringify({ range: `第 ${page} 页`, topics: ['主题'], keyPoints: ['要点'], quotes: [], formulas: [], examples: [], pitfalls: [] })
    })
    const outcome = await digestMaterial({ complete } as never, text, { concurrency: 3 })
    expect(outcome.digests.map((digest) => digest.range)).toEqual(['第 1 页', '第 2 页', '第 3 页', '第 4 页', '第 5 页', '第 6 页'])
  })
})

describe('讲稿原文接地', () => {
  const first = '事务T1先读B，再写回A。'
  const second = '事务T2先读A，再写回B。'
  const material = `${first}${second}两个事务并发执行时结果可能不同。`
  const unit = (sources: string[]): StudyUnit => ({
    id: 'u1',
    ordinal: 0,
    title: '可串行性',
    source: '第 1 页',
    minutes: 5,
    keyPoints: ['结果等价'],
    segments: sources.map((source) => ({ source, explain: '讲解', check: '' })),
  })

  it('逐字一致的原句原样保留', () => {
    const result = groundUnits([unit([first])], material)
    expect(result.ungrounded).toBe(0)
    expect(result.units[0]!.segments[0]!.source).toBe(first)
  })

  it('把两句拼成一句时，收回到能逐字对上的前两句原文', () => {
    const merged = `${first}${second}这两个事务谁先谁后都可能。`
    const result = groundUnits([unit([merged])], material)
    expect(result.ungrounded).toBe(0)
    expect(result.units[0]!.segments[0]!.source).toBe(`${first}${second}`)
  })

  it('完全对不上的引用保留原样并计数，不假装是原文', () => {
    const result = groundUnits([unit(['两段锁协议保证可串行化并且不会死锁。'])], material)
    expect(result.ungrounded).toBe(1)
    expect(result.units[0]!.segments[0]!.source).toBe('两段锁协议保证可串行化并且不会死锁。')
  })
})

import { describe, expect, it } from 'vitest'
import {
  CARD_GAPS,
  RELEARN_MS,
  bumpDay,
  collectDue,
  gradeCard,
  mergeMisses,
  normalizeDays,
  normalizeMisses,
  rollCourses,
  studyStreak,
  todayBrief,
  todayKey,
  todaySittings,
} from '../src/teaching/study'
import type { Card, StudyLecture, Unit } from '../src/teaching/types'

function unit(id: string, title: string, minutes: number, weight: 'core' | 'support' = 'core'): Unit {
  return {
    id,
    title,
    minutes,
    source: '第 1 页',
    teaching: '',
    pause: '',
    terms: [],
    pitfall: '',
    weight,
    example: '',
  }
}

function lecture(over: Partial<StudyLecture> = {}): StudyLecture {
  return {
    id: 'L1',
    title: '光合作用',
    subject: '生物',
    units: [unit('u1', '光合作用的组成', 4), unit('u2', '光反应的场所', 5)],
    known: [],
    cards: [],
    summary: { outline: [], mustKnow: [], pitfalls: [], mnemonic: '', recital: '' },
    ...over,
  }
}

function card(over: Partial<Card> = {}): Card {
  return { id: 'c1', front: '光反应在哪', back: '类囊体薄膜', box: 0, due: 0, ...over }
}

describe('复习卡片', () => {
  it('答错不进下一箱，但要在一分钟内再见到，而不是原地无限刷', () => {
    const now = 1_000_000
    const graded = gradeCard(card({ box: 2 }), false, now)
    expect(graded.box).toBe(0)
    expect(graded.due).toBe(now + RELEARN_MS)
    expect(RELEARN_MS).toBeLessThan(CARD_GAPS[1])
  })

  it('答对升一箱，间隔按五箱表走', () => {
    const now = 1_000_000
    const first = gradeCard(card({ box: 0 }), true, now)
    expect(first.box).toBe(1)
    expect(first.due).toBe(now + CARD_GAPS[1])
    const last = gradeCard(card({ box: 4 }), true, now)
    expect(last.box).toBe(4)
    expect(last.due).toBe(now + CARD_GAPS[4])
  })

  it('五箱间隔是 0 / 10 分钟 / 1 天 / 3 天 / 7 天', () => {
    expect(CARD_GAPS).toEqual([0, 600_000, 86_400_000, 259_200_000, 604_800_000])
  })

  it('只收到点的卡片，未来的不打扰', () => {
    const now = 5_000_000
    const due = collectDue(
      [
        lecture({ cards: [card({ id: 'a', due: now - 1 }), card({ id: 'b', due: now + 1 })] }),
        lecture({ id: 'L2', title: '呼吸作用', subject: '生物', cards: [card({ id: 'c', due: 0 })] }),
      ],
      now,
    )
    expect(due.map((entry) => entry.card.id)).toEqual(['a', 'c'])
    expect(due[0].lectureTitle).toBe('光合作用')
  })
})

describe('学习痕迹', () => {
  it('连续天数：今天没坐下就看昨天', () => {
    const now = new Date(2026, 10, 16)
    const days = [
      { date: '2026-11-14', known: 1, cards: 0, quizzes: 0 },
      { date: '2026-11-15', known: 0, cards: 3, quizzes: 0 },
    ]
    expect(studyStreak(days, now)).toBe(2)
    expect(studyStreak([{ date: '2026-11-13', known: 1, cards: 0, quizzes: 0 }], now)).toBe(0)
  })

  it('今日计数只加一，封顶 99，最多留 40 天', () => {
    const now = new Date(2026, 10, 16)
    const bumped = bumpDay([], 'known', now)
    expect(bumped).toEqual([{ date: todayKey(now), known: 1, cards: 0, quizzes: 0 }])
    const many = Array.from({ length: 45 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      known: 999,
      cards: 0,
      quizzes: 0,
    }))
    expect(normalizeDays(many).every((day) => day.known === 99)).toBe(true)
    expect(normalizeDays(many)).toHaveLength(40)
  })

  it('错题同一条不重复入册，最新的在前，最多 40 道', () => {
    const existing = normalizeMisses([
      { id: 'm1', lectureId: 'L1', prompt: '光反应在哪', explain: '类囊体', at: 1 },
    ])
    const merged = mergeMisses(existing, 'L1', [{ prompt: '光反应在哪', explain: '类囊体' }], 9)
    expect(merged).toHaveLength(1)
    const more = mergeMisses(existing, 'L1', [{ prompt: '暗反应在哪', explain: '基质' }], 9)
    expect(more[0].prompt).toBe('暗反应在哪')
    expect(more).toHaveLength(2)
  })

  it('今日提示把这一坐、卡片、错题说清楚', () => {
    expect(
      todayBrief({ name: '', window: 'evening', streak: 3, sittings: 0, due: 0, misses: 0, knownToday: 1 }),
    ).toContain('没有新的一坐')
    const brief = todayBrief({ name: '小明', window: 'night', streak: 3, sittings: 1, due: 4, misses: 2, knownToday: 1 })
    expect(brief).toContain('小明')
    expect(brief).toContain('睡前')
    expect(brief).toContain('4 张卡片到点了')
    expect(brief).toContain('连续第 3 天')
  })
})

describe('按页汇总', () => {
  it('多页可以同时给出一坐', () => {
    const picks = todaySittings(
      [
        lecture(),
        lecture({ id: 'L2', title: '呼吸作用', units: [unit('u3', '糖酵解的产物', 6)] }),
      ],
      15,
      0,
    )
    expect(picks.map((pick) => pick.lectureId)).toEqual(['L1', 'L2'])
    expect(picks[0].minutes).toBe(9)
    expect(picks[1].minutes).toBe(6)
  })

  it('按科目汇总必考、坑点与还没听懂的必考小讲', () => {
    const rolls = rollCourses([
      lecture({
        known: ['u1'],
        summary: { outline: [], mustKnow: ['光反应条件'], pitfalls: ['记反场所'], mnemonic: '', recital: '' },
      }),
      lecture({
        id: 'L2',
        title: '呼吸作用',
        subject: '生物',
        units: [unit('r1', '呼吸作用的场所', 4, 'support')],
      }),
    ])
    expect(rolls).toHaveLength(1)
    expect(rolls[0].lectures).toHaveLength(2)
    expect(rolls[0].known).toBe(1)
    expect(rolls[0].weak).toEqual(['光反应的场所'])
    expect(rolls[0].mustKnow).toEqual(['光反应条件'])
  })
})

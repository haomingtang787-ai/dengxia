import { describe, expect, it } from 'vitest'
import { DEFAULT_HABITS, type Habits } from '../src/teaching/habits'
import {
  buildRhythm,
  firstSitting,
  joinTitles,
  sittingSentence,
  type PlanUnit,
} from '../src/teaching/plan'

const UNITS: PlanUnit[] = [
  { id: 'u1', title: '光合作用的组成', minutes: 4, weight: 'core' },
  { id: 'u2', title: '光反应的场所和过程', minutes: 5, weight: 'core' },
  { id: 'u3', title: '暗反应的场所', minutes: 5, weight: 'support' },
  { id: 'u4', title: '能量的转换', minutes: 6, weight: 'core' },
]

const H: Habits = { ...DEFAULT_HABITS, minutes: 15 }
const TODAY = new Date(2026, 10, 16)

describe('这一坐', () => {
  it('按分钟数把小讲从前往后装进一坐', () => {
    const sitting = firstSitting(UNITS, [], 15, 0)
    expect(sitting.map((unit) => unit.id)).toEqual(['u1', 'u2', 'u3'])
    expect(sitting.reduce((sum, unit) => sum + unit.minutes, 0)).toBe(14)
  })

  it('第一讲比一坐还长时也要上一讲，不给出空的一坐', () => {
    const long: PlanUnit[] = [{ id: 'x', title: '很长的一讲', minutes: 30, weight: 'core' }]
    expect(firstSitting(long, [], 15, 0)).toHaveLength(1)
  })

  it('连续放慢时每天只上一讲', () => {
    expect(firstSitting(UNITS, [], 15, 2).map((unit) => unit.id)).toEqual(['u1'])
  })

  it('点过听懂的会让开，全懂就没有这一坐', () => {
    expect(firstSitting(UNITS, ['u1', 'u2'], 15, 0).map((unit) => unit.id)).toEqual(['u3', 'u4'])
    expect(firstSitting(UNITS, ['u1', 'u2', 'u3', 'u4'], 15, 0)).toEqual([])
  })

  it('这一坐要能用一句人话说出来', () => {
    const sitting = firstSitting(UNITS, [], 15, 0)
    const line = sittingSentence(sitting, H, 0, false)
    expect(line).toContain('按你每次 15 分钟')
    expect(line).toContain('晚上')
    expect(line).toContain('大约 14 分钟')
    expect(line).toContain('「光合作用的组成」')
    expect(line).toContain('「暗反应的场所」')
  })

  it('放慢时的措辞是「只上」，不给一个多讲的承诺', () => {
    const line = sittingSentence(firstSitting(UNITS, [], 15, 2), H, 2, false)
    expect(line).toContain('只上')
    expect(line).toContain('「光合作用的组成」')
    expect(line).not.toContain('暗反应')
  })

  it('全懂 / 还没拆讲 各有一句话', () => {
    expect(sittingSentence([], H, 0, true)).toContain('都点过听懂了')
    expect(sittingSentence([], H, 0, false)).toContain('拆成小讲')
  })

  it('标题用顿号加「和」连接，不堆一列逗号', () => {
    expect(joinTitles(['A'])).toBe('「A」')
    expect(joinTitles(['A', 'B'])).toBe('「A」和「B」')
    expect(joinTitles(['A', 'B', 'C'])).toBe('「A」、「B」和「C」')
  })
})

describe('课表节奏', () => {
  it('没填考试日时，先按每次的分钟数往后排', () => {
    const rhythm = buildRhythm({ units: UNITS, knownIds: [], habits: H, slowTaps: 0, examDate: '', today: TODAY })
    expect(rhythm.days.length).toBeGreaterThanOrEqual(1)
    expect(rhythm.days.flatMap((day) => day.titles)).toHaveLength(UNITS.length)
    expect(rhythm.note).toContain('还没填考试日')
  })

  it('考试日在前面时，最后一天是考试日且不讲新的', () => {
    const rhythm = buildRhythm({
      units: UNITS,
      knownIds: [],
      habits: H,
      slowTaps: 0,
      examDate: '2026-11-30',
      today: TODAY,
    })
    const last = rhythm.days[rhythm.days.length - 1]
    expect(last.label).toBe('考试日')
    expect(last.detail).toBe('不讲新的')
  })

  it('日子太紧时只排必考，选读放进 aside', () => {
    const heavy: PlanUnit[] = [
      { id: 'c1', title: '必考一', minutes: 20, weight: 'core' },
      { id: 'c2', title: '必考二', minutes: 20, weight: 'core' },
      { id: 'c3', title: '必考三', minutes: 20, weight: 'core' },
      { id: 's1', title: '选读一', minutes: 20, weight: 'support' },
      { id: 's2', title: '选读二', minutes: 20, weight: 'support' },
      { id: 's3', title: '选读三', minutes: 20, weight: 'support' },
      { id: 's4', title: '选读四', minutes: 20, weight: 'support' },
      { id: 's5', title: '选读五', minutes: 20, weight: 'support' },
    ]
    const rhythm = buildRhythm({
      units: heavy,
      knownIds: [],
      habits: { ...DEFAULT_HABITS, minutes: 25 },
      slowTaps: 0,
      examDate: '2026-11-19',
      today: TODAY,
    })
    expect(
      rhythm.days.filter((day) => day.label !== '考试日').flatMap((day) => day.titles),
    ).toEqual(['必考一', '必考二', '必考三'])
    expect(rhythm.aside).toHaveLength(5)
    expect(rhythm.note).toContain('日子有些紧')
  })

  it('考试日过去了就不赶，也不再摆一个考试日', () => {
    const rhythm = buildRhythm({
      units: UNITS,
      knownIds: [],
      habits: H,
      slowTaps: 0,
      examDate: '2026-11-10',
      today: TODAY,
    })
    expect(rhythm.days.some((day) => day.label === '考试日')).toBe(false)
    expect(rhythm.note).toContain('考试日已经过了')
  })

  it('全听懂时不再排日子', () => {
    const rhythm = buildRhythm({
      units: UNITS,
      knownIds: ['u1', 'u2', 'u3', 'u4'],
      habits: H,
      slowTaps: 0,
      examDate: '',
      today: TODAY,
    })
    expect(rhythm.days).toEqual([])
    expect(rhythm.note).toContain('都听懂了')
  })
})

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HABITS,
  habitBrief,
  habitStamp,
  remembers,
  sanitizeHabits,
  styleLabel,
  windowLabel,
  type Habits,
} from '../src/teaching/habits'

const NAMED: Habits = { ...DEFAULT_HABITS, name: '小明', minutes: 15 }

describe('习惯画像', () => {
  it('坏输入整体回落到默认习惯', () => {
    expect(sanitizeHabits(null)).toEqual(DEFAULT_HABITS)
    expect(sanitizeHabits({ pace: 'wild', style: 'nope', window: 'noon', avoid: 'x' })).toEqual(DEFAULT_HABITS)
  })

  it('分钟只认 15 / 25 / 40，其它值回到 25', () => {
    expect(sanitizeHabits({ minutes: 30 }).minutes).toBe(25)
    expect(sanitizeHabits({ minutes: 15 }).minutes).toBe(15)
    expect(sanitizeHabits({ minutes: 40 }).minutes).toBe(40)
  })

  it('名字压掉多余空格并截到 16 字', () => {
    expect(sanitizeHabits({ name: '  小   明  ' }).name).toBe('小 明')
    expect(sanitizeHabits({ name: '一二三四五六七八九十一二三四五六七八' }).name).toHaveLength(16)
  })

  it('习惯指纹随任一维度变化', () => {
    expect(habitStamp(DEFAULT_HABITS)).not.toBe(habitStamp(NAMED))
  })

  it('给模型的口吻里，点名的人最多称呼两次', () => {
    const brief = habitBrief(NAMED)
    expect(brief).toContain('「小明」')
    expect(brief).toContain('最多称呼两次')
    expect(brief).toContain('15 分钟')
  })

  it('没留名字时不许模型编造姓名', () => {
    const brief = habitBrief(DEFAULT_HABITS)
    expect(brief).toContain('不要编造姓名')
    expect(brief).not.toContain('称呼为')
  })

  it('讲透 / 适中 / 抓考点 给出不同的讲解字数', () => {
    expect(habitBrief({ ...DEFAULT_HABITS, pace: 'slow' })).toContain('一百六到两百四十字')
    expect(habitBrief({ ...DEFAULT_HABITS, pace: 'steady' })).toContain('一百二到一百八十字')
    expect(habitBrief({ ...DEFAULT_HABITS, pace: 'exam' })).toContain('九十到一百四十字')
  })

  it('连续放慢两次才会改成每天一小讲', () => {
    expect(remembers(DEFAULT_HABITS, 0)).not.toContain('每天一小讲')
    expect(remembers(DEFAULT_HABITS, 2)).toContain('每天一小讲')
  })

  it('标签是给人看的，不是枚举值', () => {
    expect(windowLabel('night')).toBe('睡前')
    expect(styleLabel('ask')).toBe('先提问')
  })
})

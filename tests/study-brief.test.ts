import { describe, expect, it } from 'vitest'
import { DEFAULT_HABITS } from '../src/teaching/habits'
import { parseStudyPlan } from '../src/study/parse'
import { buildStudyChatPrompt, buildStudyPlanPrompt } from '../src/study/prompt'
import type { StudyUnit } from '../src/shared/study'

function planUnits(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    title: `导览 ${index + 1}`,
    source: `第 ${index + 1} 页`,
    minutes: 5,
    keyPoints: [`要点 ${index + 1}`],
    segments: [
      { source: `第 ${index + 1} 页原文`, explain: '先看清这一句在讲什么。', check: '' },
      { source: `第 ${index + 1} 页原文`, explain: '再想它和前后内容的关系。', check: '' },
    ],
  }))
}

function plan(count: number) {
  return JSON.stringify({
    title: '导览课',
    subject: '数学',
    overview: '这份材料的主干。',
    opening: '先给你一版导览。',
    units: planUnits(count),
  })
}

function studyUnit(): StudyUnit {
  return {
    id: 'unit-1',
    ordinal: 0,
    title: '主干',
    source: '第 1 页',
    minutes: 5,
    keyPoints: ['先看清整体'],
    segments: [
      { source: '原文一', explain: '这句讲的是主干。', check: '' },
      { source: '原文二', explain: '这句讲的是关系。', check: '' },
    ],
  }
}

describe('1.0.4 导览式首版', () => {
  it('拆课提示词先生成导览，而不是一次拆到 24 讲', () => {
    const prompt = buildStudyPlanPrompt({
      title: '线性代数',
      subject: '数学',
      material: '第 1 页 1+1=2。第 2 页 矩阵乘法。',
      habits: DEFAULT_HABITS,
      truncated: false,
    })
    expect(prompt.system).toContain('导览')
    expect(prompt.system).toContain('1 到 4 讲')
    expect(prompt.system).toContain('1+1')
    expect(prompt.system).not.toContain('1 到 24 讲')
  })

  it('首版解析最多 6 讲，超过就交给重试', () => {
    expect(() => parseStudyPlan(plan(7), { title: '导览课', subject: '数学' }))
      .toThrow(/最多 6 讲/)
  })

  it('聊天提示词明确导览课按学生追问再展开', () => {
    const unit = studyUnit()
    const prompt = buildStudyChatPrompt({
      overview: '整门课的主干。',
      outline: ['主干'],
      units: [unit],
      unit,
      messages: [],
      question: '这一讲再详细讲讲。',
      habits: DEFAULT_HABITS,
    })
    expect(prompt.system).toContain('导览课')
    expect(prompt.system).toContain('详细讲')
    expect(prompt.user).toContain('这一讲再详细讲讲。')
  })
})

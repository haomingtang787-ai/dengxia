import { describe, expect, it } from 'vitest'
import { FEATURE_LABELS, HELP_FOOTER, HELP_SECTIONS, HELP_STEPS } from '../src/renderer/study/guide'

describe('使用指南与入口命名', () => {
  it('四个含糊入口都换成了用户能看懂的名字', () => {
    expect(FEATURE_LABELS).toMatchObject({
      review: '复习与错题',
      context: '本讲资料',
      materials: '课件总览',
      manage: '课件管理',
      model: '模型设置',
      backup: '备份与恢复',
    })
  })

  it('上手流程只有三步，并且每一步都指向具体动作', () => {
    expect(HELP_STEPS.map((step) => step.title)).toEqual(['新建课程', '导入课件', '点一讲，直接问'])
    expect(HELP_STEPS[2].body).toContain('在下面输入问题')
  })

  it('指南把每个主入口都解释了一遍', () => {
    const guide = JSON.stringify([HELP_STEPS, HELP_SECTIONS, HELP_FOOTER])
    for (const label of Object.values(FEATURE_LABELS)) expect(guide).toContain(label)
    expect(guide).toContain('不是重新上课')
    expect(guide).toContain('整个资料库')
    expect(guide).toContain('不是导出某一份课件')
  })

  it('指南里不再出现内部术语', () => {
    const guide = JSON.stringify([HELP_STEPS, HELP_SECTIONS, HELP_FOOTER])
    expect(guide).not.toContain('生成物')
    expect(guide).not.toContain('到点卡片')
  })
})

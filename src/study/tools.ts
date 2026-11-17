import type {
  StudyOutlineItem,
  StudySearchMatch,
  StudySkill,
  StudyToolKind,
  StudyUnit,
} from '../shared/study'

/** 技能不是七套提示词同时叠；这里只负责选一个主技能。 */
const SKILL_RULES: Array<{ skill: Exclude<StudySkill, 'auto'>; pattern: RegExp }> = [
  { skill: 'teachback', pattern: /我讲给你听|我来讲|复述|讲给你听|换我讲|teach\s*back/i },
  { skill: 'quiz', pattern: /考考我|出题|测一测|测验|小测|quiz/i },
  { skill: 'error', pattern: /我哪里错|错在哪|错因|为什么错|哪里出问题/i },
  { skill: 'review', pattern: /安排.{0,4}复习|复习计划|怎么复习|帮我复习|复习一下/i },
  { skill: 'diagnose', pattern: /带我学|先问我|诊断|从哪开始|不知道从哪/i },
  { skill: 'socratic', pattern: /多问我|追问|苏格拉底|一步步问|别直接告诉我/i },
]

export const STUDY_SKILLS: Array<Exclude<StudySkill, 'auto'>> = [
  'diagnose',
  'explain',
  'socratic',
  'quiz',
  'error',
  'review',
  'teachback',
]

export function isStudySkill(value: unknown): value is StudySkill {
  return typeof value === 'string' && (value === 'auto' || (STUDY_SKILLS as string[]).includes(value))
}

export function routeStudySkill(text: string, requested: StudySkill = 'auto'): Exclude<StudySkill, 'auto'> {
  if (requested !== 'auto') return requested
  const normalized = text.trim()
  if (!normalized) return 'explain'
  for (const rule of SKILL_RULES) {
    if (rule.pattern.test(normalized)) return rule.skill
  }
  return 'explain'
}

/**
 * 用户直接说「找原文 / 总结这一讲 / 列大纲 / 考考我 / 我讲给你听」时，
 * 先走一次性工具，而不是把它当成普通聊天。返回 null 时继续正常讲解。
 */
export function routeStudyToolIntent(text: string): StudyToolKind | null {
  const normalized = text.trim()
  if (!normalized) return null
  if (/我讲给你听|我来讲|复述给你听|换我讲|讲给你听/i.test(normalized)) {
    if (teachbackAnswerFrom(normalized).length >= 20) return 'teachback'
  }
  if (/考考我|出题|题测|出[一两三1-3]?道题|测一测|小测|quiz/i.test(normalized)) return 'quiz'
  if (/复习大纲|课程大纲|列.{0,4}大纲|大纲/i.test(normalized)) return 'outline'
  if (/总结(这一讲|这讲|这门课|整门课|一下)|帮我总结|概括一下|^总结[一下]?[。！？!?]?$/i.test(normalized)) return 'summary'
  if (/找原文|读原文|搜一下|查一下|在哪一页|哪里讲过|在哪儿讲过|在哪讲过/i.test(normalized)) {
    if (searchQueryFrom(normalized)) return 'search'
  }
  return null
}

/** 从「找原文：正交」里取查找词；去掉触发词和问号，不替用户扩写。 */
export function searchQueryFrom(text: string): string {
  return text
    .replace(/找原文|读原文|搜一下|查一下|在哪儿?讲过?|在哪一页|在哪/g, '')
    .replace(/^[：:，,、\s]+/, '')
    .replace(/[？?。！!\s]+$/g, '')
    .trim()
    .slice(0, 80)
}

/** 从「我讲给你听：……」里取复述正文；没有冒号时只去掉触发词。 */
export function teachbackAnswerFrom(text: string): string {
  const parts = text.split(/[：:]/)
  if (parts.length > 1) return parts.slice(1).join('：').trim()
  return text.replace(/我讲给你听|我来讲|复述给你听|换我讲|讲给你听/g, '').trim()
}

/** 只注入一段最具体的技能约束；失败或模型不遵守时，普通讲解仍然可用。 */
export function studySkillBrief(skill: Exclude<StudySkill, 'auto'>): string {
  switch (skill) {
    case 'diagnose':
      return '这次用「诊断」技能：先别急着讲完。一次只问一个前置问题，最多 2 到 3 个；学生说“直接讲”就立刻停问，改为讲解。不要假装已经完成诊断。'
    case 'socratic':
      return '这次用「追问」技能：一次只问一个 why / how / 如果…会怎样的问题；不要替学生回答，等学生答完再继续。学生要求直接讲时停止追问。'
    case 'quiz':
      return '这次用「测验」技能：出 1 到 3 道主动回忆题，先让学生作答，再判对错；题面不要提前泄露答案。错题要指出错在概念、步骤还是审题，不能只写“粗心”。'
    case 'error':
      return '这次用「错因」技能：把问题拆成概念错、步骤错、审题错三类，必须引用原文或学生原话作证据；没有证据就不要把原因归成“粗心”。'
    case 'review':
      return '这次用「复习」技能：结合到期卡、错题和老师手记安排下一次坐多久、先看哪一讲；一次最多安排 10 张卡，不要把所有内容塞满。'
    case 'teachback':
      return '这次用「复述」技能：让学生用自己的话讲，不要替学生讲完。只按原文指出具体缺口，不虚假夸奖；学生讲对的部分要明确说对在哪里。'
    case 'explain':
    default:
      return '这次用「讲解」技能：先接住学生的问题，再给例子 → 规则 → 反例 → 一句话总结；必须贴原文，不要写成教科书目录。'
  }
}

function lower(value: string): string {
  return value.toLocaleLowerCase()
}

/** 只查当前课程材料；命中必须能回到讲次和原句，没命中就返回空数组。 */
export function searchStudyUnits(units: StudyUnit[], query: string, limit = 8): StudySearchMatch[] {
  const needle = lower(query.trim())
  if (!needle) return []
  const matches: StudySearchMatch[] = []
  for (const unit of units) {
    const titleHit = lower(`${unit.title} ${unit.keyPoints.join(' ')}`).includes(needle)
    const segmentHit = unit.segments.some((segment) =>
      lower(`${segment.source} ${segment.explain} ${segment.check}`).includes(needle),
    )
    if (!titleHit && !segmentHit) continue
    if (titleHit && !segmentHit) {
      const segment = unit.segments[0]
      if (segment) {
        matches.push({
          unitOrdinal: unit.ordinal,
          unitTitle: unit.title,
          segmentIndex: 0,
          source: segment.source,
          excerpt: segment.source,
        })
      }
      continue
    }
    for (const [segmentIndex, segment] of unit.segments.entries()) {
      const haystack = lower(`${segment.source} ${segment.explain} ${segment.check}`)
      if (!haystack.includes(needle)) continue
      matches.push({
        unitOrdinal: unit.ordinal,
        unitTitle: unit.title,
        segmentIndex,
        source: segment.source,
        excerpt: segment.source,
      })
      if (matches.length >= limit) return matches
    }
  }
  return matches.slice(0, limit)
}

/** 大纲只从课程结构抽，不凭空加章节；单讲模式只返回这一讲。 */
export function outlineStudyUnits(units: StudyUnit[], unitOrdinal?: number | null): StudyOutlineItem[] {
  const scoped = unitOrdinal == null ? units : units.filter((unit) => unit.ordinal === unitOrdinal)
  return scoped.map((unit) => ({
    title: unit.title,
    points: unit.keyPoints.slice(0, 8),
    source: unit.source,
  }))
}

/** 供总结/题测/复述提示词使用的材料范围；不把整门课所有对话塞进去。 */
export function studyMaterial(units: StudyUnit[], unitOrdinal?: number | null): string {
  const scoped = unitOrdinal == null ? units : units.filter((unit) => unit.ordinal === unitOrdinal)
  return scoped
    .map((unit) => [
      `第 ${unit.ordinal + 1} 讲《${unit.title}》（${unit.source}）`,
      `必须掌握：${unit.keyPoints.join('；')}`,
      ...unit.segments.map((segment, index) =>
        `${index + 1}. 原文：${segment.source}\n   讲解：${segment.explain}${segment.check ? `\n   曾问：${segment.check}` : ''}`,
      ),
    ].join('\n'))
    .join('\n\n')
}

export function citationsForUnits(units: StudyUnit[], unitOrdinal?: number | null) {
  const scoped = unitOrdinal == null ? units : units.filter((unit) => unit.ordinal === unitOrdinal)
  return scoped.flatMap((unit) =>
    unit.segments.map((segment, segmentIndex) => ({
      unitOrdinal: unit.ordinal,
      unitTitle: unit.title,
      segmentIndex,
      source: segment.source,
    })),
  ).slice(0, 12)
}

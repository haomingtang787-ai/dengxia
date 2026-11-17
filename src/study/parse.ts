import { ArgumentError } from '../domain/validation'
import type { StudySegment, StudySummary } from '../shared/study'
import { TEACHER_MEMORY_KINDS, type TeacherMemoryKind, type TeacherObservation } from '../shared/teacher'

export type StudyPlanDraft = {
  title: string
  subject: string
  overview: string
  opening: string
  units: Array<{
    title: string
    source: string
    minutes: number
    keyPoints: string[]
    segments: StudySegment[]
  }>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function stringList(value: unknown): string[] {
  return list(value).map((item) => text(item)).filter(Boolean)
}

function unwrap(raw: string): string {
  const cleaned = raw.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new ArgumentError('模型返回的内容不是 JSON 格式。')
  return cleaned.slice(start, end + 1)
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

export function parseStudyPlan(
  raw: string,
  meta: { title: string; subject: string },
): StudyPlanDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrap(raw))
  } catch (error) {
    if (error instanceof ArgumentError) throw error
    throw new ArgumentError('模型返回的课程设计不是 JSON 格式。')
  }
  const root = record(parsed)
  const overview = text(root.overview)
  if (!overview) throw new ArgumentError('模型返回的课程设计缺少整份材料总览。')
  const rawUnits = list(root.units)
  if (rawUnits.length === 0) throw new ArgumentError('模型返回的课程设计没有小讲。')
  if (rawUnits.length > 24) throw new ArgumentError('模型返回的小讲超过 24 个，请重试。')

  const units = rawUnits.map((item, index) => {
    const row = record(item)
    const title = text(row.title, `第 ${index + 1} 讲`)
    const source = text(row.source, `第 ${index + 1} 页`)
    const rawSegments = list(row.segments)
    if (rawSegments.length < 2) {
      throw new ArgumentError(`第 ${index + 1} 讲只有 ${rawSegments.length} 个逐句讲解；至少要拆成 2 个讲解层次。`)
    }
    const segments = rawSegments
      .map((segment) => {
        const seg = record(segment)
        return {
          source: text(seg.source),
          explain: text(seg.explain),
          check: text(seg.check),
        }
      })
      .filter((segment) => segment.source && segment.explain)
    if (segments.length === 0) {
      throw new ArgumentError(`第 ${index + 1} 讲没有可用的逐句讲稿。`)
    }
    return {
      title,
      source,
      minutes: clampInt(row.minutes, 3, 15, 6),
      keyPoints: stringList(row.keyPoints).slice(0, 8),
      segments: segments.slice(0, 12),
    }
  })

  return {
    title: text(root.title, meta.title),
    subject: text(root.subject, meta.subject),
    overview,
    opening: text(root.opening),
    units,
  }
}

export type DigestDraft = {
  range: string
  topics: string[]
  keyPoints: string[]
  quotes: string[]
  formulas: string[]
  examples: string[]
  pitfalls: string[]
}

export function parseDigest(raw: string): DigestDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrap(raw))
  } catch (error) {
    if (error instanceof ArgumentError) throw error
    throw new ArgumentError('这一段的理解结果不是 JSON 格式。')
  }
  const root = record(parsed)
  const topics = stringList(root.topics).slice(0, 8)
  const keyPoints = stringList(root.keyPoints).slice(0, 16)
  if (topics.length === 0 && keyPoints.length === 0) {
    throw new ArgumentError('这一段的理解结果没有主题，也没有知识点。')
  }
  return {
    range: text(root.range),
    topics,
    keyPoints,
    quotes: stringList(root.quotes).slice(0, 20),
    formulas: stringList(root.formulas).slice(0, 12),
    examples: stringList(root.examples).slice(0, 8),
    pitfalls: stringList(root.pitfalls).slice(0, 8),
  }
}

export function parseStudySummary(raw: string): StudySummary {
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrap(raw))
  } catch (error) {
    if (error instanceof ArgumentError) throw error
    throw new ArgumentError('模型返回的学习分析不是 JSON 格式。')
  }
  const root = record(parsed)
  const overview = text(root.overview)
  if (!overview) throw new ArgumentError('模型返回的学习分析缺少总览。')
  return {
    overview,
    mastered: stringList(root.mastered).slice(0, 12),
    weak: stringList(root.weak).slice(0, 12),
    pitfalls: stringList(root.pitfalls).slice(0, 12),
    next: stringList(root.next).slice(0, 12),
  }
}

export type TeacherNoteDraft = {
  summary: string
  worked: string[]
  stuck: string[]
  next: string[]
  memories: TeacherObservation[]
}

export type StudyQuizDraft = {
  questions: Array<{ prompt: string; hint: string; source: string }>
}

export type QuizGradeDraft = {
  feedback: string
  gaps: string[]
}

export type TeachbackDraft = {
  feedback: string
  covered: string[]
  gaps: string[]
}

export function parseStudyQuiz(raw: string): StudyQuizDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrap(raw))
  } catch (error) {
    if (error instanceof ArgumentError) throw error
    throw new ArgumentError('模型返回的题测不是 JSON 格式。')
  }
  const root = record(parsed)
  const questions = list(root.questions)
    .map((item) => {
      const row = record(item)
      return {
        prompt: text(row.prompt),
        hint: text(row.hint),
        source: text(row.source),
      }
    })
    .filter((item) => item.prompt && item.source)
    .slice(0, 3)
  if (questions.length === 0) throw new ArgumentError('模型没有返回可用的题测题目。')
  return { questions }
}

export function parseQuizGrade(raw: string): QuizGradeDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrap(raw))
  } catch (error) {
    if (error instanceof ArgumentError) throw error
    throw new ArgumentError('模型返回的判题结果不是 JSON 格式。')
  }
  const root = record(parsed)
  const feedback = text(root.feedback)
  if (!feedback) throw new ArgumentError('模型没有返回判题反馈。')
  return { feedback, gaps: stringList(root.gaps).slice(0, 6) }
}

export function parseTeachback(raw: string): TeachbackDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrap(raw))
  } catch (error) {
    if (error instanceof ArgumentError) throw error
    throw new ArgumentError('模型返回的复述反馈不是 JSON 格式。')
  }
  const root = record(parsed)
  const feedback = text(root.feedback)
  if (!feedback) throw new ArgumentError('模型没有返回复述反馈。')
  return {
    feedback,
    covered: stringList(root.covered).slice(0, 8),
    gaps: stringList(root.gaps).slice(0, 8),
  }
}

export function parseTeacherNote(raw: string): TeacherNoteDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrap(raw))
  } catch (error) {
    if (error instanceof ArgumentError) throw error
    throw new ArgumentError('模型返回的老师手记不是 JSON 格式。')
  }
  const root = record(parsed)
  const summary = text(root.summary)
  if (!summary) throw new ArgumentError('模型返回的老师手记缺少总览。')
  const memories = list(root.memories)
    .map((item) => {
      const row = record(item)
      const kind = text(row.kind)
      const statement = text(row.statement)
      if (!statement || !(TEACHER_MEMORY_KINDS as readonly string[]).includes(kind)) return null
      return {
        kind: kind as TeacherMemoryKind,
        subject: text(row.subject).slice(0, 40),
        concept: text(row.concept).slice(0, 80),
        statement: statement.slice(0, 400),
      } satisfies TeacherObservation
    })
    .filter((item): item is TeacherObservation => Boolean(item))
    .slice(0, 2)
  return {
    summary,
    worked: stringList(root.worked).slice(0, 5),
    stuck: stringList(root.stuck).slice(0, 5),
    next: stringList(root.next).slice(0, 5),
    memories,
  }
}

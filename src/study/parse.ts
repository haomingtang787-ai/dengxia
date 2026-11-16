import { ArgumentError } from '../domain/validation'
import type { StudySegment, StudySummary } from '../shared/study'

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

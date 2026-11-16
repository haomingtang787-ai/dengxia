import { ArgumentError } from '../domain/validation'
import type { TeachingSummary, TeachingTerm, TeachingWeight } from '../shared/teaching'

export type AiLectureDraft = {
  title: string
  subject: string
  greeting: string
  thesis: string
  tonight: string
  nextSitting: string
  units: Array<{
    title: string
    minutes: number
    source: string
    teaching: string
    pause: string
    terms: TeachingTerm[]
    pitfall: string
    weight: TeachingWeight
    example: string
  }>
  summary: TeachingSummary
  cards: Array<{ front: string; back: string }>
  quizzes: Array<{ prompt: string; choices: string[]; answer: number; explain: string }>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringList(value: unknown): string[] {
  return list(value).map((item) => text(item)).filter(Boolean)
}

function minutes(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 4
  return Math.min(12, Math.max(2, Math.round(parsed)))
}

function terms(value: unknown): TeachingTerm[] {
  return list(value)
    .map((item) => {
      const raw = record(item)
      return { word: text(raw.word), meaning: text(raw.meaning) }
    })
    .filter((term) => term.word && term.meaning)
}

function unwrap(text: string): string {
  const cleaned = text.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new ArgumentError('模型返回的内容不是 JSON 格式。')
  return cleaned.slice(start, end + 1)
}

export function parseLectureResponse(
  raw: string,
  meta: { title: string; subject: string; sourceName: string },
): AiLectureDraft {
  let parsed: unknown
  try {
    parsed = JSON.parse(unwrap(raw))
  } catch (error) {
    if (error instanceof ArgumentError) throw error
    throw new ArgumentError('模型返回的讲解不是 JSON 格式。')
  }
  const root = record(parsed)
  const rawUnits = list(root.units)
  if (rawUnits.length === 0) throw new ArgumentError('模型返回的讲解格式不对：没有小讲。')

  const units = rawUnits.map((item, index) => {
    const rawUnit = record(item)
    const teaching = text(rawUnit.teaching)
    if (!teaching) throw new ArgumentError(`模型返回的讲解格式不对：第 ${index + 1} 讲没有讲解。`)
    return {
      title: text(rawUnit.title, `第 ${index + 1} 讲`),
      minutes: minutes(rawUnit.minutes),
      source: text(rawUnit.source, `第 ${index + 1} 段`),
      teaching,
      pause: text(rawUnit.pause),
      terms: terms(rawUnit.terms),
      pitfall: text(rawUnit.pitfall),
      weight: (rawUnit.weight === 'support' ? 'support' : 'core') as TeachingWeight,
      example: text(rawUnit.example),
    }
  })

  const rawSummary = record(root.summary)
  const summary: TeachingSummary = {
    outline: stringList(rawSummary.outline),
    mustKnow: stringList(rawSummary.mustKnow),
    pitfalls: stringList(rawSummary.pitfalls),
    mnemonic: text(rawSummary.mnemonic),
    recital: text(rawSummary.recital),
  }

  const cards = list(root.cards)
    .map((item) => {
      const rawCard = record(item)
      return { front: text(rawCard.front), back: text(rawCard.back) }
    })
    .filter((card) => card.front && card.back)

  const quizzes = list(root.quizzes).map((item, index) => {
    const rawQuiz = record(item)
    const choices = stringList(rawQuiz.choices)
    if (choices.length < 2) throw new ArgumentError(`模型返回的第 ${index + 1} 道题选项少于 2 个。`)
    const answer = rawQuiz.answer
    if (typeof answer !== 'number' || !Number.isInteger(answer) || answer < 0 || answer >= choices.length) {
      throw new ArgumentError(`模型返回的第 ${index + 1} 道题答案超出选项范围。`)
    }
    const prompt = text(rawQuiz.prompt)
    if (!prompt) throw new ArgumentError(`模型返回的第 ${index + 1} 道题没有题干。`)
    return { prompt, choices, answer, explain: text(rawQuiz.explain) }
  })

  return {
    title: text(root.title, meta.title),
    subject: text(root.subject, meta.subject),
    greeting: text(root.greeting),
    thesis: text(root.thesis),
    tonight: text(root.tonight),
    nextSitting: text(root.nextSitting),
    units,
    summary,
    cards,
    quizzes,
  }
}

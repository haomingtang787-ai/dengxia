import { isUuid } from '../domain/ids'
import { ArgumentError, isPlainObject } from '../domain/validation'
import { sanitizeHabits, type Habits } from './habits'
import type { TeachingSummary, TeachingTerm } from '../shared/teaching'

export const TEACHING_LIMITS = {
  units: 40,
  cards: 40,
  quizzes: 20,
  termsPerUnit: 12,
  choicesPerQuiz: 6,
  listItems: 20,
} as const

function text(value: unknown, label: string, max: number, required = true): string {
  if (value === undefined || value === null) {
    if (required) throw new ArgumentError(`${label}不能为空`)
    return ''
  }
  if (typeof value !== 'string') throw new ArgumentError(`${label}必须是文本`)
  const trimmed = value.trim()
  if (required && !trimmed) throw new ArgumentError(`${label}不能为空`)
  if (trimmed.length > max) throw new ArgumentError(`${label}超过 ${max} 字`)
  return trimmed
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ArgumentError(`${label}必须是整数`)
  if (value < min || value > max) throw new ArgumentError(`${label}必须在 ${min} 和 ${max} 之间`)
  return value
}

function stringList(value: unknown, label: string, maxItems: number, maxLen: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ArgumentError(`${label}必须是文本数组`)
  if (value.length > maxItems) throw new ArgumentError(`${label}最多 ${maxItems} 条`)
  return value.map((item, index) => text(item, `${label}第 ${index + 1} 条`, maxLen))
}

function terms(value: unknown, label: string): TeachingTerm[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ArgumentError(`${label}必须是数组`)
  if (value.length > TEACHING_LIMITS.termsPerUnit) throw new ArgumentError(`${label}最多 ${TEACHING_LIMITS.termsPerUnit} 条`)
  return value.map((raw, index) => {
    if (!isPlainObject(raw)) throw new ArgumentError(`${label}第 ${index + 1} 条格式不对`)
    return {
      word: text(raw.word, `${label}第 ${index + 1} 条的词`, 40),
      meaning: text(raw.meaning, `${label}第 ${index + 1} 条的意思`, 120),
    }
  })
}

export type CreateLectureInput = {
  requestId: string
  documentVersionId: string
  title: string
  subject: string
  sourceName: string
  greeting: string
  thesis: string
  tonight: string
  nextSitting: string
  rawText: string
  habitStamp: string
  units: Array<{
    title: string
    minutes: number
    source: string
    teaching: string
    pause: string
    terms: TeachingTerm[]
    pitfall: string
    weight: 'core' | 'support'
    example: string
  }>
  summary: TeachingSummary
  cards: Array<{ front: string; back: string }>
  quizzes: Array<{ prompt: string; choices: string[]; answer: number; explain: string }>
}

export function parseCreateLecture(input: unknown): CreateLectureInput {
  if (!isPlainObject(input)) throw new ArgumentError('建讲解参数必须是对象')
  if (!isUuid(input.requestId)) throw new ArgumentError('requestId 必须是 UUID')
  if (!isUuid(input.documentVersionId)) throw new ArgumentError('documentVersionId 无效')

  const rawUnits = input.units
  if (!Array.isArray(rawUnits) || rawUnits.length === 0) throw new ArgumentError('至少要有一讲')
  if (rawUnits.length > TEACHING_LIMITS.units) throw new ArgumentError(`最多 ${TEACHING_LIMITS.units} 讲`)

  const units = rawUnits.map((raw, index) => {
    if (!isPlainObject(raw)) throw new ArgumentError(`第 ${index + 1} 讲格式不对`)
    const weight: 'core' | 'support' = raw.weight === 'support' ? 'support' : 'core'
    return {
      title: text(raw.title, `第 ${index + 1} 讲的标题`, 80),
      minutes: integer(raw.minutes, `第 ${index + 1} 讲的分钟数`, 1, 120),
      source: text(raw.source, `第 ${index + 1} 讲的来源`, 200, false),
      teaching: text(raw.teaching, `第 ${index + 1} 讲的讲解`, 3000),
      pause: text(raw.pause, `第 ${index + 1} 讲的停顿`, 300, false),
      terms: terms(raw.terms, `第 ${index + 1} 讲的术语`),
      pitfall: text(raw.pitfall, `第 ${index + 1} 讲的坑点`, 300, false),
      weight,
      example: text(raw.example, `第 ${index + 1} 讲的例子`, 500, false),
    }
  })

  const rawSummary = isPlainObject(input.summary) ? input.summary : {}
  const summary: TeachingSummary = {
    outline: stringList(rawSummary.outline, '大纲', 20, 160),
    mustKnow: stringList(rawSummary.mustKnow, '必考', 20, 160),
    pitfalls: stringList(rawSummary.pitfalls, '坑点', 20, 160),
    mnemonic: text(rawSummary.mnemonic, '口诀', 300, false),
    recital: text(rawSummary.recital, '背诵', 300, false),
  }

  const rawCards = input.cards
  if (rawCards !== undefined && !Array.isArray(rawCards)) throw new ArgumentError('卡片必须是数组')
  const cards = (rawCards ?? []).map((raw, index) => {
    if (!isPlainObject(raw)) throw new ArgumentError(`第 ${index + 1} 张卡片格式不对`)
    return {
      front: text(raw.front, `第 ${index + 1} 张卡片的正面`, 300),
      back: text(raw.back, `第 ${index + 1} 张卡片的背面`, 500),
    }
  })
  if (cards.length > TEACHING_LIMITS.cards) throw new ArgumentError(`卡片最多 ${TEACHING_LIMITS.cards} 张`)

  const rawQuizzes = input.quizzes
  if (rawQuizzes !== undefined && !Array.isArray(rawQuizzes)) throw new ArgumentError('题目必须是数组')
  const quizzes = (rawQuizzes ?? []).map((raw, index) => {
    if (!isPlainObject(raw)) throw new ArgumentError(`第 ${index + 1} 道题格式不对`)
    if (!Array.isArray(raw.choices)) throw new ArgumentError(`第 ${index + 1} 道题的选项必须是数组`)
    if (raw.choices.length < 2 || raw.choices.length > TEACHING_LIMITS.choicesPerQuiz) {
      throw new ArgumentError(`第 ${index + 1} 道题要有 2 到 ${TEACHING_LIMITS.choicesPerQuiz} 个选项`)
    }
    const choices = raw.choices.map((choice, choiceIndex) =>
      text(choice, `第 ${index + 1} 道题第 ${choiceIndex + 1} 个选项`, 120),
    )
    const answer = integer(raw.answer, `第 ${index + 1} 道题的答案`, 0, choices.length - 1)
    return {
      prompt: text(raw.prompt, `第 ${index + 1} 道题的题干`, 300),
      choices,
      answer,
      explain: text(raw.explain, `第 ${index + 1} 道题的解释`, 400),
    }
  })
  if (quizzes.length > TEACHING_LIMITS.quizzes) throw new ArgumentError(`题目最多 ${TEACHING_LIMITS.quizzes} 道`)

  return {
    requestId: String(input.requestId).toLowerCase(),
    documentVersionId: String(input.documentVersionId).toLowerCase(),
    title: text(input.title, '标题', 120),
    subject: text(input.subject, '科目', 40, false),
    sourceName: text(input.sourceName, '来源名称', 200, false),
    greeting: text(input.greeting, '开场', 300, false),
    thesis: text(input.thesis, '这一页的主旨', 300, false),
    tonight: text(input.tonight, '这一坐的说明', 300, false),
    nextSitting: text(input.nextSitting, '下一坐', 300, false),
    rawText: text(input.rawText, '原文', 200000, false),
    habitStamp: text(input.habitStamp, '习惯指纹', 200, false),
    units,
    summary,
    cards,
    quizzes,
  }
}

export function parseLectureId(input: unknown): { lectureId: string } {
  if (!isPlainObject(input) || !isUuid(input.lectureId)) throw new ArgumentError('lectureId 无效')
  return { lectureId: String(input.lectureId).toLowerCase() }
}

export function parseMarkKnown(input: unknown): { lectureId: string; unitId: string; known: boolean } {
  const base = parseLectureId(input)
  const body = input as Record<string, unknown>
  if (typeof body.unitId !== 'string' || !/^u\d{1,3}$/.test(body.unitId)) throw new ArgumentError('unitId 无效')
  if (typeof body.known !== 'boolean') throw new ArgumentError('known 必须是布尔值')
  return { ...base, unitId: body.unitId, known: body.known }
}

export function parseCursor(input: unknown): { lectureId: string; cursor: number } {
  const base = parseLectureId(input)
  const body = input as Record<string, unknown>
  if (typeof body.cursor !== 'number' || !Number.isInteger(body.cursor) || body.cursor < 0 || body.cursor > 1000) {
    throw new ArgumentError('cursor 超出允许范围')
  }
  return { ...base, cursor: body.cursor }
}

export function parseGradeCard(input: unknown): { lectureId: string; cardId: string; remembered: boolean } {
  const base = parseLectureId(input)
  const body = input as Record<string, unknown>
  if (typeof body.cardId !== 'string' || !/^c\d{1,3}$/.test(body.cardId)) throw new ArgumentError('cardId 无效')
  if (typeof body.remembered !== 'boolean') throw new ArgumentError('remembered 必须是布尔值')
  return { ...base, cardId: body.cardId, remembered: body.remembered }
}

export function parseAnswerQuiz(input: unknown): { lectureId: string; quizId: string; choice: number } {
  const base = parseLectureId(input)
  const body = input as Record<string, unknown>
  if (typeof body.quizId !== 'string' || !/^q\d{1,3}$/.test(body.quizId)) throw new ArgumentError('quizId 无效')
  if (typeof body.choice !== 'number' || !Number.isInteger(body.choice) || body.choice < 0 || body.choice > 5) {
    throw new ArgumentError('choice 超出允许范围')
  }
  return { ...base, quizId: body.quizId, choice: body.choice }
}

export function parseMissLimit(input: unknown): { limit: number } {
  if (input === undefined) return { limit: teachingLimitDefault() }
  if (!isPlainObject(input)) throw new ArgumentError('错题参数必须是对象')
  const limit = input.limit === undefined ? 40 : integer(input.limit, 'limit', 1, 40)
  return { limit }
}

function teachingLimitDefault(): number {
  return 40
}

export function parseHabits(input: unknown): Habits {
  return sanitizeHabits(input)
}

import { randomUUID } from 'node:crypto'
import { ArgumentError } from '../domain/validation'
import { fail, ok, type ExportPayload, type Result } from '../shared/contract'
import type {
  DayMarkView,
  DueCardList,
  GradeCardResult,
  HabitsView,
  LectureDetail,
  LectureList,
  LectureListItem,
  MissList,
  MissItem,
  QuizAnswerResult,
  ReviewSummary,
  TeachingCard,
  TeachingQuiz,
  TeachingSummary,
  TeachingUnit,
  TeachingWeight,
} from '../shared/teaching'
import type { AppDatabase } from '../storage/database'
import { TeachingStore, type LectureRow, type MissRow } from '../storage/teachingStore'
import { DEFAULT_HABITS, type Habits } from './habits'
import { buildNote } from './note'
import { bumpDay, gradeCard, mergeMisses, todayMark, type DayMark, type Miss } from './study'
import {
  parseAnswerQuiz,
  parseCreateLecture,
  parseCursor,
  parseGradeCard,
  parseHabits,
  parseLectureId,
  parseMarkKnown,
  parseMissLimit,
} from './validation'

class MissingError extends Error {}

export class TeachingService {
  private readonly store: TeachingStore
  private readonly clock: () => number

  constructor(private readonly options: { db: AppDatabase; now?: () => number }) {
    this.store = new TeachingStore(options.db)
    this.clock = options.now ?? (() => Date.now())
  }

  create(body: unknown): Result<LectureListItem> {
    return this.guard(() => {
      const input = parseCreateLecture(body)
      const existing = this.store.lectureByRequest(input.requestId)
      if (existing) return this.listItem(existing)

      const version = this.options.db.get<{ id: string }>(
        'SELECT id FROM document_versions WHERE id = ?',
        input.documentVersionId,
      )
      if (!version) throw new MissingError('这份文稿不在库里。')

      const now = this.clock()
      const row: LectureRow = {
        id: randomUUID(),
        request_id: input.requestId,
        document_version_id: input.documentVersionId,
        title: input.title,
        subject: input.subject || '未分科',
        source_name: input.sourceName,
        greeting: input.greeting,
        thesis: input.thesis,
        tonight: input.tonight,
        next_sitting: input.nextSitting,
        raw_text: input.rawText,
        habit_stamp: input.habitStamp,
        cursor: 0,
        created_at: new Date(now).toISOString(),
      }

      this.options.db.transaction(() => {
        this.store.insertLecture(row)
        input.units.forEach((unit, index) => {
          this.store.insertUnit({
            lecture_id: row.id,
            ordinal: index,
            id: `u${index + 1}`,
            title: unit.title,
            minutes: unit.minutes,
            source: unit.source,
            teaching: unit.teaching,
            pause: unit.pause,
            terms_json: JSON.stringify(unit.terms),
            pitfall: unit.pitfall,
            weight: unit.weight,
            example: unit.example,
          })
        })
        this.store.insertSummary({
          lecture_id: row.id,
          outline_json: JSON.stringify(input.summary.outline),
          must_know_json: JSON.stringify(input.summary.mustKnow),
          pitfalls_json: JSON.stringify(input.summary.pitfalls),
          mnemonic: input.summary.mnemonic,
          recital: input.summary.recital,
        })
        input.cards.forEach((card, index) => {
          this.store.insertCard({
            lecture_id: row.id,
            ordinal: index,
            id: `c${index + 1}`,
            front: card.front,
            back: card.back,
            box: 0,
            due: now,
          })
        })
        input.quizzes.forEach((quiz, index) => {
          this.store.insertQuiz({
            lecture_id: row.id,
            ordinal: index,
            id: `q${index + 1}`,
            prompt: quiz.prompt,
            choices_json: JSON.stringify(quiz.choices),
            answer: quiz.answer,
            explain: quiz.explain,
          })
        })
      })
      return this.listItem(row)
    })
  }

  list(): Result<LectureList> {
    return this.guard(() => ({
      items: this.store.lectures().map((row) => this.listItem(row)),
    }))
  }

  get(body: unknown): Result<LectureDetail> {
    return this.guard(() => {
      const { lectureId } = parseLectureId(body)
      const row = this.store.lecture(lectureId)
      if (!row) throw new MissingError('找不到这份讲解。')
      const summaryRow = this.store.summary(lectureId)
      const units: TeachingUnit[] = this.store.units(lectureId).map((unit) => ({
        id: unit.id,
        title: unit.title,
        minutes: unit.minutes,
        source: unit.source,
        teaching: unit.teaching,
        pause: unit.pause,
        terms: JSON.parse(unit.terms_json) as TeachingUnit['terms'],
        pitfall: unit.pitfall,
        weight: unit.weight === 'support' ? 'support' : 'core',
        example: unit.example,
      }))
      const summary: TeachingSummary = summaryRow
        ? {
            outline: JSON.parse(summaryRow.outline_json) as string[],
            mustKnow: JSON.parse(summaryRow.must_know_json) as string[],
            pitfalls: JSON.parse(summaryRow.pitfalls_json) as string[],
            mnemonic: summaryRow.mnemonic,
            recital: summaryRow.recital,
          }
        : { outline: [], mustKnow: [], pitfalls: [], mnemonic: '', recital: '' }
      const quizzes: TeachingQuiz[] = this.store.quizzes(lectureId).map((quiz) => ({
        id: quiz.id,
        prompt: quiz.prompt,
        choices: JSON.parse(quiz.choices_json) as string[],
      }))
      return {
        ...this.listItem(row),
        greeting: row.greeting,
        thesis: row.thesis,
        tonight: row.tonight,
        nextSitting: row.next_sitting,
        rawText: row.raw_text,
        cursor: row.cursor,
        units,
        summary,
        cards: this.store.cards(lectureId).map((card) => this.card(card)),
        quizzes,
        known: this.store.knownIds(lectureId),
      }
    })
  }

  markKnown(body: unknown): Result<{ known: string[] }> {
    return this.guard(() => {
      const { lectureId, unitId, known } = parseMarkKnown(body)
      const row = this.store.lecture(lectureId)
      if (!row) throw new MissingError('找不到这份讲解。')
      const unit = this.store.units(lectureId).find((item) => item.id === unitId)
      if (!unit) throw new MissingError('找不到这一讲。')
      if (known) {
        const already = this.store.knownIds(lectureId).includes(unitId)
        this.store.markKnown(lectureId, unitId, new Date(this.clock()).toISOString())
        if (!already) this.bump('known')
      } else {
        this.store.unmarkKnown(lectureId, unitId)
      }
      return { known: this.store.knownIds(lectureId) }
    })
  }

  setCursor(body: unknown): Result<{ cursor: number }> {
    return this.guard(() => {
      const { lectureId, cursor } = parseCursor(body)
      const row = this.store.lecture(lectureId)
      if (!row) throw new MissingError('找不到这份讲解。')
      this.store.setCursor(lectureId, cursor)
      return { cursor }
    })
  }

  dueCards(): Result<DueCardList> {
    return this.guard(() => ({
      items: this.store.dueCards(this.clock()).map((row) => ({
        lectureId: row.lecture_id,
        lectureTitle: row.lecture_title,
        card: this.card(row),
      })),
    }))
  }

  gradeCard(body: unknown): Result<GradeCardResult> {
    return this.guard(() => {
      const { lectureId, cardId, remembered } = parseGradeCard(body)
      if (!this.store.lecture(lectureId)) throw new MissingError('找不到这份讲解。')
      const row = this.store.card(lectureId, cardId)
      if (!row) throw new MissingError('找不到这张卡片。')
      const graded = gradeCard(this.card(row), remembered, this.clock())
      this.store.updateCard(lectureId, cardId, graded.box, graded.due, new Date(this.clock()).toISOString())
      this.bump('cards')
      return { card: graded, box: graded.box }
    })
  }

  reviewSummary(): Result<ReviewSummary> {
    return this.guard(() => {
      const now = this.clock()
      const dayStart = new Date(now)
      dayStart.setHours(0, 0, 0, 0)
      const dayEnd = new Date(dayStart)
      dayEnd.setDate(dayEnd.getDate() + 1)
      return {
        due: this.store.dueCards(now).length,
        reviewedToday: this.store.gradedBetween(dayStart.toISOString(), dayEnd.toISOString()),
        misses: this.store.misses().length,
      }
    })
  }

  exportCards(): Result<ExportPayload> {
    return this.guard(() => {
      const rows = this.store.allCards()
      const content = rows
        .map((row) => `${oneLine(row.front)}\t${oneLine(row.back)}`)
        .join('\n')
      return { fileName: `灯下卡片-${localStamp(this.clock())}.txt`, content: content ? `${content}\n` : '' }
    })
  }

  exportMisses(): Result<ExportPayload> {
    return this.guard(() => {
      const rows = this.store.misses()
      const lines = ['# 灯下错题本', `导出时间：${new Date(this.clock()).toLocaleString('zh-CN', { hour12: false })}`, '']
      if (!rows.length) lines.push('还没有错题。')
      rows.forEach((row, index) => {
        const lecture = this.store.lecture(row.lecture_id)
        lines.push(`## ${index + 1}. ${row.prompt}`)
        lines.push('')
        if (lecture) lines.push(`- 来源：${lecture.title}`)
        lines.push(`- 记录时间：${new Date(row.at).toLocaleString('zh-CN', { hour12: false })}`)
        lines.push('')
        lines.push(row.explain)
        lines.push('')
      })
      return { fileName: `灯下错题-${localStamp(this.clock())}.md`, content: `${lines.join('\n').trimEnd()}\n` }
    })
  }

  answerQuiz(body: unknown): Result<QuizAnswerResult> {
    return this.guard(() => {
      const { lectureId, quizId, choice } = parseAnswerQuiz(body)
      if (!this.store.lecture(lectureId)) throw new MissingError('找不到这份讲解。')
      const quiz = this.store.quiz(lectureId, quizId)
      if (!quiz) throw new MissingError('找不到这道题。')
      const choices = JSON.parse(quiz.choices_json) as string[]
      if (choice >= choices.length) throw new ArgumentError('这个选项不存在')
      const correct = choice === quiz.answer
      let missAdded = false
      if (!correct) {
        const existing = this.store.misses()
        const already = existing.some((miss) => miss.lecture_id === lectureId && miss.prompt === quiz.prompt)
        if (!already) {
          const merged = mergeMisses(
            existing.map((miss) => this.miss(miss)),
            lectureId,
            [{ prompt: quiz.prompt, explain: quiz.explain }],
            this.clock(),
          )
          this.store.replaceMisses(
            merged.map((miss) => ({
              id: miss.id,
              lecture_id: miss.lectureId,
              prompt: miss.prompt,
              explain: miss.explain,
              at: miss.at,
            })),
          )
          missAdded = true
        }
      }
      this.bump('quizzes')
      return { correct, explain: quiz.explain, missAdded }
    })
  }

  misses(body?: unknown): Result<MissList> {
    return this.guard(() => {
      const { limit } = parseMissLimit(body)
      return { items: this.store.misses().slice(0, limit).map((miss) => this.missItem(miss)) }
    })
  }

  note(body: unknown): Result<{ text: string }> {
    return this.guard(() => {
      const { lectureId } = parseLectureId(body)
      const detail = this.get({ lectureId })
      if (!detail.ok) throw new MissingError(detail.error.message)
      const misses = this.misses({ limit: 40 })
      if (!misses.ok) throw new MissingError(misses.error.message)
      const due = this.dueCards()
      if (!due.ok) throw new MissingError(due.error.message)
      const now = new Date(this.clock())
      return {
        text: buildNote({
          detail: detail.data,
          misses: misses.data.items,
          dueCount: due.data.items.length,
          now,
        }),
      }
    })
  }

  habits(): Result<HabitsView> {
    return this.guard(() => this.habitsView())
  }

  saveHabits(body: unknown): Result<HabitsView> {
    return this.guard(() => {
      const habits = parseHabits(body)
      this.store.saveHabits(
        {
          name: habits.name,
          pace: habits.pace,
          style: habits.style,
          minutes: habits.minutes,
          window: habits.window,
          avoid: habits.avoid,
        },
        new Date(this.clock()).toISOString(),
      )
      return this.habitsView()
    })
  }

  today(): Result<DayMarkView> {
    return this.guard(() => todayMark(this.store.dayMarks(), new Date(this.clock())))
  }

  private habitsView(): HabitsView {
    const row = this.store.habits()
    if (!row) return { ...DEFAULT_HABITS }
    const habits = parseHabits(row) as Habits
    return {
      name: habits.name,
      pace: habits.pace,
      style: habits.style,
      minutes: habits.minutes,
      window: habits.window,
      avoid: habits.avoid,
    }
  }

  private listItem(row: LectureRow): LectureListItem {
    return {
      lectureId: row.id,
      documentVersionId: row.document_version_id,
      title: row.title,
      subject: row.subject,
      sourceName: row.source_name,
      unitCount: this.store.units(row.id).length,
      knownCount: this.store.knownIds(row.id).length,
      createdAt: row.created_at,
    }
  }

  private card(row: { id: string; front: string; back: string; box: number; due: number }): TeachingCard {
    return { id: row.id, front: row.front, back: row.back, box: row.box, due: row.due }
  }

  private miss(row: MissRow): Miss {
    return { id: row.id, lectureId: row.lecture_id, prompt: row.prompt, explain: row.explain, at: row.at }
  }

  private missItem(row: MissRow): MissItem {
    return { id: row.id, lectureId: row.lecture_id, prompt: row.prompt, explain: row.explain, at: row.at }
  }

  private bump(field: 'known' | 'cards' | 'quizzes'): void {
    const rows = this.store.dayMarks() as DayMark[]
    this.store.replaceDayMarks(bumpDay(rows, field, new Date(this.clock())))
  }

  private guard<T>(fn: () => T): Result<T> {
    const requestId = randomUUID()
    try {
      return ok(requestId, fn())
    } catch (error) {
      if (error instanceof ArgumentError) return fail(requestId, 'INVALID_ARGUMENT', error.message)
      if (error instanceof MissingError) return fail(requestId, 'NOT_FOUND', error.message)
      console.error('teaching', error)
      return fail(requestId, 'STORAGE_ERROR', '本机处理出现未预期的错误。')
    }
  }
}

export type { TeachingWeight }

function oneLine(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

function localStamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

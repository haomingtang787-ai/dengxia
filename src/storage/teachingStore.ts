import type { AppDatabase } from './database'

export type LectureRow = {
  id: string
  request_id: string
  document_version_id: string
  title: string
  subject: string
  source_name: string
  greeting: string
  thesis: string
  tonight: string
  next_sitting: string
  raw_text: string
  habit_stamp: string
  cursor: number
  created_at: string
}

export type UnitRow = {
  lecture_id: string
  ordinal: number
  id: string
  title: string
  minutes: number
  source: string
  teaching: string
  pause: string
  terms_json: string
  pitfall: string
  weight: string
  example: string
}

export type SummaryRow = {
  lecture_id: string
  outline_json: string
  must_know_json: string
  pitfalls_json: string
  mnemonic: string
  recital: string
}

export type CardRow = {
  lecture_id: string
  ordinal: number
  id: string
  front: string
  back: string
  box: number
  due: number
}

export type QuizRow = {
  lecture_id: string
  ordinal: number
  id: string
  prompt: string
  choices_json: string
  answer: number
  explain: string
}

export type MissRow = {
  id: string
  lecture_id: string
  prompt: string
  explain: string
  at: number
}

export type HabitRow = {
  name: string
  pace: string
  style: string
  minutes: number
  window: string
  avoid: string
}

export type DayMarkRow = {
  date: string
  known: number
  cards: number
  quizzes: number
}

export class TeachingStore {
  constructor(readonly db: AppDatabase) {}

  lectureByRequest(requestId: string): LectureRow | undefined {
    return this.db.get<LectureRow>('SELECT * FROM lectures WHERE request_id = ?', requestId)
  }

  insertLecture(row: LectureRow): void {
    this.db.run(
      `INSERT INTO lectures(
        id, request_id, document_version_id, title, subject, source_name, greeting, thesis,
        tonight, next_sitting, raw_text, habit_stamp, cursor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.request_id,
      row.document_version_id,
      row.title,
      row.subject,
      row.source_name,
      row.greeting,
      row.thesis,
      row.tonight,
      row.next_sitting,
      row.raw_text,
      row.habit_stamp,
      row.cursor,
      row.created_at,
    )
  }

  insertUnit(row: Omit<UnitRow, 'lecture_id' | 'ordinal'> & { lecture_id: string; ordinal: number }): void {
    this.db.run(
      `INSERT INTO lecture_units(
        lecture_id, ordinal, id, title, minutes, source, teaching, pause, terms_json, pitfall, weight, example
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.lecture_id,
      row.ordinal,
      row.id,
      row.title,
      row.minutes,
      row.source,
      row.teaching,
      row.pause,
      row.terms_json,
      row.pitfall,
      row.weight,
      row.example,
    )
  }

  insertSummary(row: SummaryRow): void {
    this.db.run(
      `INSERT INTO lecture_summaries(lecture_id, outline_json, must_know_json, pitfalls_json, mnemonic, recital)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.lecture_id,
      row.outline_json,
      row.must_know_json,
      row.pitfalls_json,
      row.mnemonic,
      row.recital,
    )
  }

  insertCard(row: CardRow): void {
    this.db.run(
      `INSERT INTO lecture_cards(lecture_id, ordinal, id, front, back, box, due) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.lecture_id,
      row.ordinal,
      row.id,
      row.front,
      row.back,
      row.box,
      row.due,
    )
  }

  insertQuiz(row: QuizRow): void {
    this.db.run(
      `INSERT INTO lecture_quizzes(lecture_id, ordinal, id, prompt, choices_json, answer, explain)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.lecture_id,
      row.ordinal,
      row.id,
      row.prompt,
      row.choices_json,
      row.answer,
      row.explain,
    )
  }

  lecture(id: string): LectureRow | undefined {
    return this.db.get<LectureRow>('SELECT * FROM lectures WHERE id = ?', id)
  }

  lectures(): LectureRow[] {
    return this.db.all<LectureRow>('SELECT * FROM lectures ORDER BY created_at DESC, rowid DESC')
  }

  units(lectureId: string): UnitRow[] {
    return this.db.all<UnitRow>('SELECT * FROM lecture_units WHERE lecture_id = ? ORDER BY ordinal', lectureId)
  }

  summary(lectureId: string): SummaryRow | undefined {
    return this.db.get<SummaryRow>('SELECT * FROM lecture_summaries WHERE lecture_id = ?', lectureId)
  }

  cards(lectureId: string): CardRow[] {
    return this.db.all<CardRow>('SELECT * FROM lecture_cards WHERE lecture_id = ? ORDER BY ordinal', lectureId)
  }

  card(lectureId: string, cardId: string): CardRow | undefined {
    return this.db.get<CardRow>('SELECT * FROM lecture_cards WHERE lecture_id = ? AND id = ?', lectureId, cardId)
  }

  updateCard(lectureId: string, cardId: string, box: number, due: number): void {
    this.db.run('UPDATE lecture_cards SET box = ?, due = ? WHERE lecture_id = ? AND id = ?', box, due, lectureId, cardId)
  }

  dueCards(now: number): Array<CardRow & { lecture_title: string }> {
    return this.db.all<CardRow & { lecture_title: string }>(
      `SELECT c.*, l.title AS lecture_title
       FROM lecture_cards c JOIN lectures l ON l.id = c.lecture_id
       WHERE c.due <= ?
       ORDER BY c.due, l.created_at DESC, c.ordinal`,
      now,
    )
  }

  quizzes(lectureId: string): QuizRow[] {
    return this.db.all<QuizRow>('SELECT * FROM lecture_quizzes WHERE lecture_id = ? ORDER BY ordinal', lectureId)
  }

  quiz(lectureId: string, quizId: string): QuizRow | undefined {
    return this.db.get<QuizRow>('SELECT * FROM lecture_quizzes WHERE lecture_id = ? AND id = ?', lectureId, quizId)
  }

  knownIds(lectureId: string): string[] {
    const rows = this.db.all<{ unit_id: string }>(
      'SELECT unit_id FROM lecture_known WHERE lecture_id = ? ORDER BY unit_id',
      lectureId,
    )
    return rows.map((row) => row.unit_id)
  }

  markKnown(lectureId: string, unitId: string, markedAt: string): void {
    this.db.run(
      'INSERT INTO lecture_known(lecture_id, unit_id, marked_at) VALUES (?, ?, ?) ON CONFLICT(lecture_id, unit_id) DO UPDATE SET marked_at = excluded.marked_at',
      lectureId,
      unitId,
      markedAt,
    )
  }

  unmarkKnown(lectureId: string, unitId: string): void {
    this.db.run('DELETE FROM lecture_known WHERE lecture_id = ? AND unit_id = ?', lectureId, unitId)
  }

  setCursor(lectureId: string, cursor: number): void {
    this.db.run('UPDATE lectures SET cursor = ? WHERE id = ?', cursor, lectureId)
  }

  misses(): MissRow[] {
    return this.db.all<MissRow>('SELECT * FROM misses ORDER BY at DESC, rowid DESC')
  }

  replaceMisses(rows: MissRow[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM misses')
      for (const row of rows) {
        this.db.run('INSERT INTO misses(id, lecture_id, prompt, explain, at) VALUES (?, ?, ?, ?, ?)',
          row.id, row.lecture_id, row.prompt, row.explain, row.at)
      }
    })
  }

  habits(): HabitRow | undefined {
    return this.db.get<HabitRow>('SELECT * FROM habits WHERE id = 1')
  }

  saveHabits(row: HabitRow, updatedAt: string): void {
    this.db.run(
      `INSERT INTO habits(id, name, pace, style, minutes, window, avoid, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, pace = excluded.pace, style = excluded.style,
         minutes = excluded.minutes, window = excluded.window, avoid = excluded.avoid,
         updated_at = excluded.updated_at`,
      row.name,
      row.pace,
      row.style,
      row.minutes,
      row.window,
      row.avoid,
      updatedAt,
    )
  }

  dayMarks(): DayMarkRow[] {
    return this.db.all<DayMarkRow>('SELECT * FROM day_marks ORDER BY date')
  }

  replaceDayMarks(rows: DayMarkRow[]): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM day_marks')
      for (const row of rows) {
        this.db.run('INSERT INTO day_marks(date, known, cards, quizzes) VALUES (?, ?, ?, ?)',
          row.date, row.known, row.cards, row.quizzes)
      }
    })
  }
}

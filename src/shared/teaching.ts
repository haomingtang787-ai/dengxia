export type TeachingTerm = { word: string; meaning: string }

export type TeachingWeight = 'core' | 'support'

export type TeachingUnit = {
  id: string
  title: string
  minutes: number
  source: string
  teaching: string
  pause: string
  terms: TeachingTerm[]
  pitfall: string
  weight: TeachingWeight
  example: string
}

export type TeachingSummary = {
  outline: string[]
  mustKnow: string[]
  pitfalls: string[]
  mnemonic: string
  recital: string
}

export type TeachingCard = {
  id: string
  front: string
  back: string
  box: number
  due: number
  suspended: boolean
  /** lecture = AI 拆课生成的卡；manual = 手动加/摘录的卡。 */
  origin: 'lecture' | 'manual'
  lectureId?: string | null
  documentVersionId?: string | null
  pageId?: string | null
  quote?: string | null
}

export type CardList = { items: TeachingCard[] }

export type CardCreateBody = {
  front: string
  back?: string
  quote?: string
  documentVersionId?: string
  pageId?: string | null
}

export type CardEditBody = {
  origin: 'lecture' | 'manual'
  cardId: string
  lectureId?: string
  front?: string
  back?: string
  suspended?: boolean
}

export type GradeCardBody = {
  origin?: 'lecture' | 'manual'
  lectureId?: string
  cardId: string
  remembered: boolean
}

export type GradeMissBody = { missId: string; remembered: boolean }

/** 详情里不返回 answer / explain，判题在主进程做。 */
export type TeachingQuiz = {
  id: string
  prompt: string
  choices: string[]
}

export type LectureListItem = {
  lectureId: string
  documentVersionId: string
  title: string
  subject: string
  sourceName: string
  unitCount: number
  knownCount: number
  createdAt: string
}

export type LectureDetail = LectureListItem & {
  greeting: string
  thesis: string
  tonight: string
  nextSitting: string
  rawText: string
  cursor: number
  units: TeachingUnit[]
  summary: TeachingSummary
  cards: TeachingCard[]
  quizzes: TeachingQuiz[]
  known: string[]
}

export type LectureList = { items: LectureListItem[] }

export type DueCardItem = {
  origin: 'lecture' | 'manual'
  lectureId: string | null
  lectureTitle: string
  card: TeachingCard
}

export type DueCardList = { items: DueCardItem[] }

export type MissItem = {
  id: string
  lectureId: string
  prompt: string
  explain: string
  at: number
  box?: number
  due?: number
  lastGradedAt?: string | null
}

export type MissList = { items: MissItem[] }

export type HabitsView = {
  name: string
  pace: 'slow' | 'steady' | 'exam'
  style: 'story' | 'define' | 'ask'
  minutes: 15 | 25 | 40
  window: 'morning' | 'afternoon' | 'evening' | 'night'
  avoid: 'formula' | 'long' | 'noexample'
}

export type DayMarkView = { date: string; known: number; cards: number; quizzes: number }

export type CreateLectureBody = {
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
  units: Array<Omit<TeachingUnit, 'id'>>
  summary: TeachingSummary
  cards: Array<{ front: string; back: string }>
  quizzes: Array<{ prompt: string; choices: string[]; answer: number; explain: string }>
}

export type ReviewSummary = {
  due: number
  reviewedToday: number
  misses: number
}

export type GradeCardResult = { card: TeachingCard; box: number }

export type QuizAnswerResult = { correct: boolean; explain: string; missAdded: boolean }

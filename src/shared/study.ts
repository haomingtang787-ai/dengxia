import type { HabitsView } from './teaching'
import type { TeacherNote } from './teacher'

export type StudyStatus = 'ready' | 'finished'

export type StudySegment = {
  source: string
  explain: string
  check: string
}

export type StudyUnit = {
  id: string
  ordinal: number
  title: string
  source: string
  minutes: number
  keyPoints: string[]
  segments: StudySegment[]
}

export type StudyMessageRole = 'user' | 'assistant'

export type StudyMessage = {
  id: string
  sessionId: string
  role: StudyMessageRole
  unitOrdinal: number | null
  content: string
  createdAt: string
}

/** 学生对「停一下」问题的作答。它是学习总结判断掌握程度的直接证据。 */
export type StudyCheck = {
  unitOrdinal: number
  segmentIndex: number
  question: string
  answer: string
  createdAt: string
}

/** 长课件「读懂」阶段的进度，让界面在几分钟的等待里有具体进展可看。 */
export type StudyProgress = {
  phase: 'vision' | 'reading' | 'planning'
  done: number
  total: number
}

export type StudySummary = {
  overview: string
  mastered: string[]
  weak: string[]
  pitfalls: string[]
  next: string[]
}

/** 这门课背后真实花掉的 token：cachedTokens 是服务端前缀缓存命中的部分。 */
export type StudyUsage = {
  calls: number
  promptTokens: number
  cachedTokens: number
  completionTokens: number
}

export type StudySessionListItem = {
  sessionId: string
  documentVersionId: string
  title: string
  subject: string
  sourceName: string
  unitCount: number
  messageCount: number
  status: StudyStatus
  createdAt: string
  updatedAt: string
}

export type StudySessionList = { items: StudySessionListItem[] }

export type StudySessionDetail = StudySessionListItem & {
  overview: string
  outline: string[]
  units: StudyUnit[]
  messages: StudyMessage[]
  checks: StudyCheck[]
  warnings: string[]
  truncated: boolean
  materialChars: number
  materialChunks: number
  habits: HabitsView
  summary: StudySummary | null
  /** 下课自动生成的四段式老师手记；生成失败时为 null，不影响学习总结。 */
  teacherNote: TeacherNote | null
  usage: StudyUsage
}

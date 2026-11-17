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

/** 老师怎么教：0.7.1 起由主进程按自然语言选一个主技能，不把七套提示词叠在一起。 */
export type StudySkill = 'auto' | 'diagnose' | 'explain' | 'socratic' | 'quiz' | 'error' | 'review' | 'teachback'

/** direct 保持 0.6.0 的直接回答；guided 先定位卡点再讲。 */
export type StudyMode = 'direct' | 'guided'

export type StudyToolKind = 'search' | 'summary' | 'outline' | 'quiz' | 'quiz-grade' | 'teachback'

export type StudyCitation = {
  unitOrdinal: number
  unitTitle: string
  segmentIndex: number
  source: string
}

export type StudySearchMatch = {
  unitOrdinal: number
  unitTitle: string
  segmentIndex: number
  source: string
  excerpt: string
}

export type StudyOutlineItem = {
  title: string
  points: string[]
  source: string
}

export type StudyQuizQuestion = {
  id: string
  prompt: string
  hint: string
  source: string
}

export type StudyQuizAnswer = {
  questionId: string
  answer: string
}

/** 工具生成物：只落在课程资料里，不另开页面。 */
export type StudyArtifactKind = 'summary' | 'outline' | 'search' | 'quiz' | 'teachback'

export type StudyArtifact = {
  id: string
  kind: StudyArtifactKind
  scope: string
  title: string
  body: {
    text?: string
    citations?: StudyCitation[]
    items?: StudyOutlineItem[]
    query?: string
    matches?: StudySearchMatch[]
    message?: string
    questions?: StudyQuizQuestion[]
    answers?: StudyQuizAnswer[]
    graded?: boolean
    feedback?: string
    gaps?: string[]
    covered?: string[]
    answer?: string
  }
  createdAt: string
  updatedAt: string
}

/** 这门课背后真实花掉的 token：cachedTokens 是服务端前缀缓存命中的部分。 */
export type StudyUsage = {
  calls: number
  promptTokens: number
  /** promptTokens 里命中前缀缓存的部分。 */
  cachedTokens: number
  /** promptTokens 里未命中的部分；cachedTokens + cacheMissTokens = promptTokens。 */
  cacheMissTokens: number
  completionTokens: number
  /** 输出里用于推理的 token，已包含在 completionTokens 中。 */
  reasoningTokens: number
  /** 供应商真实返回 usage 的调用数。 */
  reportedCalls: number
  /** 供应商没有返回 usage、只能记为 0 的调用数；这些数字不能当真实消耗。 */
  estimatedCalls: number
}

export type StudyUsageKind = StudyUsage & { kind: string }

export type DeepSeekBalanceInfo = {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

export type StudyUsageAudit = {
  usage: StudyUsage
  kinds: StudyUsageKind[]
  balance: DeepSeekBalanceInfo[] | null
  balanceError: string | null
  officialNote: string
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
  /** 老师工具生成的总结、大纲、题测、查找和复述。 */
  artifacts: StudyArtifact[]
  /** 下课自动生成的四段式老师手记；生成失败时为 null，不影响学习总结。 */
  teacherNote: TeacherNote | null
  usage: StudyUsage
}

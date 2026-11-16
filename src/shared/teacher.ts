/** 0.7.0 的老师不是一组按钮，而是一个有人格、有记忆的长期角色。 */

export type TeacherPronoun = 'she' | 'they'

export type TeacherPersona = {
  name: string
  pronoun: TeacherPronoun
  tone: string
  boundaries: string[]
  version: number
  updatedAt: string
}

export type LearnerProfile = {
  goal: string
  level: string
  subjects: string[]
  examDate: string | null
  weeklyMinutes: number
  notes: string
  updatedAt: string
}

export const TEACHER_MEMORY_KINDS = [
  'goal',
  'mastery',
  'misconception',
  'preference',
  'strategy',
  'constraint',
] as const

export type TeacherMemoryKind = (typeof TEACHER_MEMORY_KINDS)[number]

export type TeacherMemory = {
  id: string
  kind: TeacherMemoryKind
  subject: string
  concept: string
  statement: string
  evidence: string
  confidence: number
  sourceSessionId: string | null
  sourceDocumentVersionId: string | null
  /** 已确认的记忆优先进入提示词；“观察/推测”先展示给学生确认。 */
  userConfirmed: boolean
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
  lastSeenAt: string
}

export type TeacherNote = {
  sessionId: string
  summary: string
  worked: string[]
  stuck: string[]
  next: string[]
  createdAt: string
}

export type TeacherOverview = {
  persona: TeacherPersona
  profile: LearnerProfile
  memories: TeacherMemory[]
}

export type TeacherMemoryInput = {
  id?: string
  kind: TeacherMemoryKind
  subject?: string
  concept?: string
  statement: string
  evidence?: string
  confidence?: number
  sourceSessionId?: string | null
  sourceDocumentVersionId?: string | null
  userConfirmed?: boolean
  status?: 'active' | 'archived'
}

export type TeacherPersonaInput = {
  name: string
  pronoun?: TeacherPronoun
  tone?: string
  boundaries?: string[]
}

export type LearnerProfileInput = {
  goal: string
  level: string
  subjects: string[]
  examDate?: string | null
  weeklyMinutes: number
  notes: string
}

/** 注入课程提示词的最小上下文；不把整张记忆表倒进模型。 */
export type TeacherPromptContext = {
  name: string
  pronoun: TeacherPronoun
  tone: string
  boundaries: string[]
  profile: LearnerProfile
  memories: TeacherMemory[]
}

import { randomUUID } from 'node:crypto'
import { ArgumentError, isPlainObject } from '../domain/validation'
import { isUuid } from '../domain/ids'
import { fail, ok, type Result } from '../shared/contract'
import type {
  LearnerProfile,
  LearnerProfileInput,
  TeacherMemory,
  TeacherMemoryInput,
  TeacherMemoryKind,
  TeacherNote,
  TeacherObservation,
  TeacherOverview,
  TeacherPersona,
  TeacherPersonaInput,
  TeacherPromptContext,
} from '../shared/teacher'
import { TEACHER_MEMORY_KINDS } from '../shared/teacher'
import { TeacherStore } from '../storage/teacherStore'

const NAME_MAX = 24
const TONE_MAX = 40
const SHORT_MAX = 120
const SUBJECT_MAX = 40
const MEMORY_STATEMENT_MAX = 400
const MEMORY_EVIDENCE_MAX = 800

function requestId(): string {
  return randomUUID()
}

function text(value: unknown, max: number, label: string, fallback = ''): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new ArgumentError(`${label} 必须是文字。`)
  const trimmed = value.trim()
  if (trimmed.length > max) throw new ArgumentError(`${label} 不能超过 ${max} 个字。`)
  return trimmed
}

function stringList(value: unknown, maxItems: number, maxLength: number, label: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new ArgumentError(`${label} 必须是列表。`)
  const items = value.map((item) => text(item, maxLength, label)).filter(Boolean)
  if (items.length > maxItems) throw new ArgumentError(`${label} 最多 ${maxItems} 项。`)
  return [...new Set(items)]
}

function dateOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ArgumentError('考试日期必须是 YYYY-MM-DD。')
  }
  return value
}

function integer(value: unknown, min: number, max: number, label: string, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ArgumentError(`${label} 必须是整数。`)
  if (value < min || value > max) throw new ArgumentError(`${label} 超出允许范围。`)
  return value
}

function memoryKind(value: unknown): TeacherMemoryKind {
  if (typeof value !== 'string' || !(TEACHER_MEMORY_KINDS as readonly string[]).includes(value)) {
    throw new ArgumentError('记忆类型不在允许范围内。')
  }
  return value as TeacherMemoryKind
}

function personaInput(body: unknown): TeacherPersonaInput {
  if (!isPlainObject(body)) throw new ArgumentError('老师档案参数必须是对象。')
  const name = text(body.name, NAME_MAX, '老师的名字', '老师')
  if (!name) throw new ArgumentError('老师的名字不能为空。')
  const pronoun = body.pronoun === 'they' ? 'they' as const : 'she' as const
  return {
    name,
    pronoun,
    tone: text(body.tone, TONE_MAX, '语气', 'warm-rigorous'),
    boundaries: stringList(body.boundaries, 8, 160, '边界'),
  }
}

function profileInput(body: unknown): LearnerProfileInput & { examDate: string | null } {
  if (!isPlainObject(body)) throw new ArgumentError('学生档案参数必须是对象。')
  return {
    goal: text(body.goal, SHORT_MAX, '目标'),
    level: text(body.level, SHORT_MAX, '水平'),
    subjects: stringList(body.subjects, 8, SUBJECT_MAX, '学科'),
    examDate: dateOrNull(body.examDate),
    weeklyMinutes: integer(body.weeklyMinutes, 0, 10_080, '每周分钟'),
    notes: text(body.notes, 1200, '备注'),
  }
}

function memoryInput(body: unknown): TeacherMemoryInput {
  if (!isPlainObject(body)) throw new ArgumentError('记忆参数必须是对象。')
  const statement = text(body.statement, MEMORY_STATEMENT_MAX, '记忆内容')
  if (!statement) throw new ArgumentError('记忆内容不能为空。')
  const confidence = body.confidence === undefined
    ? 0.5
    : typeof body.confidence === 'number' && body.confidence >= 0 && body.confidence <= 1
      ? body.confidence
      : NaN
  if (!Number.isFinite(confidence)) throw new ArgumentError('置信度必须在 0 到 1 之间。')
  const sourceSessionId = body.sourceSessionId === undefined || body.sourceSessionId === null
    ? null
    : isUuid(body.sourceSessionId) ? body.sourceSessionId : null
  const sourceDocumentVersionId = body.sourceDocumentVersionId === undefined || body.sourceDocumentVersionId === null
    ? null
    : isUuid(body.sourceDocumentVersionId) ? body.sourceDocumentVersionId : null
  return {
    id: body.id === undefined || body.id === null ? undefined : isUuid(body.id) ? body.id : undefined,
    kind: memoryKind(body.kind),
    subject: text(body.subject, SUBJECT_MAX, '学科'),
    concept: text(body.concept, 80, '概念'),
    statement,
    evidence: text(body.evidence, MEMORY_EVIDENCE_MAX, '证据'),
    confidence,
    sourceSessionId,
    sourceDocumentVersionId,
    userConfirmed: body.userConfirmed === true ? true : body.userConfirmed === false ? false : undefined,
    status: body.status === 'archived' ? 'archived' : 'active',
  }
}

function noteInput(body: unknown): {
  sessionId: string
  summary: string
  worked: string[]
  stuck: string[]
  next: string[]
} {
  if (!isPlainObject(body)) throw new ArgumentError('老师手记参数必须是对象。')
  if (!isUuid(body.sessionId)) throw new ArgumentError('课堂标识无效。')
  const summary = text(body.summary, 1200, '手记总览')
  if (!summary) throw new ArgumentError('手记总览不能为空。')
  return {
    sessionId: body.sessionId,
    summary,
    worked: stringList(body.worked, 5, 400, '讲通的内容'),
    stuck: stringList(body.stuck, 5, 400, '卡住的内容'),
    next: stringList(body.next, 5, 400, '下次先做什么'),
  }
}

/** 老师档案/记忆的服务层：只做主进程数据读写，不直接调用模型。 */
export class TeacherService {
  private readonly store: TeacherStore
  private readonly now: () => number

  constructor(options: { db: ConstructorParameters<typeof TeacherStore>[0]; now?: () => number }) {
    this.store = new TeacherStore(options.db)
    this.now = options.now ?? (() => Date.now())
  }

  private at(): string {
    return new Date(this.now()).toISOString()
  }

  overview(): Result<TeacherOverview> {
    const id = requestId()
    try {
      return ok(id, {
        persona: this.store.persona(),
        profile: this.store.profile(),
        memories: this.store.listMemories(),
      })
    } catch (error) {
      return fail(id, 'STORAGE_ERROR', error instanceof Error ? error.message : '读取老师档案失败。')
    }
  }

  savePersona(body: unknown): Result<TeacherPersona> {
    const id = requestId()
    try {
      return ok(id, this.store.savePersona(personaInput(body), this.at()))
    } catch (error) {
      return fail(id, error instanceof ArgumentError ? 'INVALID_ARGUMENT' : 'STORAGE_ERROR', error instanceof Error ? error.message : '保存老师档案失败。')
    }
  }

  saveProfile(body: unknown): Result<LearnerProfile> {
    const id = requestId()
    try {
      return ok(id, this.store.saveProfile(profileInput(body), this.at()))
    } catch (error) {
      return fail(id, error instanceof ArgumentError ? 'INVALID_ARGUMENT' : 'STORAGE_ERROR', error instanceof Error ? error.message : '保存学生档案失败。')
    }
  }

  memoryList(): Result<{ items: TeacherMemory[] }> {
    const id = requestId()
    try {
      return ok(id, { items: this.store.listMemories() })
    } catch (error) {
      return fail(id, 'STORAGE_ERROR', error instanceof Error ? error.message : '读取记忆失败。')
    }
  }

  memorySave(body: unknown): Result<TeacherMemory> {
    const id = requestId()
    try {
      return ok(id, this.store.upsertMemory(memoryInput(body), requestId(), this.at()))
    } catch (error) {
      return fail(id, error instanceof ArgumentError ? 'INVALID_ARGUMENT' : 'STORAGE_ERROR', error instanceof Error ? error.message : '保存记忆失败。')
    }
  }

  memoryDelete(body: unknown): Result<{ deleted: boolean }> {
    const id = requestId()
    try {
      if (!isPlainObject(body) || !isUuid(body.id)) throw new ArgumentError('记忆标识无效。')
      return ok(id, { deleted: this.store.deleteMemory(body.id) })
    } catch (error) {
      return fail(id, error instanceof ArgumentError ? 'INVALID_ARGUMENT' : 'STORAGE_ERROR', error instanceof Error ? error.message : '删除记忆失败。')
    }
  }

  /**
   * 下课时把老师手记里的候选观察写入记忆。观察默认未确认；
   * 同一 kind+subject+concept 不新增重复条，已由学生确认的旧条不会被观察覆盖。
   */
  saveObservations(
    sessionId: string | null,
    documentVersionId: string | null,
    observations: TeacherObservation[],
  ): TeacherMemory[] {
    const saved: TeacherMemory[] = []
    const existing = this.store.listMemories()
    for (const observation of observations.slice(0, 2)) {
      const confirmed = existing.find((item) =>
        item.userConfirmed &&
        item.kind === observation.kind &&
        item.subject === observation.subject &&
        item.concept === observation.concept,
      )
      if (confirmed) continue
      const result = this.memorySave({
        ...observation,
        evidence: '下课时老师手记里的观察',
        confidence: 0.6,
        sourceSessionId: sessionId,
        sourceDocumentVersionId: documentVersionId,
        userConfirmed: false,
        status: 'active',
      })
      if (result.ok) {
        saved.push(result.data)
        existing.push(result.data)
      }
    }
    return saved
  }

  reset(): Result<TeacherOverview> {
    const id = requestId()
    try {
      this.store.reset(this.at())
      return ok(id, {
        persona: this.store.persona(),
        profile: this.store.profile(),
        memories: this.store.listMemories(),
      })
    } catch (error) {
      return fail(id, 'STORAGE_ERROR', error instanceof Error ? error.message : '重置老师档案失败。')
    }
  }

  noteList(): Result<{ items: TeacherNote[] }> {
    const id = requestId()
    try {
      return ok(id, { items: this.store.notes() })
    } catch (error) {
      return fail(id, 'STORAGE_ERROR', error instanceof Error ? error.message : '读取老师手记失败。')
    }
  }

  /** 0.7.0 的 StudyService 用它把下课时的手记落库；失败由调用方决定是否阻断。 */
  saveNote(sessionId: string, note: Omit<TeacherNote, 'sessionId' | 'createdAt'>): TeacherNote {
    return this.store.saveNote({ ...note, sessionId, createdAt: this.at() }, this.at())
  }

  noteForSession(sessionId: string): TeacherNote | null {
    return this.store.note(sessionId)
  }

  noteSave(body: unknown): Result<TeacherNote> {
    const id = requestId()
    try {
      const input = noteInput(body)
      const note = this.store.saveNote({ ...input, createdAt: this.at() }, this.at())
      return ok(id, note)
    } catch (error) {
      return fail(id, error instanceof ArgumentError ? 'INVALID_ARGUMENT' : 'STORAGE_ERROR', error instanceof Error ? error.message : '保存老师手记失败。')
    }
  }

  noteDelete(body: unknown): Result<{ deleted: boolean }> {
    const id = requestId()
    try {
      if (!isPlainObject(body) || !isUuid(body.sessionId)) throw new ArgumentError('课堂标识无效。')
      return ok(id, { deleted: this.store.deleteNote(body.sessionId) })
    } catch (error) {
      return fail(id, error instanceof ArgumentError ? 'INVALID_ARGUMENT' : 'STORAGE_ERROR', error instanceof Error ? error.message : '删除老师手记失败。')
    }
  }

  noteGet(body: unknown): Result<TeacherNote | null> {
    const id = requestId()
    try {
      if (!isPlainObject(body) || !isUuid(body.sessionId)) throw new ArgumentError('课堂标识无效。')
      return ok(id, this.store.note(body.sessionId))
    } catch (error) {
      return fail(id, error instanceof ArgumentError ? 'INVALID_ARGUMENT' : 'STORAGE_ERROR', error instanceof Error ? error.message : '读取老师手记失败。')
    }
  }

  /** 注入提示词的上下文：人格 + 档案 + 最多 6 条、最多 800 字的相关记忆。 */
  context(subject: string, concept = ''): TeacherPromptContext {
    const persona = this.store.persona()
    const profile = this.store.profile()
    const raw = this.store.relevantMemories(subject, concept, 6)
    let budget = 0
    const memories: TeacherMemory[] = []
    for (const memory of raw) {
      const size = memory.statement.length + memory.evidence.length
      if (budget + size > 800) continue
      memories.push(memory)
      budget += size
    }
    return { name: persona.name, pronoun: persona.pronoun, tone: persona.tone, boundaries: persona.boundaries, profile, memories }
  }

  snapshot(): {
    name: string
    pronoun: string
    tone: string
    goal: string
    level: string
    subjects: string[]
    weeklyMinutes: number
  } {
    const persona = this.store.persona()
    const profile = this.store.profile()
    return {
      name: persona.name,
      pronoun: persona.pronoun,
      tone: persona.tone,
      goal: profile.goal,
      level: profile.level,
      subjects: profile.subjects,
      weeklyMinutes: profile.weeklyMinutes,
    }
  }
}

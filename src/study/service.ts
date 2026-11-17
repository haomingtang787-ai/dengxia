import { createHash, randomUUID } from 'node:crypto'
import { AiClient, AiError, type AiUsage } from '../ai/client'
import { isUuid, nowIso } from '../domain/ids'
import { ArgumentError, isPlainObject } from '../domain/validation'
import type { ImageService } from '../images/service'
import type { SettingsStore } from '../providers/settings'
import { fail, ok, type Result } from '../shared/contract'
import type {
  StudyArtifact,
  StudyCheck,
  StudyCourse,
  StudyCourseSession,
  StudyCourseTree,
  StudyCourseTreeItem,
  StudyMessage,
  StudyMode,
  StudyQuizAnswer,
  StudyQuizQuestion,
  StudySessionDetail,
  StudySessionList,
  StudyProgress,
  StudySkill,
  StudySlideBrief,
  StudySlideCitation,
  StudySummary,
  StudyToolKind,
  StudyUnit,
  StudyUsage,
  StudyUsageAudit,
  StudyUsageKind,
} from '../shared/study'
import type { AppDatabase } from '../storage/database'
import { StudyStore, messageFromRow, type StudyArtifactRow, type StudyMessageRow, type StudySessionRow, type StudyUnitRow } from '../storage/studyStore'
import type { Habits } from '../teaching/habits'
import type { TeacherService } from '../teaching/teacherService'
import { DEFAULT_HABITS, sanitizeHabits } from '../teaching/habits'
import { DIRECT_PLAN_CHARS, MAX_MATERIAL_CHARS, digestMaterial, renderDigests } from './digest'
import { parseQuizGrade, parseStudyPlan, parseStudyQuiz, parseStudySummary, parseTeacherNote, parseTeachback } from './parse'
import {
  buildStudyChatPrompt,
  buildStudyPlanPrompt,
  buildStudyQuizGradePrompt,
  buildStudyQuizPrompt,
  buildStudySummaryPrompt,
  buildStudySummaryToolPrompt,
  buildStudyTeachbackPrompt,
  buildTeacherNotePrompt,
  mergeOpening,
} from './prompt'
import {
  citationsForUnits,
  isStudySkill,
  outlineStudyUnits,
  routeStudySkill,
  routeStudyToolIntent,
  searchQueryFrom,
  searchStudyUnits,
  studyMaterial,
  teachbackAnswerFrom,
} from './tools'
import { groundUnits } from './ground'

const MAX_MESSAGE_CHARS = 4_000
const MAX_ANSWER_CHARS = 2_000
const MAX_TOOL_ANSWER_CHARS = 1_200
const MAX_SEARCH_QUERY_CHARS = 80

export type StudyServiceOptions = {
  db: AppDatabase
  settings: SettingsStore
  images: Pick<ImageService, 'vision' | 'ocr' | 'visionEmbedded'>
  habits: () => Habits
  /** 0.7.0 起课程会带着老师的人格、学生档案和相关记忆；未注入时保持旧行为。 */
  teacher?: TeacherService
  fetchImpl?: typeof fetch
  budget?: import('../ai/budget').BudgetService
  onProgress?: (progress: StudyProgress) => void
}

type Material = {
  text: string
  chars: number
  warnings: string[]
  truncated: boolean
}

type PageRow = {
  id: string
  ordinal: number
  source_kind: string
  source_number: number | null
}

type BlockRow = {
  id: string
  page_id: string | null
  ordinal: number
  kind: string
  text: string
  locator_json: string
}

type ReadingRow = {
  page_id: string
  kind: 'ocr' | 'vision'
  text: string
}

type CitationPage = {
  pageId: string
  pageNumber: number
  text: string
  blocks: Array<{ id: string; text: string; bbox: [number, number, number, number] | null }>
}

type UsageScope = { sessionId: string | null; documentVersionId: string | null }

export class StudyService {
  private readonly store: StudyStore

  constructor(private readonly options: StudyServiceOptions) {
    this.store = new StudyStore(options.db)
  }

  list(): Result<StudySessionList> {
    const requestId = randomUUID()
    try {
      return ok(requestId, { items: this.store.listSessions() })
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  courses(): Result<StudyCourseTree> {
    const requestId = randomUUID()
    try {
      return ok(requestId, this.courseTree())
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  createCourse(body: unknown): Result<StudyCourseTree> {
    const requestId = randomUUID()
    try {
      const name = this.courseName(body)
      if (this.store.findCourseByName(name)) throw new ArgumentError('已经有同名课程。')
      const at = nowIso()
      this.store.createCourse({
        courseId: randomUUID(),
        name,
        sortOrder: this.nextCourseSortOrder(),
        createdAt: at,
        updatedAt: at,
      })
      return ok(requestId, this.courseTree())
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  renameCourse(body: unknown): Result<StudyCourseTree> {
    const requestId = randomUUID()
    try {
      const courseId = this.courseId(body)
      const course = this.store.findCourse(courseId)
      if (!course) throw new ArgumentError('找不到这门课程。')
      const name = this.courseName(body)
      const sameName = this.store.findCourseByName(name)
      if (sameName && sameName.courseId !== courseId) throw new ArgumentError('已经有同名课程。')
      this.store.renameCourse(courseId, name, nowIso())
      return ok(requestId, this.courseTree())
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  deleteCourse(body: unknown): Result<StudyCourseTree> {
    const requestId = randomUUID()
    try {
      const courseId = this.courseId(body)
      if (!this.store.findCourse(courseId)) throw new ArgumentError('找不到这门课程。')
      this.store.deleteCourse(courseId)
      return ok(requestId, this.courseTree())
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  reorderCourses(body: unknown): Result<StudyCourseTree> {
    const requestId = randomUUID()
    try {
      if (!isPlainObject(body) || !Array.isArray(body.ids)) throw new ArgumentError('请求格式不正确。')
      const ids = body.ids.map((id) => typeof id === 'string' ? id.trim() : '')
      if (ids.length === 0 || ids.length > 200 || ids.some((id) => !isUuid(id))) {
        throw new ArgumentError('课程排序列表不完整。')
      }
      const known = new Set(this.store.listCourseRows().map((course) => course.courseId))
      if (ids.some((id) => !known.has(id))) throw new ArgumentError('排序里有不存在的课程。')
      this.store.reorderCourses(ids, nowIso())
      return ok(requestId, this.courseTree())
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  get(body: unknown): Result<StudySessionDetail> {
    const requestId = randomUUID()
    try {
      const sessionId = this.sessionId(body)
      return ok(requestId, this.detail(sessionId))
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  async create(body: unknown): Promise<Result<StudySessionDetail>> {
    const requestId = randomUUID()
    try {
      const input = this.createBody(body)
      const existing = this.store.findByRequest(input.requestId)
      if (existing) return ok(requestId, this.detail(existing.id))
      this.config()
      // 先把 sessionId 定下来，读图/分段理解/拆课的用量直接挂到这门课，避免并发开课互相认领。
      const sessionId = randomUUID()
      const usageScope: UsageScope = { sessionId, documentVersionId: input.documentVersionId }
      const meta = this.documentMeta(input.documentVersionId)
      const material = await this.collectMaterial(input.documentVersionId)
      const habits = this.options.habits() ?? DEFAULT_HABITS
      const client = this.client(usageScope)
      const warnings = [...material.warnings]
      // 长课件不再截断成前 20 万字：先按页分段逐段读懂，再拿结构化理解去拆课。
      let digests = ''
      let chunkCount = 1
      if (material.text.length > DIRECT_PLAN_CHARS) {
        const materialSha = createHash('sha256').update(material.text).digest('hex')
        const cached = this.store.findMaterialDigest(input.documentVersionId, materialSha)
        if (cached) {
          digests = cached.rendered_text
          chunkCount = cached.chunk_count
          warnings.push(
            `已复用上一次对这份课件的逐段理解结果（${chunkCount} 段），这次开课只花拆课的 token。`,
          )
          this.progress({ phase: 'reading', done: chunkCount, total: chunkCount })
        } else {
          this.progress({ phase: 'reading', done: 0, total: 0 })
          const outcome = await digestMaterial(client, material.text, {
            onProgress: (done, total) => this.progress({ phase: 'reading', done, total }),
          })
          digests = renderDigests(outcome.digests)
          chunkCount = outcome.digests.length
          warnings.push(
            `这份材料约 ${material.text.length} 字，已按页分成 ${chunkCount} 段逐段读懂，再据此拆课；课程覆盖全部段落。`,
          )
          warnings.push(...outcome.warnings)
          // 材料没变时这份理解结果直接复用，重开课、换习惯再开一门都不用重新扣读材料的钱。
          this.store.saveMaterialDigest({
            document_version_id: input.documentVersionId,
            material_sha: materialSha,
            chunk_count: chunkCount,
            rendered_text: digests,
            digests_json: JSON.stringify(outcome.digests),
            warnings_json: JSON.stringify(outcome.warnings),
            created_at: nowIso(),
          })
        }
      }
      const planInput = {
        title: input.title || meta.displayName,
        subject: input.subject || '',
        material: digests ? '' : material.text,
        habits,
        teacher: this.options.teacher?.context(input.subject || ''),
        truncated: material.truncated,
        digests: digests || undefined,
        chunkCount,
      }
      const prompt = buildStudyPlanPrompt(planInput)
      this.progress({ phase: 'planning', done: 0, total: 0 })
      // 24 讲 × 8 段的讲稿 JSON 换算成 token 轻松超过 8000；上限太小会被截断成非法 JSON。
      const raw = await client.complete(prompt.system, prompt.user, 24_000, 'disabled', 'plan')
      let plan
      try {
        plan = parseStudyPlan(raw, {
          title: input.title || meta.displayName,
          subject: input.subject || '',
        })
      } catch (error) {
        if (!(error instanceof ArgumentError)) throw error
        const repair = buildStudyPlanPrompt({ ...planInput, repairNote: error.message })
        const repaired = await client.complete(repair.system, repair.user, 24_000, 'disabled', 'plan-repair')
        plan = parseStudyPlan(repaired, {
          title: input.title || meta.displayName,
          subject: input.subject || '',
        })
      }
      const timestamp = nowIso()
      const grounded = groundUnits(plan.units.map((unit, index) => ({
        id: randomUUID(),
        ordinal: index,
        title: unit.title,
        source: unit.source,
        minutes: unit.minutes,
        keyPoints: unit.keyPoints,
        segments: unit.segments,
      })), material.text)
      const units: StudyUnit[] = grounded.units
      if (grounded.ungrounded > 0) {
        warnings.push(`有 ${grounded.ungrounded} 处讲稿引用的「原文」没能在课件里逐字找到，已保留讲解，但那一句是模型转述，请对照原件。`)
      }
      const opening = mergeOpening(plan.opening, units)
      const courseId = this.resolveCourse(input.courseId, plan.subject)
      const session: StudySessionRow = {
        id: sessionId,
        request_id: input.requestId,
        document_version_id: input.documentVersionId,
        course_id: courseId,
        title: plan.title,
        subject: plan.subject,
        source_name: meta.displayName,
        overview: plan.overview,
        outline_json: JSON.stringify(units.map((unit) => unit.title)),
        habits_json: JSON.stringify(habits),
        warnings_json: JSON.stringify(warnings),
        truncated: material.truncated ? 1 : 0,
        material_chars: material.chars,
        material_chunks: chunkCount,
        status: 'ready',
        summary_json: '',
        teacher_snapshot_json: this.options.teacher ? JSON.stringify(this.options.teacher.snapshot()) : '',
        created_at: timestamp,
        updated_at: timestamp,
      }
      this.store.createBundle({
        session,
        units: units.map((unit) => ({
          id: unit.id,
          session_id: sessionId,
          ordinal: unit.ordinal,
          title: unit.title,
          source: unit.source,
          minutes: unit.minutes,
          key_points_json: JSON.stringify(unit.keyPoints),
          segments_json: JSON.stringify(unit.segments),
        })),
        message: {
          id: randomUUID(),
          session_id: sessionId,
          role: 'assistant',
          unit_ordinal: null,
          content: opening,
          citations_json: '[]',
          created_at: timestamp,
        },
      })
      // 读图等开课前发生的、没有 session 的用量归到这门课；本次拆课用量已经直接带了 sessionId。
      this.store.claimUsage(sessionId, input.documentVersionId)
      return ok(requestId, this.detail(sessionId))
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  async send(body: unknown): Promise<Result<StudySessionDetail>> {
    const requestId = randomUUID()
    try {
      const input = this.sendBody(body)
      const session = this.requireSession(input.sessionId)
      if (session.status === 'finished') throw new ArgumentError('这门课已经生成过学习总结，可以新开一门课继续。')
      this.config()
      const habits = this.readHabits(session)
      const units = this.units(session.id)
      const unit = input.unitOrdinal == null
        ? units[0] ?? null
        : units.find((item) => item.ordinal === input.unitOrdinal) ?? null
      const pages = this.citationPages(session.document_version_id)
      // 说「找原文 / 总结这一讲 / 考考我」时先执行一次性工具，不再让模型陪聊一遍。
      const intent = routeStudyToolIntent(input.content)
      if (intent) {
        const toolResult = await this.tool({
          sessionId: session.id,
          tool: intent,
          unitOrdinal: intent === 'search' ? null : unit?.ordinal ?? null,
          query: intent === 'search' ? searchQueryFrom(input.content) : '',
          answer: intent === 'teachback' ? teachbackAnswerFrom(input.content) : '',
        })
        if (!toolResult.ok) return toolResult
        const artifact = toolResult.data.artifacts.find((item) => item.kind === intent)
        const timestamp = nowIso()
        const reply = this.toolChatReply(intent, artifact, unit)
        const citations = unit ? this.citationsForUnit(unit, pages) : []
        this.options.db.transaction(() => {
          this.store.appendMessage({
            id: randomUUID(),
            session_id: session.id,
            role: 'user',
            unit_ordinal: unit?.ordinal ?? input.unitOrdinal ?? null,
            content: input.content,
            citations_json: '[]',
            created_at: timestamp,
          })
          this.store.appendMessage({
            id: randomUUID(),
            session_id: session.id,
            role: 'assistant',
            unit_ordinal: unit?.ordinal ?? input.unitOrdinal ?? null,
            content: reply,
            citations_json: JSON.stringify(citations),
            created_at: timestamp,
          })
        })
        return ok(requestId, this.detail(session.id))
      }
      const messages = this.messages(session.id)
      const prompt = buildStudyChatPrompt({
        overview: session.overview,
        outline: this.outline(session),
        units,
        unit,
        messages,
        question: input.content,
        habits,
        teacher: this.options.teacher?.context(session.subject, unit?.title ?? ''),
        skill: routeStudySkill(input.content, input.skill),
        mode: input.mode,
        slide: unit ? this.slideBriefForUnit(unit, pages) : undefined,
      })
      const answer = (await this.client({
        sessionId: session.id,
        documentVersionId: session.document_version_id,
      }).complete(prompt.system, prompt.user, 3000, 'disabled', 'chat')).trim()
      if (!answer) throw new AiError('AI_FAILED', '模型没有返回讲解。')
      const timestamp = nowIso()
      const citations = unit ? this.citationsForAnswer(unit, answer, pages) : []
      const userMessage: StudyMessageRow = {
        id: randomUUID(),
        session_id: session.id,
        role: 'user',
        unit_ordinal: unit?.ordinal ?? input.unitOrdinal ?? null,
        content: input.content,
        citations_json: '[]',
        created_at: timestamp,
      }
      const assistantMessage: StudyMessageRow = {
        id: randomUUID(),
        session_id: session.id,
        role: 'assistant',
        unit_ordinal: unit?.ordinal ?? input.unitOrdinal ?? null,
        content: answer,
        citations_json: JSON.stringify(citations),
        created_at: timestamp,
      }
      this.options.db.transaction(() => {
        this.store.appendMessage(userMessage)
        this.store.appendMessage(assistantMessage)
      })
      return ok(requestId, this.detail(session.id))
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  async tool(body: unknown): Promise<Result<StudySessionDetail>> {
    const requestId = randomUUID()
    try {
      const input = this.toolBody(body)
      const session = this.requireSession(input.sessionId)
      const units = this.units(session.id)
      const unit = input.unitOrdinal == null ? null : units.find((item) => item.ordinal === input.unitOrdinal) ?? null
      if (input.unitOrdinal != null && !unit) throw new ArgumentError('找不到这一讲。')
      const scope = input.unitOrdinal == null ? 'course' : `unit:${input.unitOrdinal}`
      const stamp = nowIso()

      if (input.tool === 'search') {
        const matches = searchStudyUnits(units, input.query)
        this.saveToolArtifact(session.id, 'search', 'course', `查找：${input.query}`, {
          query: input.query,
          matches,
          message: matches.length
            ? `找到 ${matches.length} 处原文，引用都来自这门课。`
            : '没找到相关原文。换个关键词，或先确认这份材料里有没有讲过。',
        }, stamp)
        return ok(requestId, this.detail(session.id))
      }

      if (input.tool === 'outline') {
        const items = outlineStudyUnits(units, input.unitOrdinal)
        if (items.length === 0) throw new ArgumentError('这门课还没有小讲，暂时列不出大纲。')
        this.saveToolArtifact(
          session.id,
          'outline',
          scope,
          unit ? `复习大纲 · ${unit.title}` : '整门课复习大纲',
          { items },
          stamp,
        )
        return ok(requestId, this.detail(session.id))
      }

      this.config()
      const client = this.client({ sessionId: session.id, documentVersionId: session.document_version_id })
      const habits = this.readHabits(session)

      if (input.tool === 'summary') {
        const material = studyMaterial(units, input.unitOrdinal)
        const prompt = buildStudySummaryToolPrompt({ title: session.title, material, unit, habits })
        const text = (await client.complete(prompt.system, prompt.user, 2200, 'disabled', 'tool-summary')).trim()
        if (!text) throw new AiError('AI_FAILED', '模型没有返回总结。')
        this.saveToolArtifact(session.id, 'summary', scope, unit ? `总结 · ${unit.title}` : '整门课总结', {
          text,
          citations: citationsForUnits(units, input.unitOrdinal),
        }, stamp)
        return ok(requestId, this.detail(session.id))
      }

      if (input.tool === 'quiz') {
        const material = studyMaterial(units, input.unitOrdinal)
        const prompt = buildStudyQuizPrompt({ title: session.title, material, unit, habits })
        const raw = await client.complete(prompt.system, prompt.user, 2200, 'disabled', 'tool-quiz')
        const parsed = parseStudyQuiz(raw)
        const questions: StudyQuizQuestion[] = parsed.questions.map((question) => ({
          id: randomUUID(),
          prompt: question.prompt,
          hint: question.hint,
          source: question.source,
        }))
        this.saveToolArtifact(session.id, 'quiz', scope, unit ? `题测 · ${unit.title}` : '整门课题测', {
          questions,
          graded: false,
        }, stamp)
        return ok(requestId, this.detail(session.id))
      }

      if (input.tool === 'quiz-grade') {
        const existing = this.store.findArtifact(session.id, 'quiz', scope)
        if (!existing) throw new ArgumentError('先让老师出题，再提交答案。')
        const quizBody = parseArtifactBody(existing.body_json)
        const questions = Array.isArray(quizBody.questions) ? quizBody.questions as StudyQuizQuestion[] : []
        if (questions.length === 0) throw new ArgumentError('这份题测没有题目，请重新出题。')
        if (input.answers.length !== questions.length) throw new ArgumentError('还有题没答，答完再判。')
        for (const answer of input.answers) {
          if (!questions.some((question) => question.id === answer.questionId)) {
            throw new ArgumentError('提交的题目不属于这次题测。')
          }
        }
        const material = studyMaterial(units, input.unitOrdinal)
        const prompt = buildStudyQuizGradePrompt({
          title: session.title,
          material,
          unit,
          questions: questions.map((question) => ({ id: question.id, prompt: question.prompt, source: question.source })),
          answers: input.answers,
        })
        const raw = await client.complete(prompt.system, prompt.user, 1800, 'disabled', 'tool-quiz-grade')
        const grade = parseQuizGrade(raw)
        this.saveToolArtifact(session.id, 'quiz', scope, existing.title, {
          ...quizBody,
          questions,
          answers: input.answers,
          graded: true,
          feedback: grade.feedback,
          gaps: grade.gaps,
        }, stamp)
        return ok(requestId, this.detail(session.id))
      }

      if (input.tool === 'teachback') {
        const material = studyMaterial(units, input.unitOrdinal)
        const prompt = buildStudyTeachbackPrompt({ title: session.title, material, unit, answer: input.answer })
        const raw = await client.complete(prompt.system, prompt.user, 1800, 'disabled', 'tool-teachback')
        const feedback = parseTeachback(raw)
        this.saveToolArtifact(
          session.id,
          'teachback',
          scope,
          unit ? `复述 · ${unit.title}` : '整门课复述',
          { answer: input.answer, feedback: feedback.feedback, covered: feedback.covered, gaps: feedback.gaps },
          stamp,
        )
        return ok(requestId, this.detail(session.id))
      }

      throw new ArgumentError('这个老师工具还不支持。')
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  async finish(body: unknown): Promise<Result<StudySessionDetail>> {
    const requestId = randomUUID()
    try {
      const sessionId = this.sessionId(body)
      const session = this.requireSession(sessionId)
      const existing = this.summary(session)
      if (existing) return ok(requestId, this.detail(sessionId))
      this.config()
      const units = this.units(sessionId)
      const messages = this.messages(sessionId)
      const checks = this.checks(sessionId)
      const prompt = buildStudySummaryPrompt({
        title: session.title,
        overview: session.overview,
        units,
        messages,
        checks,
      })
      const client = this.client({ sessionId: session.id, documentVersionId: session.document_version_id })
      const raw = await client.complete(prompt.system, prompt.user, 3000, 'disabled', 'summary')
      const summary = parseStudySummary(raw)
      this.store.saveSummary(sessionId, summary, nowIso())
      // 手记是老师下一次课的记忆，不是学习总结的替代品：失败只记日志，不能把总结退回去。
      if (this.options.teacher) {
        try {
          const notePrompt = buildTeacherNotePrompt({
            teacherName: this.options.teacher.snapshot().name,
            title: session.title,
            overview: session.overview,
            units,
            messages,
            checks,
          })
          const noteRaw = await client.complete(notePrompt.system, notePrompt.user, 2_000, 'disabled', 'teacher-note')
          const note = parseTeacherNote(noteRaw)
          this.options.teacher.saveNote(sessionId, note)
          // 手记里的观察先落成“待确认记忆”；失败只警告，不能把手记或总结退回去。
          try {
            this.options.teacher.saveObservations(sessionId, session.document_version_id, note.memories)
          } catch (error) {
            console.warn('[teacher-memory]', error)
          }
        } catch (error) {
          console.warn('[teacher-note]', error)
        }
      }
      return ok(requestId, this.detail(sessionId))
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  /**
   * 学生回答「停一下」的问题。这一步不调模型、不判对错，只把真实作答留作证据；
   * 掌握程度由最后的总结基于这些作答来判断，避免凭感觉写「已掌握」。
   */
  check(body: unknown): Result<StudySessionDetail> {
    const requestId = randomUUID()
    try {
      const input = this.checkBody(body)
      const session = this.requireSession(input.sessionId)
      const unit = this.units(session.id).find((item) => item.ordinal === input.unitOrdinal)
      if (!unit) throw new ArgumentError('找不到这一讲，可能已经被删除。')
      const segment = unit.segments[input.segmentIndex]
      if (!segment) throw new ArgumentError('找不到这一句对应的讲解。')
      if (!segment.check) throw new ArgumentError('这一句没有「停一下」的问题，不用作答。')
      this.store.upsertCheck({
        id: randomUUID(),
        session_id: session.id,
        unit_ordinal: unit.ordinal,
        segment_index: input.segmentIndex,
        question: segment.check,
        answer: input.answer,
        created_at: nowIso(),
      })
      return ok(requestId, this.detail(session.id))
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  /** 清除这门课的对话记录（保留课程、总结、作答）。 */
  clearChat(body: unknown): Result<StudySessionDetail> {
    const requestId = randomUUID()
    try {
      const sessionId = this.sessionId(body)
      const session = this.requireSession(sessionId)
      this.store.clearMessages(session.id, nowIso())
      return ok(requestId, this.detail(session.id))
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  /** 清除学习总结，回到「未生成」状态。 */
  clearSummary(body: unknown): Result<StudySessionDetail> {
    const requestId = randomUUID()
    try {
      const sessionId = this.sessionId(body)
      const session = this.requireSession(sessionId)
      this.store.clearSummary(session.id, nowIso())
      return ok(requestId, this.detail(session.id))
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  /** 删除整份课件会话。 */
  deleteSession(body: unknown): Result<StudySessionList> {
    const requestId = randomUUID()
    try {
      const sessionId = this.sessionId(body)
      const session = this.requireSession(sessionId)
      this.store.deleteSession(session.id)
      return ok(requestId, { items: this.store.listSessions() })
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  private async collectMaterial(versionId: string): Promise<Material> {
    const pages = this.options.db.all<PageRow>(
      'SELECT id, ordinal, source_kind, source_number FROM pages WHERE document_version_id = ? ORDER BY ordinal ASC',
      versionId,
    )
    const blocks = this.options.db.all<BlockRow>(
      `SELECT id, page_id, ordinal, kind, text, locator_json FROM blocks
       WHERE document_version_id = ?
       ORDER BY ordinal ASC`,
      versionId,
    )
    const readings = this.options.db.all<ReadingRow>(
      'SELECT page_id, kind, text FROM image_readings WHERE document_version_id = ?',
      versionId,
    )
    const blockReadings = new Map<string, string>()
    const readingRows = this.options.db.all<{ block_id: string; kind: string; text: string }>(
      'SELECT block_id, kind, text FROM block_readings WHERE document_version_id = ?',
      versionId,
    )
    for (const row of readingRows) {
      if (row.kind === 'vision') blockReadings.set(row.block_id, row.text.trim())
    }
    const warnings: string[] = []
    // 块级读图：一张图只调用一次模型，结果按块缓存；失败只记警告，不阻断整门课。
    const readEmbedded = async (block: BlockRow): Promise<string> => {
      const cached = blockReadings.get(block.id)
      if (cached !== undefined) return cached
      const result = await this.options.images.visionEmbedded({ blockId: block.id })
      if (result.ok) {
        const text = result.data.reading.text.trim()
        blockReadings.set(block.id, text)
        return text
      }
      warnings.push(`有一张内嵌图片没能读懂：${result.error.message}`)
      return ''
    }

    const byPage = new Map<string, BlockRow[]>()
    const visualPages = new Set<string>()
    for (const block of blocks) {
      if (!block.page_id) continue
      if (block.kind === 'image_region') visualPages.add(block.page_id)
      const current = byPage.get(block.page_id) ?? []
      current.push(block)
      byPage.set(block.page_id, current)
    }
    const readingByPage = new Map<string, { vision: string; ocr: string }>()
    for (const reading of readings) {
      const current = readingByPage.get(reading.page_id) ?? { vision: '', ocr: '' }
      current[reading.kind] = reading.text.trim()
      readingByPage.set(reading.page_id, current)
    }

    const parts: string[] = []
    const pendingVision = new Set(
      pages
        .filter((page) => (page.source_kind === 'image' || visualPages.has(page.id)) && !readingByPage.get(page.id)?.vision)
        .map((page) => page.id),
    )
    const visionTotal = pendingVision.size
    let visionDone = 0
    if (visionTotal > 0) this.progress({ phase: 'vision', done: 0, total: visionTotal })
    const pageResults = await mapLimit(pages, 4, async (page) => {
      const label = `【第 ${page.ordinal + 1} 页${page.source_kind === 'slide' ? ' / 幻灯片' : ''}】`
      const pageBlocks = byPage.get(page.id) ?? []
      const pageWarnings: string[] = []
      const pieces: string[] = []
      let embeddedCovered = false
      for (const block of pageBlocks) {
        if (block.kind === 'image_region' && artifactIdFrom(block.locator_json)) {
          embeddedCovered = true
          const text = await readEmbedded(block)
          if (text) pieces.push(`本页图片/图表：\n${text}`)
          continue
        }
        const text = block.text.trim()
        if (text) pieces.push(text)
      }
      const visual = (page.source_kind === 'image' || visualPages.has(page.id)) && !embeddedCovered
      if (visual) {
        let reading = readingByPage.get(page.id)
        if (!reading?.vision) {
          const result = await this.options.images.vision({ documentVersionId: versionId, pageId: page.id })
          if (result.ok) {
            reading = { ...(reading ?? { vision: '', ocr: '' }), vision: result.data.reading.text.trim() }
          } else if (!reading?.ocr) {
            const ocr = await this.options.images.ocr({ documentVersionId: versionId, pageId: page.id })
            if (ocr.ok) {
              reading = { ...(reading ?? { vision: '', ocr: '' }), ocr: ocr.data.reading.text.trim() }
            } else {
              pageWarnings.push(`第 ${page.ordinal + 1} 页有图片，但读图没有成功：${result.error.message}`)
            }
          }
        }
        const visualText = reading?.vision || reading?.ocr || ''
        if (visualText) pieces.push(visualText)
      }
      if (pendingVision.delete(page.id)) {
        visionDone += 1
        this.progress({ phase: 'vision', done: visionDone, total: visionTotal })
      }
      const merged = pieces.join('\n').trim()
      if (merged) return { text: `${label}\n${merged}`, warnings: pageWarnings }
      pageWarnings.push(`第 ${page.ordinal + 1} 页没有可用的内容。`)
      return { text: '', warnings: pageWarnings }
    })
    for (const result of pageResults) {
      if (result.text) parts.push(result.text)
      warnings.push(...result.warnings)
    }

    const slideGroups = new Map<number, string[]>()
    const loose: string[] = []
    const embeddedTexts: string[] = []
    for (const block of blocks) {
      if (block.page_id) continue
      if (block.kind === 'image_region' && artifactIdFrom(block.locator_json)) {
        const text = await readEmbedded(block)
        if (text) embeddedTexts.push(text)
        continue
      }
      const text = block.text.trim()
      if (!text) continue
      const slide = slideNumberFromLocator(block.locator_json)
      if (slide === null) {
        loose.push(text)
        continue
      }
      const current = slideGroups.get(slide) ?? []
      current.push(text)
      slideGroups.set(slide, current)
    }
    for (const [slide, values] of [...slideGroups.entries()].sort((a, b) => a[0] - b[0])) {
      parts.push(`【第 ${slide} 页 / 幻灯片】\n${values.join('\n')}`)
    }
    if (loose.length > 0) parts.push(`【整份文稿的连续正文】\n${loose.join('\n')}`)
    if (embeddedTexts.length > 0) {
      parts.push(
        `【整份文稿的内嵌图片与图表】\n${embeddedTexts.map((text, index) => `${index + 1}. ${text}`).join('\n')}`,
      )
    }
    if (parts.length === 0) throw new ArgumentError('这份文稿还没有可读内容，先在「文稿」里等解析完成。')

    const full = parts.join('\n\n')
    const truncated = full.length > MAX_MATERIAL_CHARS
    return {
      text: truncated ? full.slice(0, MAX_MATERIAL_CHARS) : full,
      chars: full.length,
      warnings,
      truncated,
    }
  }

  private courseTree(): StudyCourseTree {
    const courses = this.store.listCourseRows()
    const sessions = this.store.listSessions()
    const items: StudyCourseTreeItem[] = courses.map((course) => {
      const sessionItems: StudyCourseSession[] = sessions
        .filter((session) => session.courseId === course.courseId)
        .map((session) => ({
          ...session,
          units: this.store.listUnits(session.sessionId).map((unit) => ({
            id: unit.id,
            ordinal: Number(unit.ordinal),
            title: unit.title,
            minutes: Number(unit.minutes),
          })),
        }))
      return { ...course, sessions: sessionItems }
    })
    return { items }
  }

  private nextCourseSortOrder(): number {
    const rows = this.store.listCourseRows()
    return rows.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1
  }

  private resolveCourse(courseId: string | null, subject: string): string {
    if (courseId) {
      const existing = this.store.findCourse(courseId)
      if (!existing) throw new ArgumentError('找不到这门课程。')
      return existing.courseId
    }
    const name = subject.trim() || '未分类'
    const existing = this.store.findCourseByName(name)
    if (existing) return existing.courseId
    const at = nowIso()
    const course: StudyCourse = {
      courseId: randomUUID(),
      name,
      sortOrder: this.nextCourseSortOrder(),
      createdAt: at,
      updatedAt: at,
    }
    this.store.createCourse(course)
    return course.courseId
  }

  private citationPages(versionId: string): CitationPage[] {
    const pages = this.options.db.all<{ id: string; ordinal: number }>(
      'SELECT id, ordinal FROM pages WHERE document_version_id = ? ORDER BY ordinal ASC',
      versionId,
    )
    const blocks = this.options.db.all<{
      id: string
      page_id: string
      text: string
      locator_json: string
    }>(
      `SELECT id, page_id, text, locator_json FROM blocks
       WHERE document_version_id = ? AND page_id IS NOT NULL
       ORDER BY page_id ASC, ordinal ASC`,
      versionId,
    )
    const byPage = new Map<string, CitationPage>()
    for (const page of pages) {
      byPage.set(page.id, {
        pageId: page.id,
        pageNumber: Number(page.ordinal) + 1,
        text: '',
        blocks: [],
      })
    }
    for (const block of blocks) {
      const page = byPage.get(block.page_id)
      if (!page) continue
      page.text += `${block.text}\n`
      page.blocks.push({
        id: block.id,
        text: block.text,
        bbox: parseBbox(block.locator_json),
      })
    }
    return [...byPage.values()].filter((page) => page.text.trim().length > 0)
  }

  private pagesForUnit(unit: StudyUnit, pages: CitationPage[]): CitationPage[] {
    const found = new Set<number>()
    const quotes = [unit.source, ...unit.segments.map((segment) => segment.source)]
    for (const quote of quotes) {
      const range = pageRange(quote)
      if (range) {
        for (let page = range[0]; page <= range[1]; page += 1) found.add(page)
      }
      const normalized = normalizeText(quote)
      if (normalized.length < 6) continue
      const page = pages.find((item) => normalizeText(item.text).includes(normalized))
      if (page) found.add(page.pageNumber)
    }
    return pages.filter((page) => found.has(page.pageNumber)).slice(0, 4)
  }

  private slideBriefForUnit(unit: StudyUnit, pages: CitationPage[]): StudySlideBrief | undefined {
    const unitPages = this.pagesForUnit(unit, pages)
    if (unitPages.length === 0) return undefined
    return {
      pages: unitPages.map((page) => page.pageNumber),
      excerpts: unitPages.map((page) => ({
        page: page.pageNumber,
        text: page.text.trim().slice(0, 900),
      })),
    }
  }

  private citationsForUnit(unit: StudyUnit, pages: CitationPage[]): StudySlideCitation[] {
    return this.pagesForUnit(unit, pages)
      .slice(0, 3)
      .map((page) => this.citationOf(page, unit))
  }

  private citationsForAnswer(unit: StudyUnit, answer: string, pages: CitationPage[]): StudySlideCitation[] {
    const mentioned = pageMentions(answer)
    const explicit = pages.filter((page) => mentioned.includes(page.pageNumber))
    const candidates = explicit.length > 0 ? explicit : this.pagesForUnit(unit, pages)
    return candidates.slice(0, 3).map((page) => this.citationOf(page, unit))
  }

  private citationOf(page: CitationPage, unit: StudyUnit): StudySlideCitation {
    const quote = quoteForPage(page, unit)
    const block = page.blocks.find((item) => {
      const blockText = normalizeText(item.text)
      const quoteText = normalizeText(quote)
      return blockText.includes(quoteText) || quoteText.includes(blockText)
    })
    return {
      pageNumber: page.pageNumber,
      pageId: page.pageId,
      quote,
      blockId: block?.id ?? null,
      // 找不到逐字匹配就不画框：扫描件 OCR 文本会和原页对不上，宁可不标，也不把框放错位置。
      bbox: block?.bbox ?? null,
    }
  }

  private courseName(body: unknown): string {
    if (!isPlainObject(body)) throw new ArgumentError('请求格式不正确。')
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new ArgumentError('先给课程起一个名字。')
    if (name.length > 60) throw new ArgumentError('课程名最多 60 个字。')
    return name
  }

  private courseId(body: unknown): string {
    if (!isPlainObject(body)) throw new ArgumentError('请求格式不正确。')
    const courseId = typeof body.courseId === 'string' ? body.courseId.trim() : ''
    if (!isUuid(courseId)) throw new ArgumentError('courseId 不是有效的课程。')
    return courseId
  }

  private detail(sessionId: string): StudySessionDetail {
    const session = this.requireSession(sessionId)
    const units = this.units(sessionId)
    const messages = this.messages(sessionId)
    const summary = this.summary(session)
    return {
      sessionId: session.id,
      documentVersionId: session.document_version_id,
      courseId: session.course_id ?? null,
      title: session.title,
      subject: session.subject,
      sourceName: session.source_name,
      unitCount: units.length,
      messageCount: messages.length,
      status: session.status,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      overview: session.overview,
      outline: this.outline(session),
      units,
      messages,
      checks: this.checks(sessionId),
      warnings: parseStringList(session.warnings_json),
      truncated: Number(session.truncated) === 1,
      materialChars: Number(session.material_chars),
      materialChunks: Number(session.material_chunks ?? 1),
      habits: this.readHabits(session),
      summary,
      artifacts: this.store.listArtifacts(sessionId).map(artifactFromRow),
      teacherNote: this.options.teacher?.noteForSession(sessionId) ?? null,
      usage: this.usageOf(sessionId),
    }
  }

  /** 用量聚合容错：统计表不在或为空时显示 0，不影响看课。 */
  private usageOf(sessionId: string): StudyUsage {
    try {
      return this.store.usageOfSession(sessionId)
    } catch {
      return {
        calls: 0,
        promptTokens: 0,
        cachedTokens: 0,
        cacheMissTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        reportedCalls: 0,
        estimatedCalls: 0,
      }
    }
  }

  /**
   * 用量核对：本机按调用类型拆开的 token + DeepSeek 官方余额。
   * DeepSeek 没有逐请求 usage API，官方用量只能在开放平台「用量信息」页导出 CSV 对账；
   * 余额能查就直接查，查不到只回错误文案，不影响本机统计。
   */
  async usageAudit(body: unknown): Promise<Result<StudyUsageAudit>> {
    const requestId = randomUUID()
    try {
      const sessionId = this.sessionId(body)
      const session = this.requireSession(sessionId)
      let kinds: StudyUsageKind[] = []
      try {
        kinds = this.store.usageKinds(sessionId)
      } catch {
        kinds = []
      }
      let balance: StudyUsageAudit['balance'] = null
      let balanceError: string | null = null
      try {
        balance = await this.client({
          sessionId: session.id,
          documentVersionId: session.document_version_id,
        }).balance()
      } catch (error) {
        balanceError = error instanceof Error ? error.message : '余额读取失败。'
      }
      return ok(requestId, {
        usage: this.usageOf(sessionId),
        kinds,
        balance,
        balanceError,
        officialNote:
          'DeepSeek 官方没有逐请求用量查询接口；按 Key 的用量请登录开放平台「用量信息」页，选择月份后点「导出」，解压后看 amount CSV。这里显示的是本机每次调用真实回传的 usage。',
      })
    } catch (error) {
      return this.failure(requestId, error)
    }
  }

  private checks(sessionId: string): StudyCheck[] {
    return this.store.listChecks(sessionId).map((row) => ({
      unitOrdinal: Number(row.unit_ordinal),
      segmentIndex: Number(row.segment_index),
      question: row.question,
      answer: row.answer,
      createdAt: row.created_at,
    }))
  }

  private units(sessionId: string): StudyUnit[] {
    return this.store.listUnits(sessionId).map((row) => unitFromRow(row))
  }

  private messages(sessionId: string): StudyMessage[] {
    return this.store.listMessages(sessionId).map(messageFromRow)
  }

  private outline(session: StudySessionRow): string[] {
    return parseStringList(session.outline_json)
  }

  private readHabits(session: StudySessionRow): Habits {
    try {
      const parsed = JSON.parse(session.habits_json) as unknown
      return sanitizeHabits(parsed)
    } catch {
      return DEFAULT_HABITS
    }
  }

  private summary(session: StudySessionRow): StudySummary | null {
    if (!session.summary_json) return null
    try {
      const parsed = JSON.parse(session.summary_json) as StudySummary
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.mastered)) return null
      return parsed
    } catch {
      return null
    }
  }

  private requireSession(sessionId: string): StudySessionRow {
    const session = this.store.getSession(sessionId)
    if (!session) throw new ArgumentError('找不到这门课，可能已经被删除。')
    return session
  }

  private config() {
    const ai = this.options.settings.load().ai
    if (!ai || !ai.apiKey.trim()) throw new AiError('AI_NOT_CONFIGURED', '先在「模型」里填好 API 地址、模型和密钥。')
    if (!ai.baseUrl.trim() || !ai.model.trim()) throw new AiError('AI_NOT_CONFIGURED', '模型地址和模型名不能为空。')
    return ai
  }

  private client(scope: UsageScope): AiClient {
    const ai = this.config()
    // 82 页课件的拆课 JSON 可能要两三分钟才能吐完，120 秒会把长课件拦腰打断。
    return new AiClient(ai, this.options.fetchImpl ?? globalThis.fetch, 300_000, (kind, usage) => {
      this.recordUsage(scope, kind, usage)
    }, () => this.options.budget?.beforeCall())
  }

  /** token 用量落库：归属由调用点显式传入，避免并发开课/发消息时串到别的课程名下。 */
  private recordUsage(scope: UsageScope, kind: string, usage: AiUsage): void {
    try {
      this.store.insertUsage({
        sessionId: scope.sessionId,
        documentVersionId: scope.documentVersionId,
        kind,
        promptTokens: usage.promptTokens,
        cachedTokens: usage.cachedTokens,
        cacheMissTokens: usage.cacheMissTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        providerReported: usage.providerReported,
        model: usage.model,
        createdAt: nowIso(),
      })
    } catch {
      // 用量统计不许影响课程生成。
    }
  }

  private progress(progress: StudyProgress): void {
    try {
      this.options.onProgress?.(progress)
    } catch {
      // 进度只是界面提示，送不出去不能拖垮建课。
    }
  }

  private documentMeta(versionId: string): { displayName: string; title: string } {
    const row = this.options.db.get<{ display_name: string }>(
      `SELECT d.display_name FROM document_versions v
       JOIN documents d ON d.id = v.document_id
       WHERE v.id = ?`,
      versionId,
    )
    if (!row) throw new ArgumentError('找不到这份文稿。')
    return { displayName: row.display_name, title: row.display_name }
  }

  private createBody(body: unknown): {
    requestId: string
    documentVersionId: string
    title: string
    subject: string
    courseId: string | null
  } {
    if (!isPlainObject(body)) throw new ArgumentError('请求格式不正确。')
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
    if (!requestId || requestId.length > 80) throw new ArgumentError('请求缺少有效的 requestId。')
    const documentVersionId = typeof body.documentVersionId === 'string' ? body.documentVersionId.trim() : ''
    if (!isUuid(documentVersionId)) throw new ArgumentError('documentVersionId 不是有效的文稿版本。')
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : ''
    const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 60) : ''
    const rawCourseId = typeof body.courseId === 'string' ? body.courseId.trim() : ''
    if (rawCourseId && !isUuid(rawCourseId)) throw new ArgumentError('courseId 不是有效的课程。')
    return { requestId, documentVersionId, title, subject, courseId: rawCourseId || null }
  }

  private sendBody(body: unknown): { sessionId: string; content: string; unitOrdinal: number | null; mode: StudyMode; skill: StudySkill } {
    if (!isPlainObject(body)) throw new ArgumentError('请求格式不正确。')
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!isUuid(sessionId)) throw new ArgumentError('sessionId 不是有效的课堂。')
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (!content) throw new ArgumentError('先写一句想问老师的话。')
    if (content.length > MAX_MESSAGE_CHARS) throw new ArgumentError(`一次最多问 ${MAX_MESSAGE_CHARS} 个字。`)
    const ordinal = body.unitOrdinal
    if (ordinal != null && (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0)) {
      throw new ArgumentError('unitOrdinal 不是有效的小讲序号。')
    }
    const rawMode = body.mode
    if (rawMode != null && rawMode !== 'direct' && rawMode !== 'guided') {
      throw new ArgumentError('mode 只能是 direct 或 guided。')
    }
    const rawSkill = body.skill
    if (rawSkill != null && !isStudySkill(rawSkill)) throw new ArgumentError('skill 不是有效的教学技能。')
    return {
      sessionId,
      content,
      unitOrdinal: typeof ordinal === 'number' ? ordinal : null,
      mode: rawMode === 'guided' ? 'guided' : 'direct',
      skill: typeof rawSkill === 'string' ? rawSkill : 'auto',
    }
  }

  private toolBody(body: unknown): {
    sessionId: string
    tool: StudyToolKind
    unitOrdinal: number | null
    query: string
    answer: string
    answers: StudyQuizAnswer[]
  } {
    if (!isPlainObject(body)) throw new ArgumentError('请求格式不正确。')
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!isUuid(sessionId)) throw new ArgumentError('sessionId 不是有效的课堂。')
    const tool = typeof body.tool === 'string' ? body.tool : ''
    const allowed: StudyToolKind[] = ['search', 'summary', 'outline', 'quiz', 'quiz-grade', 'teachback']
    if (!(allowed as string[]).includes(tool)) throw new ArgumentError('这个老师工具不在白名单里。')
    const ordinal = body.unitOrdinal
    if (ordinal != null && (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0)) {
      throw new ArgumentError('unitOrdinal 不是有效的小讲序号。')
    }
    const unitOrdinal = typeof ordinal === 'number' ? ordinal : null
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (tool === 'search') {
      if (!query) throw new ArgumentError('先写要查找的词。')
      if (query.length > MAX_SEARCH_QUERY_CHARS) throw new ArgumentError(`查找词最多 ${MAX_SEARCH_QUERY_CHARS} 个字。`)
    }
    const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
    if (tool === 'teachback') {
      if (answer.length < 20) throw new ArgumentError('先写至少 20 个字的复述。')
      if (answer.length > MAX_ANSWER_CHARS) throw new ArgumentError(`一次最多答 ${MAX_ANSWER_CHARS} 个字。`)
    }
    const rawAnswers = Array.isArray(body.answers) ? body.answers : []
    if (tool === 'quiz-grade' && rawAnswers.length === 0) throw new ArgumentError('先写下你的答案。')
    if (tool === 'quiz-grade' && rawAnswers.length > 3) throw new ArgumentError('一次最多提交 3 道题。')
    const answers = rawAnswers.map((item) => {
      const row = isPlainObject(item) ? item : {}
      const questionId = typeof row.questionId === 'string' ? row.questionId.trim() : ''
      const text = typeof row.answer === 'string' ? row.answer.trim() : ''
      if (!questionId || !text) throw new ArgumentError('每道题都要作答。')
      if (text.length > MAX_TOOL_ANSWER_CHARS) throw new ArgumentError(`每道题最多答 ${MAX_TOOL_ANSWER_CHARS} 个字。`)
      return { questionId, answer: text }
    })
    return { sessionId, tool: tool as StudyToolKind, unitOrdinal, query, answer, answers }
  }

  /** 自然语言工具入口的回复：先把结果落进课程资料，再在对话里给一句可读的交代。 */
  private toolChatReply(intent: StudyToolKind, artifact: StudyArtifact | undefined, unit: StudyUnit | null): string {
    if (!artifact) return '这次工具没有返回结果，先按普通讲解继续。'
    if (intent === 'summary') {
      return `我把${unit ? `「${unit.title}」` : '整门课'}的总结放进课程资料了。\n\n${artifact.body.text ?? ''}`.trim()
    }
    if (intent === 'outline') {
      const items = artifact.body.items ?? []
      return [
        `复习大纲列好了，放在课程资料里。${unit ? `这次只列「${unit.title}」。` : '这次列整门课。'}`,
        ...items.map((item, index) => `${index + 1}. ${item.title}`),
      ].join('\n')
    }
    if (intent === 'search') {
      const matches = artifact.body.matches ?? []
      if (matches.length === 0) return artifact.body.message ?? '没找到相关原文。'
      return [
        `找到 ${matches.length} 处原文，都是这门课里的：`,
        ...matches.slice(0, 3).map(
          (match, index) =>
            `${index + 1}. 第 ${match.unitOrdinal + 1} 讲「${match.unitTitle}」：${match.excerpt.slice(0, 80)}`,
        ),
      ].join('\n')
    }
    if (intent === 'quiz') {
      const questions = artifact.body.questions ?? []
      return [
        `我出了 ${questions.length} 道题，放在课程资料里。先自己答，答完再交给我判。`,
        ...questions.map((question, index) => `${index + 1}. ${question.prompt}`),
      ].join('\n\n')
    }
    if (intent === 'teachback') {
      const gaps = artifact.body.gaps ?? []
      return [
        '我按原文看了你的复述。',
        artifact.body.feedback ?? '',
        ...(gaps.length ? ['还没讲到的：', ...gaps.map((gap, index) => `${index + 1}. ${gap}`)] : []),
      ]
        .filter(Boolean)
        .join('\n\n')
    }
    return '这个老师工具已经处理好了。'
  }

  /** 同 kind/scope 覆盖旧结果；不存在时新建。 */
  private saveToolArtifact(
    sessionId: string,
    kind: StudyArtifactRow['kind'],
    scope: string,
    title: string,
    body: Record<string, unknown>,
    stamp: string,
  ): void {
    const existing = this.store.findArtifact(sessionId, kind, scope)
    this.store.upsertArtifact({
      id: existing?.id ?? randomUUID(),
      session_id: sessionId,
      kind,
      scope,
      title: title.slice(0, 80),
      body_json: JSON.stringify(body),
      created_at: existing?.created_at ?? stamp,
      updated_at: stamp,
    })
  }

  private checkBody(body: unknown): { sessionId: string; unitOrdinal: number; segmentIndex: number; answer: string } {    if (!isPlainObject(body)) throw new ArgumentError('请求格式不正确。')
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!isUuid(sessionId)) throw new ArgumentError('sessionId 不是有效的课堂。')
    const unitOrdinal = body.unitOrdinal
    if (typeof unitOrdinal !== 'number' || !Number.isInteger(unitOrdinal) || unitOrdinal < 0) {
      throw new ArgumentError('unitOrdinal 不是有效的小讲序号。')
    }
    const segmentIndex = body.segmentIndex
    if (typeof segmentIndex !== 'number' || !Number.isInteger(segmentIndex) || segmentIndex < 0) {
      throw new ArgumentError('segmentIndex 不是有效的讲解序号。')
    }
    const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
    if (!answer) throw new ArgumentError('先写下你的答案。')
    if (answer.length > MAX_ANSWER_CHARS) throw new ArgumentError(`一次最多答 ${MAX_ANSWER_CHARS} 个字。`)
    return { sessionId, unitOrdinal, segmentIndex, answer }
  }

  private sessionId(body: unknown): string {    if (!isPlainObject(body)) throw new ArgumentError('请求格式不正确。')
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!isUuid(sessionId)) throw new ArgumentError('sessionId 不是有效的课堂。')
    return sessionId
  }

  private failure(requestId: string, error: unknown): Result<never> {
    if (error instanceof AiError) return fail(requestId, error.code, error.message)
    if (error instanceof ArgumentError) return fail(requestId, 'INVALID_ARGUMENT', error.message)
    console.error('[study]', error)
    return fail(requestId, 'STORAGE_ERROR', '课堂数据处理失败，请重试。')
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function artifactFromRow(row: StudyArtifactRow): StudyArtifact {
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    title: row.title,
    body: parseArtifactBody(row.body_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseArtifactBody(raw: string): StudyArtifact['body'] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return isPlainObject(parsed) ? parsed as StudyArtifact['body'] : {}
  } catch {
    return {}
  }
}

function artifactIdFrom(raw: string | undefined): string {
  if (!raw) return ''
  try {
    const locator = JSON.parse(raw) as { artifactId?: unknown }
    return typeof locator.artifactId === 'string' ? locator.artifactId : ''
  } catch {
    return ''
  }
}

function slideNumberFromLocator(raw: string | undefined): number | null {
  if (!raw) return null
  try {
    const locator = JSON.parse(raw) as { slideNumber?: unknown }
    return typeof locator.slideNumber === 'number' && Number.isInteger(locator.slideNumber) && locator.slideNumber > 0
      ? locator.slideNumber
      : null
  } catch {
    return null
  }
}

function parseStringList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function unitFromRow(row: StudyUnitRow): StudyUnit {
  return {
    id: row.id,
    ordinal: Number(row.ordinal),
    title: row.title,
    source: row.source,
    minutes: Number(row.minutes),
    keyPoints: parseStringList(row.key_points_json),
    segments: parseSegments(row.segments_json),
  }
}

function parseBbox(raw: string): [number, number, number, number] | null {
  try {
    const locator = JSON.parse(raw) as { bbox?: unknown }
    if (!Array.isArray(locator.bbox) || locator.bbox.length !== 4) return null
    if (!locator.bbox.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
    return locator.bbox as [number, number, number, number]
  } catch {
    return null
  }
}

function pageRange(text: string): [number, number] | null {
  const match = /第\s*(\d{1,3})(?:\s*(?:-|–|—|~|至)\s*(\d{1,3}))?\s*页/.exec(text)
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2] ?? match[1])
  if (start < 1 || end < start || end > 999) return null
  return [start, end]
}

function normalizeText(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？""''（）()\[\]【】《》·—–~]/g, '')
    .toLowerCase()
}

function pageMentions(text: string): number[] {
  const found = new Set<number>()
  const patterns = [
    /(?:第\s*)?(\d{1,3})\s*页/g,
    /\[\s*p\.?\s*(\d{1,3})\s*\]/gi,
    /\bp\.\s*(\d{1,3})\b/gi,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const number = Number(match[1])
      if (number > 0) found.add(number)
    }
  }
  return [...found]
}

function quoteForPage(page: CitationPage, unit: StudyUnit): string {
  // 扫描版 PDF 的 OCR 文本可能是乱码；这一页正好是当前讲的出处页时，
  // 用老师讲稿里已经校对过的原句，不把 OCR 噪声当成“原文”展示给学生。
  const pageRef = /第\s*(\d+)\s*页/.exec(unit.source)
  if (pageRef && Number(pageRef[1]) === page.pageNumber) {
    const first = unit.segments[0]?.source.trim()
    if (first) return first.slice(0, 240)
    const afterColon = unit.source.split(/[：:]/)[1]?.trim()
    if (afterColon) return afterColon.slice(0, 240)
  }
  const segment = unit.segments.find((item) => normalizeText(page.text).includes(normalizeText(item.source)))
  if (segment) return segment.source.slice(0, 240)
  const text = page.text.replace(/\s+/g, ' ').trim()
  const sentence = text.split(/(?<=[。！？])/)[0] ?? text
  return sentence.slice(0, 180)
}

function parseSegments(raw: string): StudyUnit['segments'] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => {
        const row = isPlainObject(item) ? item : {}
        return {
          source: typeof row.source === 'string' ? row.source : '',
          explain: typeof row.explain === 'string' ? row.explain : '',
          check: typeof row.check === 'string' ? row.check : '',
        }
      })
      .filter((segment) => segment.source && segment.explain)
  } catch {
    return []
  }
}

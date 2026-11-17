import type { AppDatabase } from './database'
import type {
  StudyArtifactKind,
  StudyCourse,
  StudyMessage,
  StudyMessageRole,
  StudyMissItem,
  StudySessionListItem,
  StudySlideCitation,
  StudyStatus,
  StudySummary,
} from '../shared/study'

export type StudySessionRow = {
  id: string
  request_id: string
  document_version_id: string
  course_id: string | null
  title: string
  subject: string
  source_name: string
  overview: string
  outline_json: string
  habits_json: string
  warnings_json: string
  truncated: number
  material_chars: number
  material_chunks: number
  status: StudyStatus
  summary_json: string
  teacher_snapshot_json: string
  created_at: string
  updated_at: string
}

export type StudyCourseRow = {
  id: string
  name: string
  sort_order: number
  created_at: string
  updated_at: string
}

export type StudyUnitRow = {
  id: string
  session_id: string
  ordinal: number
  title: string
  source: string
  minutes: number
  key_points_json: string
  segments_json: string
}

export type StudyMessageRow = {
  id: string
  session_id: string
  role: StudyMessageRole
  unit_ordinal: number | null
  content: string
  citations_json: string
  created_at: string
}

export type StudyCheckRow = {
  id: string
  session_id: string
  unit_ordinal: number
  segment_index: number
  question: string
  answer: string
  created_at: string
}

export type StudyArtifactRow = {
  id: string
  session_id: string
  kind: StudyArtifactKind
  scope: string
  title: string
  body_json: string
  created_at: string
  updated_at: string
}

export type StudyMissRow = {
  id: string
  session_id: string
  course_id: string | null
  unit_ordinal: number
  question_id: string
  prompt: string
  answer: string
  explain: string
  source: string
  page_number: number | null
  created_at: string
  last_practiced_at: string | null
  resolved_at: string | null
}

export function missFromRow(row: StudyMissRow): StudyMissItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    courseId: row.course_id,
    unitOrdinal: row.unit_ordinal,
    questionId: row.question_id,
    prompt: row.prompt,
    answer: row.answer,
    explain: row.explain,
    source: row.source,
    pageNumber: row.page_number,
    createdAt: row.created_at,
    lastPracticedAt: row.last_practiced_at,
    resolvedAt: row.resolved_at,
  }
}

export type SessionBundle = {
  session: StudySessionRow
  units: StudyUnitRow[]
  message: StudyMessageRow
}

export class StudyStore {
  constructor(private readonly db: AppDatabase) {}

  findByRequest(requestId: string): StudySessionRow | undefined {
    return this.db.get<StudySessionRow>('SELECT * FROM study_sessions WHERE request_id = ?', requestId)
  }

  getSession(id: string): StudySessionRow | undefined {
    return this.db.get<StudySessionRow>('SELECT * FROM study_sessions WHERE id = ?', id)
  }

  createBundle(bundle: SessionBundle): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO study_sessions(
          id, request_id, document_version_id, course_id, title, subject, source_name, overview, outline_json,
          habits_json, warnings_json, truncated, material_chars, material_chunks, status, summary_json,
          teacher_snapshot_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bundle.session.id,
        bundle.session.request_id,
        bundle.session.document_version_id,
        bundle.session.course_id,
        bundle.session.title,
        bundle.session.subject,
        bundle.session.source_name,
        bundle.session.overview,
        bundle.session.outline_json,
        bundle.session.habits_json,
        bundle.session.warnings_json,
        bundle.session.truncated,
        bundle.session.material_chars,
        bundle.session.material_chunks,
        bundle.session.status,
        bundle.session.summary_json,
        bundle.session.teacher_snapshot_json,
        bundle.session.created_at,
        bundle.session.updated_at,
      )
      for (const unit of bundle.units) {
        this.db.run(
          `INSERT INTO study_units(id, session_id, ordinal, title, source, minutes, key_points_json, segments_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          unit.id,
          unit.session_id,
          unit.ordinal,
          unit.title,
          unit.source,
          unit.minutes,
          unit.key_points_json,
          unit.segments_json,
        )
      }
      this.db.run(
        `INSERT INTO study_messages(id, session_id, role, unit_ordinal, content, citations_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        bundle.message.id,
        bundle.message.session_id,
        bundle.message.role,
        bundle.message.unit_ordinal,
        bundle.message.content,
        bundle.message.citations_json,
        bundle.message.created_at,
      )
    })
  }

  listSessions(): StudySessionListItem[] {
    const rows = this.db.all<StudySessionRow & { unit_count: number; message_count: number }>(
      `SELECT s.*,
        (SELECT COUNT(*) FROM study_units u WHERE u.session_id = s.id) AS unit_count,
        (SELECT COUNT(*) FROM study_messages m WHERE m.session_id = s.id) AS message_count
       FROM study_sessions s
       ORDER BY s.created_at DESC`,
    )
    return rows.map((row) => ({
      sessionId: row.id,
      documentVersionId: row.document_version_id,
      courseId: row.course_id ?? null,
      title: row.title,
      subject: row.subject,
      sourceName: row.source_name,
      unitCount: Number(row.unit_count),
      messageCount: Number(row.message_count),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  listUnits(sessionId: string): StudyUnitRow[] {
    return this.db.all<StudyUnitRow>(
      'SELECT * FROM study_units WHERE session_id = ? ORDER BY ordinal ASC',
      sessionId,
    )
  }

  listCourseRows(): StudyCourse[] {
    return this.db.all<StudyCourseRow>('SELECT * FROM study_courses ORDER BY sort_order ASC, created_at ASC').map((row) => ({
      courseId: row.id,
      name: row.name,
      sortOrder: Number(row.sort_order),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  findCourse(id: string): StudyCourse | undefined {
    const row = this.db.get<StudyCourseRow>('SELECT * FROM study_courses WHERE id = ?', id)
    return row ? {
      courseId: row.id,
      name: row.name,
      sortOrder: Number(row.sort_order),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : undefined
  }

  findCourseByName(name: string): StudyCourse | undefined {
    const row = this.db.get<StudyCourseRow>('SELECT * FROM study_courses WHERE name = ?', name)
    return row ? {
      courseId: row.id,
      name: row.name,
      sortOrder: Number(row.sort_order),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : undefined
  }

  createCourse(course: StudyCourse): void {
    this.db.run(
      `INSERT INTO study_courses(id, name, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      course.courseId, course.name, course.sortOrder, course.createdAt, course.updatedAt,
    )
  }

  renameCourse(courseId: string, name: string, updatedAt: string): void {
    this.db.run('UPDATE study_courses SET name = ?, updated_at = ? WHERE id = ?', name, updatedAt, courseId)
  }

  reorderCourses(ids: string[], updatedAt: string): void {
    this.db.transaction(() => {
      ids.forEach((id, index) => {
        this.db.run('UPDATE study_courses SET sort_order = ?, updated_at = ? WHERE id = ?', index, updatedAt, id)
      })
    })
  }

  /** 删课程：先清掉每份课件的用量，再删课件（units/messages/checks 等随外键级联）。 */
  deleteCourse(courseId: string): void {
    this.db.transaction(() => {
      const sessions = this.db.all<{ id: string }>('SELECT id FROM study_sessions WHERE course_id = ?', courseId)
      for (const session of sessions) {
        this.db.run('DELETE FROM ai_usage WHERE session_id = ?', session.id)
        this.db.run('DELETE FROM study_sessions WHERE id = ?', session.id)
      }
      this.db.run('DELETE FROM study_courses WHERE id = ?', courseId)
    })
  }

  listMessages(sessionId: string): StudyMessageRow[] {
    return this.db.all<StudyMessageRow>(
      'SELECT * FROM study_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
      sessionId,
    )
  }

  appendMessage(message: StudyMessageRow): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO study_messages(id, session_id, role, unit_ordinal, content, citations_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        message.id,
        message.session_id,
        message.role,
        message.unit_ordinal,
        message.content,
        message.citations_json,
        message.created_at,
      )
      this.db.run('UPDATE study_sessions SET updated_at = ? WHERE id = ?', message.created_at, message.session_id)
    })
  }

  saveSummary(sessionId: string, summary: StudySummary, updatedAt: string): void {
    this.db.run(
      'UPDATE study_sessions SET summary_json = ?, status = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(summary),
      'finished',
      updatedAt,
      sessionId,
    )
  }

  touch(sessionId: string, updatedAt: string): void {
    this.db.run('UPDATE study_sessions SET updated_at = ? WHERE id = ?', updatedAt, sessionId)
  }

  /** 清除一门课的对话记录，保留课程与总结。 */
  clearMessages(sessionId: string, updatedAt: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM study_messages WHERE session_id = ?', sessionId)
      this.db.run('UPDATE study_sessions SET updated_at = ? WHERE id = ?', updatedAt, sessionId)
    })
  }

  /** 清除一门课的学习总结，回到「未生成」状态。 */
  clearSummary(sessionId: string, updatedAt: string): void {
    this.db.run(
      "UPDATE study_sessions SET summary_json = '', status = 'ready', updated_at = ? WHERE id = ?",
      updatedAt,
      sessionId,
    )
  }

  /** 删除一门课（units/messages/checks 随外键级联；ai_usage 手动清掉）。 */
  deleteSession(sessionId: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM ai_usage WHERE session_id = ?', sessionId)
      this.db.run('DELETE FROM study_sessions WHERE id = ?', sessionId)
    })
  }

  listChecks(sessionId: string): StudyCheckRow[] {
    return this.db.all<StudyCheckRow>(
      'SELECT * FROM study_checks WHERE session_id = ? ORDER BY unit_ordinal ASC, segment_index ASC',
      sessionId,
    )
  }

  listArtifacts(sessionId: string): StudyArtifactRow[] {
    return this.db.all<StudyArtifactRow>(
      'SELECT * FROM study_artifacts WHERE session_id = ? ORDER BY updated_at DESC, rowid DESC',
      sessionId,
    )
  }

  findArtifact(sessionId: string, kind: StudyArtifactKind, scope: string): StudyArtifactRow | undefined {
    return this.db.get<StudyArtifactRow>(
      'SELECT * FROM study_artifacts WHERE session_id = ? AND kind = ? AND scope = ?',
      sessionId,
      kind,
      scope,
    )
  }

  /** 同 kind/scope 覆盖旧版本；每门课最多保留 20 条，避免课堂资料无限膨胀。 */
  upsertArtifact(row: StudyArtifactRow): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO study_artifacts(id, session_id, kind, scope, title, body_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, kind, scope) DO UPDATE SET
           title = excluded.title,
           body_json = excluded.body_json,
           updated_at = excluded.updated_at`,
        row.id,
        row.session_id,
        row.kind,
        row.scope,
        row.title,
        row.body_json,
        row.created_at,
        row.updated_at,
      )
      this.db.run(
        `DELETE FROM study_artifacts
         WHERE session_id = ? AND id NOT IN (
           SELECT id FROM study_artifacts WHERE session_id = ?
           ORDER BY updated_at DESC, rowid DESC LIMIT 20
         )`,
        row.session_id,
        row.session_id,
      )
    })
  }

  /** 同一讲同一句只保留最后一次作答，改答案不会堆出多份记录。 */
  upsertCheck(row: StudyCheckRow): void {    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO study_checks(id, session_id, unit_ordinal, segment_index, question, answer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, unit_ordinal, segment_index) DO UPDATE SET
           question = excluded.question,
           answer = excluded.answer,
           created_at = excluded.created_at`,
        row.id,
        row.session_id,
        row.unit_ordinal,
        row.segment_index,
        row.question,
        row.answer,
        row.created_at,
      )
      this.db.run('UPDATE study_sessions SET updated_at = ? WHERE id = ?', row.created_at, row.session_id)
    })
  }

  /** 同一道题只留一条错题；重判时更新作答与解析，并重新打开。 */
  upsertMiss(row: StudyMissRow): void {
    this.db.run(
      `INSERT INTO study_misses(
         id, session_id, course_id, unit_ordinal, question_id, prompt, answer, explain,
         source, page_number, created_at, last_practiced_at, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, unit_ordinal, question_id) DO UPDATE SET
         prompt = excluded.prompt,
         answer = excluded.answer,
         explain = excluded.explain,
         source = excluded.source,
         page_number = excluded.page_number,
         created_at = excluded.created_at,
         last_practiced_at = NULL,
         resolved_at = NULL`,
      row.id,
      row.session_id,
      row.course_id,
      row.unit_ordinal,
      row.question_id,
      row.prompt,
      row.answer,
      row.explain,
      row.source,
      row.page_number,
      row.created_at,
      row.last_practiced_at,
      row.resolved_at,
    )
  }

  /** 重判答对时，把同一道题的旧错题关掉。 */
  resolveMissByQuestion(sessionId: string, unitOrdinal: number, questionId: string, at: string): void {
    this.db.run(
      `UPDATE study_misses SET resolved_at = ?, last_practiced_at = ?
       WHERE session_id = ? AND unit_ordinal = ? AND question_id = ? AND resolved_at IS NULL`,
      at,
      at,
      sessionId,
      unitOrdinal,
      questionId,
    )
  }

  listOpenMisses(limit: number): StudyMissItem[] {
    return this.db.all<StudyMissRow>(
      'SELECT * FROM study_misses WHERE resolved_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?',
      limit,
    ).map(missFromRow)
  }

  countOpenMisses(): number {
    return this.db.get<{ total: number }>('SELECT COUNT(*) AS total FROM study_misses WHERE resolved_at IS NULL')?.total ?? 0
  }

  getMiss(id: string): StudyMissItem | undefined {
    const row = this.db.get<StudyMissRow>('SELECT * FROM study_misses WHERE id = ?', id)
    return row ? missFromRow(row) : undefined
  }

  /** remembered=true 表示这次记住了，关掉错题；false 表示又忘了，留在队列里。 */
  gradeMiss(id: string, remembered: boolean, at: string): StudyMissItem | undefined {
    this.db.run(
      `UPDATE study_misses SET last_practiced_at = ?, resolved_at = ?
       WHERE id = ?`,
      at,
      remembered ? at : null,
      id,
    )
    return this.getMiss(id)
  }

  /** 同一份文稿、材料没变过时，逐段理解结果直接复用，不再重复扣 API。 */
  findMaterialDigest(versionId: string, materialSha: string): MaterialDigestRow | undefined {
    return this.db.get<MaterialDigestRow>(
      'SELECT * FROM material_digests WHERE document_version_id = ? AND material_sha = ?',
      versionId,
      materialSha,
    )
  }

  saveMaterialDigest(row: MaterialDigestRow): void {
    this.db.run(
      `INSERT INTO material_digests(document_version_id, material_sha, chunk_count, rendered_text, digests_json, warnings_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(document_version_id) DO UPDATE SET
         material_sha = excluded.material_sha,
         chunk_count = excluded.chunk_count,
         rendered_text = excluded.rendered_text,
         digests_json = excluded.digests_json,
         warnings_json = excluded.warnings_json,
         created_at = excluded.created_at`,
      row.document_version_id,
      row.material_sha,
      row.chunk_count,
      row.rendered_text,
      row.digests_json,
      row.warnings_json,
      row.created_at,
    )
  }

  insertUsage(row: UsageInsert): void {
    const prompt = Math.max(0, Math.round(row.promptTokens))
    const cached = Math.max(0, Math.round(row.cachedTokens))
    this.db.run(
      `INSERT INTO ai_usage(
         session_id, document_version_id, kind, prompt_tokens, cached_tokens, cache_miss_tokens,
         completion_tokens, reasoning_tokens, provider_reported, model, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.sessionId,
      row.documentVersionId,
      row.kind,
      prompt,
      cached,
      Math.max(0, Math.round(row.cacheMissTokens ?? Math.max(0, prompt - cached))),
      Math.max(0, Math.round(row.completionTokens)),
      Math.max(0, Math.round(row.reasoningTokens ?? 0)),
      row.providerReported === false ? 0 : 1,
      row.model ?? '',
      row.createdAt,
    )
  }

  /** 开课时读图/分段理解还没 sessionId；课建好后把这份文稿上没有归属的用量记到这门课名下。 */
  claimUsage(sessionId: string, documentVersionId: string): void {
    this.db.run(
      'UPDATE ai_usage SET session_id = ? WHERE session_id IS NULL AND document_version_id = ?',
      sessionId,
      documentVersionId,
    )
  }

  usageOfSession(sessionId: string): UsageTotal {
    const row = this.db.get<{
      calls: number
      prompt: number
      cached: number
      miss: number
      completion: number
      reasoning: number
      reported: number
      estimated: number
    }>(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt,
              COALESCE(SUM(cached_tokens), 0) AS cached,
              COALESCE(SUM(cache_miss_tokens), 0) AS miss,
              COALESCE(SUM(completion_tokens), 0) AS completion,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
              COALESCE(SUM(CASE WHEN provider_reported = 1 THEN 1 ELSE 0 END), 0) AS reported,
              COALESCE(SUM(CASE WHEN provider_reported = 0 THEN 1 ELSE 0 END), 0) AS estimated
       FROM ai_usage WHERE session_id = ?`,
      sessionId,
    )
    return {
      calls: row?.calls ?? 0,
      promptTokens: row?.prompt ?? 0,
      cachedTokens: row?.cached ?? 0,
      cacheMissTokens: row?.miss ?? 0,
      completionTokens: row?.completion ?? 0,
      reasoningTokens: row?.reasoning ?? 0,
      reportedCalls: row?.reported ?? 0,
      estimatedCalls: row?.estimated ?? 0,
    }
  }

  /** 按调用类型拆开，界面上能看清是开课、聊天、总结还是读图花掉的。 */
  usageKinds(sessionId: string): UsageKindTotal[] {
    return this.db.all<{
      kind: string
      calls: number
      prompt: number
      cached: number
      miss: number
      completion: number
      reasoning: number
      reported: number
      estimated: number
    }>(
      `SELECT kind,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt,
              COALESCE(SUM(cached_tokens), 0) AS cached,
              COALESCE(SUM(cache_miss_tokens), 0) AS miss,
              COALESCE(SUM(completion_tokens), 0) AS completion,
              COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
              COALESCE(SUM(CASE WHEN provider_reported = 1 THEN 1 ELSE 0 END), 0) AS reported,
              COALESCE(SUM(CASE WHEN provider_reported = 0 THEN 1 ELSE 0 END), 0) AS estimated
       FROM ai_usage WHERE session_id = ?
       GROUP BY kind
       ORDER BY MIN(id) ASC`,
      sessionId,
    ).map((row) => ({
      kind: row.kind,
      calls: row.calls,
      promptTokens: row.prompt,
      cachedTokens: row.cached,
      cacheMissTokens: row.miss,
      completionTokens: row.completion,
      reasoningTokens: row.reasoning,
      reportedCalls: row.reported,
      estimatedCalls: row.estimated,
    }))
  }
}

export type MaterialDigestRow = {
  document_version_id: string
  material_sha: string
  chunk_count: number
  rendered_text: string
  digests_json: string
  warnings_json: string
  created_at: string
}

export type UsageInsert = {
  sessionId: string | null
  documentVersionId: string | null
  kind: string
  promptTokens: number
  cachedTokens: number
  /** 不传时按 promptTokens - cachedTokens 补。 */
  cacheMissTokens?: number
  completionTokens: number
  reasoningTokens?: number
  /** false：供应商没回 usage，整行只能当估算。 */
  providerReported?: boolean
  model?: string
  createdAt: string
}

export type UsageTotal = {
  calls: number
  promptTokens: number
  cachedTokens: number
  cacheMissTokens: number
  completionTokens: number
  reasoningTokens: number
  reportedCalls: number
  estimatedCalls: number
}

export type UsageKindTotal = UsageTotal & { kind: string }

function parseCitations(value: string): StudySlideCitation[] {
  try {
    const parsed = JSON.parse(value || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is StudySlideCitation => {
      if (!item || typeof item !== 'object') return false
      const row = item as Record<string, unknown>
      return typeof row.pageNumber === 'number' && typeof row.quote === 'string'
    }).map((item) => ({
      pageNumber: item.pageNumber,
      pageId: typeof item.pageId === 'string' ? item.pageId : null,
      quote: item.quote,
      blockId: typeof item.blockId === 'string' ? item.blockId : null,
      bbox: Array.isArray(item.bbox) && item.bbox.length === 4
        && item.bbox.every((n) => typeof n === 'number')
        ? item.bbox as [number, number, number, number]
        : null,
    }))
  } catch {
    return []
  }
}

export function messageFromRow(row: StudyMessageRow): StudyMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    unitOrdinal: row.unit_ordinal,
    content: row.content,
    citations: parseCitations(row.citations_json ?? '[]'),
    createdAt: row.created_at,
  }
}

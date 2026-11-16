import type { AppDatabase } from './database'
import type { StudyMessage, StudyMessageRole, StudySessionListItem, StudyStatus, StudySummary } from '../shared/study'

export type StudySessionRow = {
  id: string
  request_id: string
  document_version_id: string
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
          id, request_id, document_version_id, title, subject, source_name, overview, outline_json,
          habits_json, warnings_json, truncated, material_chars, material_chunks, status, summary_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        bundle.session.id,
        bundle.session.request_id,
        bundle.session.document_version_id,
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
        `INSERT INTO study_messages(id, session_id, role, unit_ordinal, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        bundle.message.id,
        bundle.message.session_id,
        bundle.message.role,
        bundle.message.unit_ordinal,
        bundle.message.content,
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

  listMessages(sessionId: string): StudyMessageRow[] {
    return this.db.all<StudyMessageRow>(
      'SELECT * FROM study_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC',
      sessionId,
    )
  }

  appendMessage(message: StudyMessageRow): void {
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO study_messages(id, session_id, role, unit_ordinal, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        message.id,
        message.session_id,
        message.role,
        message.unit_ordinal,
        message.content,
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

  listChecks(sessionId: string): StudyCheckRow[] {
    return this.db.all<StudyCheckRow>(
      'SELECT * FROM study_checks WHERE session_id = ? ORDER BY unit_ordinal ASC, segment_index ASC',
      sessionId,
    )
  }

  /** 同一讲同一句只保留最后一次作答，改答案不会堆出多份记录。 */
  upsertCheck(row: StudyCheckRow): void {
    this.db.transaction(() => {
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
    this.db.run(
      `INSERT INTO ai_usage(session_id, document_version_id, kind, prompt_tokens, cached_tokens, completion_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.sessionId,
      row.documentVersionId,
      row.kind,
      row.promptTokens,
      row.cachedTokens,
      row.completionTokens,
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
    const row = this.db.get<{ calls: number; prompt: number; cached: number; completion: number }>(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt,
              COALESCE(SUM(cached_tokens), 0) AS cached,
              COALESCE(SUM(completion_tokens), 0) AS completion
       FROM ai_usage WHERE session_id = ?`,
      sessionId,
    )
    return {
      calls: row?.calls ?? 0,
      promptTokens: row?.prompt ?? 0,
      cachedTokens: row?.cached ?? 0,
      completionTokens: row?.completion ?? 0,
    }
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
  completionTokens: number
  createdAt: string
}

export type UsageTotal = {
  calls: number
  promptTokens: number
  cachedTokens: number
  completionTokens: number
}

export function messageFromRow(row: StudyMessageRow): StudyMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    unitOrdinal: row.unit_ordinal,
    content: row.content,
    createdAt: row.created_at,
  }
}

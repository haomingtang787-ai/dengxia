import type { AppDatabase } from './database'
import type {
  LearnerProfile,
  TeacherMemory,
  TeacherMemoryInput,
  TeacherMemoryKind,
  TeacherNote,
  TeacherPersona,
  TeacherPersonaInput,
  TeacherPronoun,
} from '../shared/teacher'

export type TeacherPersonaRow = {
  id: number
  name: string
  pronoun: TeacherPronoun
  tone: string
  boundaries_json: string
  version: number
  updated_at: string
}

export type LearnerProfileRow = {
  id: number
  goal: string
  level: string
  subjects_json: string
  exam_date: string | null
  weekly_minutes: number
  notes: string
  updated_at: string
}

export type TeacherMemoryRow = {
  id: string
  kind: TeacherMemoryKind
  subject: string
  concept: string
  statement: string
  evidence: string
  confidence: number
  source_session_id: string | null
  source_document_version_id: string | null
  user_confirmed: number
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
  last_seen_at: string
}

export type TeacherNoteRow = {
  session_id: string
  summary: string
  worked_json: string
  stuck_json: string
  next_json: string
  created_at: string
}

function strings(value: string, fallback: string[] = []): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : fallback
  } catch {
    return fallback
  }
}

function personaOf(row: TeacherPersonaRow): TeacherPersona {
  return {
    name: row.name,
    pronoun: row.pronoun,
    tone: row.tone,
    boundaries: strings(row.boundaries_json),
    version: Number(row.version),
    updatedAt: row.updated_at,
  }
}

function profileOf(row: LearnerProfileRow): LearnerProfile {
  return {
    goal: row.goal,
    level: row.level,
    subjects: strings(row.subjects_json),
    examDate: row.exam_date,
    weeklyMinutes: Number(row.weekly_minutes),
    notes: row.notes,
    updatedAt: row.updated_at,
  }
}

function memoryOf(row: TeacherMemoryRow): TeacherMemory {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    concept: row.concept,
    statement: row.statement,
    evidence: row.evidence,
    confidence: Number(row.confidence),
    sourceSessionId: row.source_session_id,
    sourceDocumentVersionId: row.source_document_version_id,
    userConfirmed: Boolean(row.user_confirmed),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  }
}

function noteOf(row: TeacherNoteRow): TeacherNote {
  return {
    sessionId: row.session_id,
    summary: row.summary,
    worked: strings(row.worked_json),
    stuck: strings(row.stuck_json),
    next: strings(row.next_json),
    createdAt: row.created_at,
  }
}

/** 老师人格、学生档案、长期记忆与课堂手记的持久化。AI 调用不在这里。 */
export class TeacherStore {
  constructor(private readonly db: AppDatabase) {}

  persona(): TeacherPersona {
    const row = this.db.get<TeacherPersonaRow>('SELECT * FROM teacher_persona WHERE id = 1')
    if (row) return personaOf(row)
    const at = new Date().toISOString()
    this.db.run(
      `INSERT OR IGNORE INTO teacher_persona(id, name, pronoun, tone, boundaries_json, version, updated_at)
       VALUES (1, '老师', 'she', 'warm-rigorous', '[]', 1, ?)`,
      at,
    )
    return personaOf(this.db.get<TeacherPersonaRow>('SELECT * FROM teacher_persona WHERE id = 1')!)
  }

  savePersona(input: TeacherPersonaInput, at: string): TeacherPersona {
    const current = this.persona()
    this.db.run(
      `UPDATE teacher_persona
       SET name = ?, pronoun = ?, tone = ?, boundaries_json = ?, version = ?, updated_at = ?
       WHERE id = 1`,
      input.name,
      input.pronoun ?? current.pronoun,
      input.tone ?? current.tone,
      JSON.stringify(input.boundaries ?? current.boundaries),
      current.version + 1,
      at,
    )
    return this.persona()
  }

  profile(): LearnerProfile {
    const row = this.db.get<LearnerProfileRow>('SELECT * FROM learner_profile WHERE id = 1')
    if (row) return profileOf(row)
    const at = new Date().toISOString()
    this.db.run(
      `INSERT OR IGNORE INTO learner_profile(id, goal, level, subjects_json, exam_date, weekly_minutes, notes, updated_at)
       VALUES (1, '', '', '[]', NULL, 0, '', ?)`,
      at,
    )
    return profileOf(this.db.get<LearnerProfileRow>('SELECT * FROM learner_profile WHERE id = 1')!)
  }

  saveProfile(input: {
    goal: string
    level: string
    subjects: string[]
    examDate: string | null
    weeklyMinutes: number
    notes: string
  }, at: string): LearnerProfile {
    this.db.run(
      `UPDATE learner_profile
       SET goal = ?, level = ?, subjects_json = ?, exam_date = ?, weekly_minutes = ?, notes = ?, updated_at = ?
       WHERE id = 1`,
      input.goal,
      input.level,
      JSON.stringify(input.subjects),
      input.examDate,
      input.weeklyMinutes,
      input.notes,
      at,
    )
    return this.profile()
  }

  listMemories(includeArchived = false): TeacherMemory[] {
    const rows = includeArchived
      ? this.db.all<TeacherMemoryRow>('SELECT * FROM teacher_memory ORDER BY updated_at DESC')
      : this.db.all<TeacherMemoryRow>(
        "SELECT * FROM teacher_memory WHERE status = 'active' ORDER BY user_confirmed DESC, updated_at DESC",
      )
    return rows.map(memoryOf)
  }

  findMemory(kind: TeacherMemoryKind, subject: string, concept: string): TeacherMemoryRow | undefined {
    const row = this.db.get<TeacherMemoryRow>(
      `SELECT * FROM teacher_memory
       WHERE status = 'active' AND kind = ? AND subject = ? AND concept = ?
       ORDER BY updated_at DESC LIMIT 1`,
      kind,
      subject,
      concept,
    )
    return row
  }

  upsertMemory(input: TeacherMemoryInput, id: string, at: string): TeacherMemory {
    const existing = input.id
      ? this.db.get<TeacherMemoryRow>('SELECT * FROM teacher_memory WHERE id = ?', input.id)
      : this.findMemory(input.kind, input.subject ?? '', input.concept ?? '')
    const row: TeacherMemoryRow = {
      id: existing?.id ?? id,
      kind: input.kind,
      subject: input.subject ?? '',
      concept: input.concept ?? '',
      statement: input.statement,
      evidence: input.evidence ?? '',
      confidence: input.confidence ?? 0.5,
      source_session_id: input.sourceSessionId ?? existing?.source_session_id ?? null,
      source_document_version_id: input.sourceDocumentVersionId ?? existing?.source_document_version_id ?? null,
      user_confirmed: (input.userConfirmed ?? Boolean(existing?.user_confirmed)) ? 1 : 0,
      status: input.status ?? existing?.status ?? 'active',
      created_at: existing?.created_at ?? at,
      updated_at: at,
      last_seen_at: at,
    }
    this.db.transaction(() => {
      if (existing) {
        this.db.run(
          `UPDATE teacher_memory
           SET kind = ?, subject = ?, concept = ?, statement = ?, evidence = ?, confidence = ?,
               source_session_id = ?, source_document_version_id = ?, user_confirmed = ?, status = ?,
               updated_at = ?, last_seen_at = ?
           WHERE id = ?`,
          row.kind,
          row.subject,
          row.concept,
          row.statement,
          row.evidence,
          row.confidence,
          row.source_session_id,
          row.source_document_version_id,
          row.user_confirmed,
          row.status,
          row.updated_at,
          row.last_seen_at,
          row.id,
        )
      } else {
        this.db.run(
          `INSERT INTO teacher_memory(
            id, kind, subject, concept, statement, evidence, confidence, source_session_id,
            source_document_version_id, user_confirmed, status, created_at, updated_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.id,
          row.kind,
          row.subject,
          row.concept,
          row.statement,
          row.evidence,
          row.confidence,
          row.source_session_id,
          row.source_document_version_id,
          row.user_confirmed,
          row.status,
          row.created_at,
          row.updated_at,
          row.last_seen_at,
        )
      }
      this.pruneLocked()
    })
    return memoryOf(this.db.get<TeacherMemoryRow>('SELECT * FROM teacher_memory WHERE id = ?', row.id)!)
  }

  /** 只保留 40 条活跃记忆：已确认优先，其次置信度、最近出现。 */
  private pruneLocked(): void {
    const rows = this.db.all<TeacherMemoryRow>(
      "SELECT * FROM teacher_memory WHERE status = 'active'",
    )
    if (rows.length <= 40) return
    const keep = new Set(
      [...rows]
        .sort((a, b) => {
          if (a.user_confirmed !== b.user_confirmed) return b.user_confirmed - a.user_confirmed
          if (a.confidence !== b.confidence) return b.confidence - a.confidence
          return b.last_seen_at.localeCompare(a.last_seen_at)
        })
        .slice(0, 40)
        .map((row) => row.id),
    )
    for (const row of rows) {
      if (!keep.has(row.id)) {
        this.db.run("UPDATE teacher_memory SET status = 'archived', updated_at = ? WHERE id = ?", row.updated_at, row.id)
      }
    }
  }

  deleteMemory(id: string): boolean {
    const row = this.db.get<TeacherMemoryRow>('SELECT * FROM teacher_memory WHERE id = ?', id)
    if (!row) return false
    this.db.run('DELETE FROM teacher_memory WHERE id = ?', id)
    return true
  }

  reset(at: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM teacher_memory')
      this.db.run(
        `UPDATE teacher_persona
         SET name = '老师', pronoun = 'she', tone = 'warm-rigorous', boundaries_json = '[]', version = 1, updated_at = ?
         WHERE id = 1`,
        at,
      )
      this.db.run(
        `UPDATE learner_profile
         SET goal = '', level = '', subjects_json = '[]', exam_date = NULL, weekly_minutes = 0, notes = '', updated_at = ?
         WHERE id = 1`,
        at,
      )
    })
  }

  /** 只取和本课学科/概念相关的一小把记忆，避免把整张表塞进提示词。 */
  relevantMemories(subject: string, concept: string, limit = 6): TeacherMemory[] {
    const trimmedSubject = subject.trim()
    const trimmedConcept = concept.trim()
    let rows: TeacherMemoryRow[]
    if (trimmedSubject || trimmedConcept) {
      rows = this.db.all<TeacherMemoryRow>(
        `SELECT * FROM teacher_memory
         WHERE status = 'active'
           AND (subject = ? OR (? <> '' AND concept LIKE ?) OR subject = '')
         ORDER BY user_confirmed DESC, confidence DESC, last_seen_at DESC
         LIMIT ?`,
        trimmedSubject,
        trimmedConcept,
        trimmedConcept ? `%${trimmedConcept}%` : '',
        limit,
      )
    } else {
      rows = this.db.all<TeacherMemoryRow>(
        "SELECT * FROM teacher_memory WHERE status = 'active' ORDER BY user_confirmed DESC, confidence DESC, last_seen_at DESC LIMIT ?",
        limit,
      )
    }
    return rows.map(memoryOf)
  }

  saveNote(note: TeacherNote, at: string): TeacherNote {
    this.db.run(
      `INSERT INTO teacher_notes(session_id, summary, worked_json, stuck_json, next_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         summary = excluded.summary,
         worked_json = excluded.worked_json,
         stuck_json = excluded.stuck_json,
         next_json = excluded.next_json,
         created_at = excluded.created_at`,
      note.sessionId,
      note.summary,
      JSON.stringify(note.worked),
      JSON.stringify(note.stuck),
      JSON.stringify(note.next),
      at,
    )
    return this.note(note.sessionId)!
  }

  note(sessionId: string): TeacherNote | null {
    const row = this.db.get<TeacherNoteRow>('SELECT * FROM teacher_notes WHERE session_id = ?', sessionId)
    return row ? noteOf(row) : null
  }

  notes(): TeacherNote[] {
    return this.db.all<TeacherNoteRow>('SELECT * FROM teacher_notes ORDER BY created_at DESC').map(noteOf)
  }
}

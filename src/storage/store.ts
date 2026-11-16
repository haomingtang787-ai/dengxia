import type { JobState, ReviewState } from '../shared/contract'
import { AppDatabase } from './database'

export type DocumentRow = {
  id: string
  display_name: string
  created_at: string
}

export type VersionRow = {
  id: string
  document_id: string
  sha256: string
  format: string
  size_bytes: number
  original_relpath: string
  status: string
  parser_version: string
  created_at: string
}

export type JobRow = {
  id: string
  document_version_id: string
  request_id: string
  retry_of: string | null
  state: JobState
  stage: string
  completed: number
  total: number | null
  seq: number
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export type PageRow = {
  id: string
  document_version_id: string
  ordinal: number
  source_kind: string
  source_number: number | null
  image_relpath: string | null
  width: number | null
  height: number | null
  status: string
  preview_resource_id?: string | null
}

export type BlockRow = {
  id: string
  document_version_id: string
  page_id: string | null
  ordinal: number
  kind: string
  text: string
  locator_json: string
  extraction_method: string
  review_state: ReviewState
}

export type ArtifactRow = {
  id: string
  document_version_id: string
  page_id: string | null
  kind: string
  relpath: string
  mime: string
  sha256: string
}

export type ImageReadingRow = {
  id: string
  document_version_id: string
  page_id: string
  kind: 'ocr' | 'vision'
  text: string
  engine: string
  created_at: string
}

export type BlockReadingRow = {
  id: string
  document_version_id: string
  block_id: string
  kind: 'ocr' | 'vision'
  text: string
  engine: string
  created_at: string
}

export type PageResearchRow = {
  id: string
  document_version_id: string
  page_id: string
  query: string
  answer: string
  sources_json: string
  engine: string
  created_at: string
}

export type IssueRow = {
  id: string
  document_version_id: string
  page_id: string | null
  block_id: string | null
  code: string
  message: string
  review_state: ReviewState
  created_at: string
}

export type ListJoinRow = {
  document_id: string
  display_name: string
  created_at: string
  document_version_id: string
  format: string
  size_bytes: number
  status: string
  sha256: string
  job_id: string | null
  job_state: JobState | null
  job_stage: string | null
  job_completed: number | null
  job_total: number | null
  error_code: string | null
  error_message: string | null
}

export class Store {
  constructor(readonly db: AppDatabase) {}

  insertDocument(row: DocumentRow): void {
    this.db.run(
      'INSERT INTO documents(id, display_name, created_at) VALUES (?, ?, ?)',
      row.id,
      row.display_name,
      row.created_at,
    )
  }

  insertVersion(row: VersionRow): void {
    this.db.run(
      `INSERT INTO document_versions(
        id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.document_id,
      row.sha256,
      row.format,
      row.size_bytes,
      row.original_relpath,
      row.status,
      row.parser_version,
      row.created_at,
    )
  }

  insertJob(row: JobRow): void {
    this.db.run(
      `INSERT INTO jobs(
        id, document_version_id, request_id, retry_of, state, stage, completed, total, seq,
        error_code, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.document_version_id,
      row.request_id,
      row.retry_of,
      row.state,
      row.stage,
      row.completed,
      row.total,
      row.seq,
      row.error_code,
      row.error_message,
      row.created_at,
      row.updated_at,
    )
  }

  insertPage(row: Omit<PageRow, 'preview_resource_id'>): void {
    this.db.run(
      `INSERT INTO pages(
        id, document_version_id, ordinal, source_kind, source_number, image_relpath, width, height, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.document_version_id,
      row.ordinal,
      row.source_kind,
      row.source_number,
      row.image_relpath,
      row.width,
      row.height,
      row.status,
    )
  }

  insertBlock(row: BlockRow): void {
    this.db.run(
      `INSERT INTO blocks(
        id, document_version_id, page_id, ordinal, kind, text, locator_json, extraction_method, review_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.document_version_id,
      row.page_id,
      row.ordinal,
      row.kind,
      row.text,
      row.locator_json,
      row.extraction_method,
      row.review_state,
    )
  }

  insertArtifact(row: ArtifactRow): void {
    this.db.run(
      `INSERT INTO artifacts(id, document_version_id, page_id, kind, relpath, mime, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.document_version_id,
      row.page_id,
      row.kind,
      row.relpath,
      row.mime,
      row.sha256,
    )
  }

  insertIssue(row: IssueRow): void {
    this.db.run(
      `INSERT INTO issues(
        id, document_version_id, page_id, block_id, code, message, review_state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.document_version_id,
      row.page_id,
      row.block_id,
      row.code,
      row.message,
      row.review_state,
      row.created_at,
    )
  }

  upsertImageReading(row: ImageReadingRow): void {
    this.db.run(
      `INSERT INTO image_readings(id, document_version_id, page_id, kind, text, engine, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(page_id, kind) DO UPDATE SET
         text = excluded.text,
         engine = excluded.engine,
         created_at = excluded.created_at`,
      row.id,
      row.document_version_id,
      row.page_id,
      row.kind,
      row.text,
      row.engine,
      row.created_at,
    )
  }

  listImageReadings(versionId: string): ImageReadingRow[] {
    return this.db.all<ImageReadingRow>(
      'SELECT * FROM image_readings WHERE document_version_id = ? ORDER BY page_id ASC, kind ASC',
      versionId,
    )
  }

  getBlock(id: string): BlockRow | undefined {
    return this.db.get<BlockRow>('SELECT * FROM blocks WHERE id = ?', id)
  }

  upsertBlockReading(row: BlockReadingRow): void {
    this.db.run(
      `INSERT INTO block_readings(id, document_version_id, block_id, kind, text, engine, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(block_id, kind) DO UPDATE SET
         text = excluded.text,
         engine = excluded.engine,
         created_at = excluded.created_at`,
      row.id,
      row.document_version_id,
      row.block_id,
      row.kind,
      row.text,
      row.engine,
      row.created_at,
    )
  }

  listBlockReadings(versionId: string): BlockReadingRow[] {
    return this.db.all<BlockReadingRow>(
      'SELECT * FROM block_readings WHERE document_version_id = ? ORDER BY block_id ASC, kind ASC',
      versionId,
    )
  }

  upsertPageResearch(row: PageResearchRow): void {
    this.db.run(
      `INSERT INTO page_research(id, document_version_id, page_id, query, answer, sources_json, engine, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET
         id = excluded.id,
         query = excluded.query,
         answer = excluded.answer,
         sources_json = excluded.sources_json,
         engine = excluded.engine,
         created_at = excluded.created_at`,
      row.id,
      row.document_version_id,
      row.page_id,
      row.query,
      row.answer,
      row.sources_json,
      row.engine,
      row.created_at,
    )
  }

  listPageResearch(versionId: string): PageResearchRow[] {
    return this.db.all<PageResearchRow>(
      'SELECT * FROM page_research WHERE document_version_id = ? ORDER BY created_at DESC',
      versionId,
    )
  }

  getPageResearch(pageId: string): PageResearchRow | undefined {
    return this.db.get<PageResearchRow>('SELECT * FROM page_research WHERE page_id = ?', pageId)
  }

  getDocument(id: string): DocumentRow | undefined {
    return this.db.get<DocumentRow>('SELECT * FROM documents WHERE id = ?', id)
  }

  getVersion(id: string): VersionRow | undefined {
    return this.db.get<VersionRow>('SELECT * FROM document_versions WHERE id = ?', id)
  }

  getJob(id: string): JobRow | undefined {
    return this.db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id)
  }

  getJobByRequestId(requestId: string): JobRow | undefined {
    return this.db.get<JobRow>('SELECT * FROM jobs WHERE request_id = ?', requestId)
  }

  latestJob(versionId: string): JobRow | undefined {
    return this.db.get<JobRow>(
      'SELECT * FROM jobs WHERE document_version_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      versionId,
    )
  }

  updateJob(
    id: string,
    patch: {
      state?: JobState
      stage?: string
      completed?: number
      total?: number | null
      seq: number
      error_code?: string | null
      error_message?: string | null
      updated_at: string
    },
  ): JobRow {
    const current = this.getJob(id)
    if (!current) throw new Error(`missing job ${id}`)
    const next: JobRow = {
      ...current,
      state: patch.state ?? current.state,
      stage: patch.stage ?? current.stage,
      completed: patch.completed ?? current.completed,
      total: patch.total === undefined ? current.total : patch.total,
      seq: patch.seq,
      error_code: patch.error_code === undefined ? current.error_code : patch.error_code,
      error_message: patch.error_message === undefined ? current.error_message : patch.error_message,
      updated_at: patch.updated_at,
    }
    this.db.run(
      `UPDATE jobs SET state = ?, stage = ?, completed = ?, total = ?, seq = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`,
      next.state,
      next.stage,
      next.completed,
      next.total,
      next.seq,
      next.error_code,
      next.error_message,
      next.updated_at,
      id,
    )
    return next
  }

  setVersionStatus(id: string, status: string): void {
    this.db.run('UPDATE document_versions SET status = ? WHERE id = ?', status, id)
  }

  countDocuments(): number {
    const row = this.db.get<{ total: number }>('SELECT COUNT(*) AS total FROM documents')
    return Number(row?.total ?? 0)
  }

  listDocuments(offset: number, limit: number): ListJoinRow[] {
    return this.db.all<ListJoinRow>(
      `SELECT d.id AS document_id, d.display_name, d.created_at,
              v.id AS document_version_id, v.format, v.size_bytes, v.status, v.sha256,
              j.id AS job_id, j.state AS job_state, j.stage AS job_stage,
              j.completed AS job_completed, j.total AS job_total,
              j.error_code, j.error_message
       FROM documents d
       JOIN document_versions v ON v.id = (
         SELECT id FROM document_versions WHERE document_id = d.id ORDER BY created_at DESC LIMIT 1
       )
       LEFT JOIN jobs j ON j.id = (
         SELECT id FROM jobs WHERE document_version_id = v.id ORDER BY created_at DESC LIMIT 1
       )
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ? OFFSET ?`,
      limit,
      offset,
    )
  }

  listVersionsByStatus(status: string): VersionRow[] {
    return this.db.all<VersionRow>('SELECT * FROM document_versions WHERE status = ?', status)
  }

  countContent(versionId: string): { blocks: number; pages: number; needsReview: number } {
    const blocks = this.db.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM blocks WHERE document_version_id = ?',
      versionId,
    )
    const pages = this.db.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM pages WHERE document_version_id = ?',
      versionId,
    )
    const needs = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM issues WHERE document_version_id = ? AND review_state = 'needs_review'`,
      versionId,
    )
    return {
      blocks: Number(blocks?.total ?? 0),
      pages: Number(pages?.total ?? 0),
      needsReview: Number(needs?.total ?? 0),
    }
  }

  listIssues(versionId: string): IssueRow[] {
    return this.db.all<IssueRow>(
      'SELECT * FROM issues WHERE document_version_id = ? ORDER BY created_at ASC, id ASC',
      versionId,
    )
  }

  countPages(versionId: string): number {
    const row = this.db.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM pages WHERE document_version_id = ?',
      versionId,
    )
    return Number(row?.total ?? 0)
  }

  listPages(versionId: string, offset: number, limit: number): PageRow[] {
    return this.db.all<PageRow>(
      `SELECT p.*, (
         SELECT a.id FROM artifacts a WHERE a.page_id = p.id AND a.kind = 'page-image' LIMIT 1
       ) AS preview_resource_id
       FROM pages p
       WHERE p.document_version_id = ?
       ORDER BY p.ordinal ASC
       LIMIT ? OFFSET ?`,
      versionId,
      limit,
      offset,
    )
  }

  getPage(id: string): PageRow | undefined {
    return this.db.get<PageRow>('SELECT * FROM pages WHERE id = ?', id)
  }

  getPageByOrdinal(versionId: string, ordinal: number): PageRow | undefined {
    return this.db.get<PageRow>(
      'SELECT * FROM pages WHERE document_version_id = ? AND ordinal = ?',
      versionId,
      ordinal,
    )
  }

  countBlocksByPage(pageId: string): number {
    const row = this.db.get<{ total: number }>('SELECT COUNT(*) AS total FROM blocks WHERE page_id = ?', pageId)
    return Number(row?.total ?? 0)
  }

  listBlocksByPage(pageId: string, offset: number, limit: number): BlockRow[] {
    return this.db.all<BlockRow>(
      'SELECT * FROM blocks WHERE page_id = ? ORDER BY ordinal ASC LIMIT ? OFFSET ?',
      pageId,
      limit,
      offset,
    )
  }

  countUnpagedBlocks(versionId: string): number {
    const row = this.db.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM blocks WHERE document_version_id = ? AND page_id IS NULL',
      versionId,
    )
    return Number(row?.total ?? 0)
  }

  listUnpagedBlocks(versionId: string, offset: number, limit: number): BlockRow[] {
    return this.db.all<BlockRow>(
      `SELECT * FROM blocks WHERE document_version_id = ? AND page_id IS NULL
       ORDER BY ordinal ASC LIMIT ? OFFSET ?`,
      versionId,
      limit,
      offset,
    )
  }

  listBlockLocators(versionId: string): Array<Pick<BlockRow, 'id' | 'page_id' | 'ordinal' | 'locator_json'>> {
    return this.db.all(
      'SELECT id, page_id, ordinal, locator_json FROM blocks WHERE document_version_id = ? ORDER BY ordinal ASC',
      versionId,
    )
  }

  getArtifact(id: string): ArtifactRow | undefined {
    return this.db.get<ArtifactRow>('SELECT * FROM artifacts WHERE id = ?', id)
  }

  listArtifacts(versionId: string): ArtifactRow[] {
    return this.db.all<ArtifactRow>('SELECT * FROM artifacts WHERE document_version_id = ?', versionId)
  }

  artifactByKind(versionId: string, kind: string): ArtifactRow | undefined {
    return this.db.get<ArtifactRow>(
      'SELECT * FROM artifacts WHERE document_version_id = ? AND kind = ? LIMIT 1',
      versionId,
      kind,
    )
  }

  deleteParseOutput(versionId: string): void {
    this.db.run('DELETE FROM issues WHERE document_version_id = ?', versionId)
    this.db.run('DELETE FROM block_readings WHERE document_version_id = ?', versionId)
    this.db.run('DELETE FROM blocks WHERE document_version_id = ?', versionId)
    this.db.run('DELETE FROM artifacts WHERE document_version_id = ?', versionId)
    this.db.run('DELETE FROM pages WHERE document_version_id = ?', versionId)
  }

  listVersions(documentId: string): VersionRow[] {
    return this.db.all<VersionRow>(
      'SELECT * FROM document_versions WHERE document_id = ? ORDER BY created_at ASC',
      documentId,
    )
  }

  listJobIds(versionId: string): string[] {
    return this.db
      .all<{ id: string }>('SELECT id FROM jobs WHERE document_version_id = ?', versionId)
      .map((row) => row.id)
  }

  /** 删整份文稿：按外键顺序清掉派生数据，最后删版本与文稿本身，返回删掉的版本数。 */
  deleteDocument(documentId: string): number {
    const versions = this.listVersions(documentId)
    this.db.transaction(() => {
      for (const version of versions) {
        const versionId = version.id
        // jobs.retry_of 是指向 jobs 自己的外键：先摘掉再删，否则删父任务会撞约束。
        this.db.run('UPDATE jobs SET retry_of = NULL WHERE document_version_id = ?', versionId)
        this.db.run('DELETE FROM jobs WHERE document_version_id = ?', versionId)
        this.db.run('DELETE FROM issues WHERE document_version_id = ?', versionId)
        this.db.run('DELETE FROM block_readings WHERE document_version_id = ?', versionId)
        this.db.run('DELETE FROM blocks WHERE document_version_id = ?', versionId)
        this.db.run('DELETE FROM image_readings WHERE document_version_id = ?', versionId)
        this.db.run('DELETE FROM page_research WHERE document_version_id = ?', versionId)
        this.db.run('DELETE FROM artifacts WHERE document_version_id = ?', versionId)
        this.db.run('DELETE FROM pages WHERE document_version_id = ?', versionId)
        // 课程（及讲次/卡片/错题）与学习会话都有 CASCADE，删父行即可。
        this.db.run('DELETE FROM lectures WHERE document_version_id = ?', versionId)
        this.db.run('DELETE FROM study_sessions WHERE document_version_id = ?', versionId)
        this.db.run('DELETE FROM material_digests WHERE document_version_id = ?', versionId)
        this.db.run('DELETE FROM ai_usage WHERE document_version_id = ?', versionId)
        this.db.run('DELETE FROM document_versions WHERE id = ?', versionId)
      }
      this.db.run('DELETE FROM documents WHERE id = ?', documentId)
    })
    return versions.length
  }

  interruptInflight(now: string): JobRow[] {
    return this.db.transaction(() => {
      const rows = this.db.all<JobRow>(`SELECT * FROM jobs WHERE state IN ('queued', 'running')`)
      const updated: JobRow[] = []
      for (const row of rows) {
        updated.push(
          this.updateJob(row.id, {
            state: 'interrupted',
            stage: 'interrupted',
            seq: row.seq + 1,
            error_code: null,
            error_message: null,
            updated_at: now,
          }),
        )
      }
      return updated
    })
  }
}

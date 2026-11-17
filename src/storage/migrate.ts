import { nowIso } from '../domain/ids'
import { searchIndexText } from '../shared/search'
import { AppDatabase } from './database'

const BASE_SCHEMA = `
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  sha256 TEXT NOT NULL,
  format TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  original_relpath TEXT NOT NULL,
  status TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (format IN ('pptx','docx','pdf','txt','markdown','png','jpeg')),
  CHECK (status IN ('stored','parsing','ready','partial','failed'))
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  ordinal INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_number INTEGER NULL,
  image_relpath TEXT NULL,
  width INTEGER NULL,
  height INTEGER NULL,
  status TEXT NOT NULL,
  UNIQUE (document_version_id, ordinal),
  CHECK (status IN ('ready','needs_review','failed'))
);

CREATE TABLE blocks (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  page_id TEXT NULL REFERENCES pages(id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  extraction_method TEXT NOT NULL,
  review_state TEXT NOT NULL,
  CHECK (review_state IN ('unverified','needs_review','user_verified')),
  CHECK (kind IN ('paragraph','heading','code','slide_text','formula','image_region','page_text')),
  CHECK (extraction_method IN ('plain-text','markdown','docx-xml','pptx-xml','pdf-text','none'))
);

CREATE INDEX idx_blocks_version_ordinal ON blocks(document_version_id, ordinal);
CREATE INDEX idx_blocks_page_ordinal ON blocks(page_id, ordinal);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  page_id TEXT NULL REFERENCES pages(id),
  kind TEXT NOT NULL,
  relpath TEXT NOT NULL,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  page_id TEXT NULL REFERENCES pages(id),
  block_id TEXT NULL REFERENCES blocks(id),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  review_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (review_state IN ('unverified','needs_review','user_verified'))
);

CREATE INDEX idx_issues_version ON issues(document_version_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  request_id TEXT NOT NULL UNIQUE,
  retry_of TEXT NULL REFERENCES jobs(id),
  state TEXT NOT NULL,
  stage TEXT NOT NULL,
  completed INTEGER NOT NULL,
  total INTEGER NULL,
  seq INTEGER NOT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (state IN ('queued','running','succeeded','partial','failed','cancelled','interrupted'))
);

CREATE INDEX idx_jobs_version ON jobs(document_version_id);
`

const TEACHING_SCHEMA = `CREATE TABLE lectures (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  source_name TEXT NOT NULL,
  greeting TEXT NOT NULL,
  thesis TEXT NOT NULL,
  tonight TEXT NOT NULL,
  next_sitting TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  habit_stamp TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_lectures_version ON lectures(document_version_id);
CREATE INDEX idx_lectures_created ON lectures(created_at);

CREATE TABLE lecture_units (
  lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  source TEXT NOT NULL,
  teaching TEXT NOT NULL,
  pause TEXT NOT NULL,
  terms_json TEXT NOT NULL,
  pitfall TEXT NOT NULL,
  weight TEXT NOT NULL,
  example TEXT NOT NULL,
  PRIMARY KEY (lecture_id, id),
  UNIQUE (lecture_id, ordinal),
  CHECK (weight IN ('core','support'))
);

CREATE TABLE lecture_summaries (
  lecture_id TEXT PRIMARY KEY REFERENCES lectures(id) ON DELETE CASCADE,
  outline_json TEXT NOT NULL,
  must_know_json TEXT NOT NULL,
  pitfalls_json TEXT NOT NULL,
  mnemonic TEXT NOT NULL,
  recital TEXT NOT NULL
);

CREATE TABLE lecture_cards (
  lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  id TEXT NOT NULL,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  box INTEGER NOT NULL DEFAULT 0,
  due INTEGER NOT NULL,
  PRIMARY KEY (lecture_id, id),
  UNIQUE (lecture_id, ordinal)
);

CREATE TABLE lecture_quizzes (
  lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  choices_json TEXT NOT NULL,
  answer INTEGER NOT NULL,
  explain TEXT NOT NULL,
  PRIMARY KEY (lecture_id, id),
  UNIQUE (lecture_id, ordinal)
);

CREATE TABLE lecture_known (
  lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (lecture_id, unit_id)
);

CREATE TABLE misses (
  id TEXT PRIMARY KEY,
  lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  explain TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE INDEX idx_misses_at ON misses(at DESC);

CREATE TABLE habits (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  pace TEXT NOT NULL,
  style TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  window TEXT NOT NULL,
  avoid TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE day_marks (
  date TEXT PRIMARY KEY,
  known INTEGER NOT NULL DEFAULT 0,
  cards INTEGER NOT NULL DEFAULT 0,
  quizzes INTEGER NOT NULL DEFAULT 0
);
`

const IMAGE_SCHEMA = `
CREATE TABLE image_readings (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('ocr','vision')),
  text TEXT NOT NULL,
  engine TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (page_id, kind)
);

CREATE INDEX idx_image_readings_version ON image_readings(document_version_id);
`

const RESEARCH_SCHEMA = `
CREATE TABLE page_research (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  answer TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  engine TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (page_id)
);

CREATE INDEX idx_page_research_version ON page_research(document_version_id);
`

const STUDY_SCHEMA = `
CREATE TABLE study_sessions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  source_name TEXT NOT NULL,
  overview TEXT NOT NULL,
  outline_json TEXT NOT NULL,
  habits_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  material_chars INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ready','finished')),
  summary_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_study_sessions_created ON study_sessions(created_at DESC);
CREATE INDEX idx_study_sessions_version ON study_sessions(document_version_id);

CREATE TABLE study_units (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  key_points_json TEXT NOT NULL,
  segments_json TEXT NOT NULL,
  UNIQUE (session_id, ordinal)
);

CREATE INDEX idx_study_units_session ON study_units(session_id, ordinal);

CREATE TABLE study_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  unit_ordinal INTEGER NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_study_messages_session ON study_messages(session_id, created_at);
`

const COMPLETENESS_SCHEMA = `
CREATE TABLE block_readings (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('vision','ocr')),
  text TEXT NOT NULL,
  engine TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (block_id, kind)
);

CREATE INDEX idx_block_readings_version ON block_readings(document_version_id);

CREATE TABLE study_checks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  unit_ordinal INTEGER NOT NULL,
  segment_index INTEGER NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, unit_ordinal, segment_index)
);

CREATE INDEX idx_study_checks_session ON study_checks(session_id, unit_ordinal);
`

const CARD_NOTE_SCHEMA = `
ALTER TABLE lecture_cards ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_lecture_cards_suspended ON lecture_cards(suspended, due);

CREATE TABLE manual_cards (
  id TEXT PRIMARY KEY,
  front TEXT NOT NULL,
  back TEXT NOT NULL DEFAULT '',
  box INTEGER NOT NULL DEFAULT 0,
  due INTEGER NOT NULL,
  suspended INTEGER NOT NULL DEFAULT 0,
  last_graded_at TEXT NULL,
  document_version_id TEXT NULL,
  page_id TEXT NULL,
  quote TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_manual_cards_due ON manual_cards(suspended, due);
CREATE INDEX idx_manual_cards_version ON manual_cards(document_version_id);

CREATE TABLE highlights (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  page_id TEXT NULL,
  block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  quote TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'yellow',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_highlights_version ON highlights(document_version_id, created_at);
CREATE INDEX idx_highlights_block ON highlights(block_id, start_offset);

ALTER TABLE misses ADD COLUMN box INTEGER NOT NULL DEFAULT 0;
ALTER TABLE misses ADD COLUMN due INTEGER NOT NULL DEFAULT 0;
ALTER TABLE misses ADD COLUMN last_graded_at TEXT NULL;
CREATE INDEX idx_misses_due ON misses(due);
`

const SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE search_index USING fts5(
  document_version_id UNINDEXED,
  document_id UNINDEXED,
  page_id UNINDEXED,
  block_id UNINDEXED,
  page_number UNINDEXED,
  kind UNINDEXED,
  body UNINDEXED,
  text,
  tokenize='unicode61'
);
`

function backfillSearch(db: AppDatabase): void {
  // 测试里存在只补到 v1 极简 schema 的旧库；没有 blocks 就不索引，不能让迁移失败。
  const blocks = db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'blocks'")
  if (!blocks) return
  const rows = db.all<{
    document_version_id: string
    document_id: string
    page_id: string | null
    block_id: string
    page_number: number
    kind: string
    body: string
  }>(
    `SELECT b.document_version_id, v.document_id, b.page_id, b.id AS block_id,
            COALESCE(p.ordinal, 0) AS page_number, b.kind, b.text AS body
     FROM blocks b
     JOIN document_versions v ON v.id = b.document_version_id
     LEFT JOIN pages p ON p.id = b.page_id`,
  )
  for (const row of rows) {
    db.run(
      `INSERT INTO search_index(document_version_id, document_id, page_id, block_id, page_number, kind, body, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.document_version_id,
      row.document_id,
      row.page_id,
      row.block_id,
      row.page_number,
      row.kind,
      row.body,
      searchIndexText(row.body),
    )
  }
}

/** 恢复旧备份时用它判断备份 schema 是否比当前应用新。 */
export const CURRENT_SCHEMA_VERSION = 13

const COST_SCHEMA = `
CREATE TABLE material_digests (
  document_version_id TEXT PRIMARY KEY REFERENCES document_versions(id) ON DELETE CASCADE,
  material_sha TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  rendered_text TEXT NOT NULL,
  digests_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  document_version_id TEXT,
  kind TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_ai_usage_session ON ai_usage(session_id);
CREATE INDEX idx_ai_usage_version ON ai_usage(document_version_id);
`

const TEACHER_SCHEMA = `
CREATE TABLE teacher_persona (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT '老师',
  pronoun TEXT NOT NULL DEFAULT 'she',
  tone TEXT NOT NULL DEFAULT 'warm-rigorous',
  boundaries_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE learner_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  goal TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT '',
  subjects_json TEXT NOT NULL DEFAULT '[]',
  exam_date TEXT NULL,
  weekly_minutes INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE teacher_memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('goal','mastery','misconception','preference','strategy','constraint')),
  subject TEXT NOT NULL DEFAULT '',
  concept TEXT NOT NULL DEFAULT '',
  statement TEXT NOT NULL,
  evidence TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source_session_id TEXT NULL REFERENCES study_sessions(id) ON DELETE SET NULL,
  source_document_version_id TEXT NULL REFERENCES document_versions(id) ON DELETE SET NULL,
  user_confirmed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX idx_teacher_memory_status ON teacher_memory(status, updated_at DESC);
CREATE INDEX idx_teacher_memory_subject ON teacher_memory(subject, concept);

CREATE TABLE teacher_notes (
  session_id TEXT PRIMARY KEY REFERENCES study_sessions(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  worked_json TEXT NOT NULL DEFAULT '[]',
  stuck_json TEXT NOT NULL DEFAULT '[]',
  next_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

ALTER TABLE study_sessions ADD COLUMN teacher_snapshot_json TEXT NOT NULL DEFAULT '';
`

const STUDY_ARTIFACT_SCHEMA = `
CREATE TABLE study_artifacts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('summary','outline','search','quiz','teachback')),
  scope TEXT NOT NULL DEFAULT 'course',
  title TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, kind, scope)
);

CREATE INDEX idx_study_artifacts_session ON study_artifacts(session_id, updated_at DESC);
`

function hasVersion(db: AppDatabase, version: number): boolean {  return Boolean(db.get<{ version: number }>('SELECT version FROM schema_migrations WHERE version = ?', version))
}

export function migrate(db: AppDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`)
  if (!hasVersion(db, 1)) {
    db.transaction(() => {
      db.exec(BASE_SCHEMA)
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 1, nowIso())
    })
  }
  if (!hasVersion(db, 2)) {
    db.transaction(() => {
      db.exec(TEACHING_SCHEMA)
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 2, nowIso())
    })
  }
  if (!hasVersion(db, 3)) {
    db.transaction(() => {
      db.exec(IMAGE_SCHEMA)
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 3, nowIso())
    })
  }
  if (!hasVersion(db, 4)) {
    db.transaction(() => {
      db.exec(RESEARCH_SCHEMA)
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 4, nowIso())
    })
  }
  if (!hasVersion(db, 5)) {
    db.transaction(() => {
      db.exec(STUDY_SCHEMA)
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 5, nowIso())
    })
  }
  if (!hasVersion(db, 6)) {
    db.transaction(() => {
      db.exec(COMPLETENESS_SCHEMA)
      // 长课件不再截断，而是分段理解；这里记录实际分了几段，界面要如实显示。
      db.exec('ALTER TABLE study_sessions ADD COLUMN material_chunks INTEGER NOT NULL DEFAULT 1')
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 6, nowIso())
    })
  }
  if (!hasVersion(db, 7)) {
    db.transaction(() => {
      db.exec(COST_SCHEMA)
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 7, nowIso())
    })
  }
  if (!hasVersion(db, 8)) {
    db.transaction(() => {
      // 记录每张卡最后一次被评的时间，复习页据此算「今天已复习多少张」。
      db.exec('ALTER TABLE lecture_cards ADD COLUMN last_graded_at TEXT NULL')
      db.exec('CREATE INDEX idx_lecture_cards_graded ON lecture_cards(last_graded_at)')
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 8, nowIso())
    })
  }
  if (!hasVersion(db, 9)) {
    db.transaction(() => {
      // 卡片暂停、手动卡、划词高亮、错题重练的调度字段。
      db.exec(CARD_NOTE_SCHEMA)
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 9, nowIso())
    })
  }
  if (!hasVersion(db, 10)) {
    db.transaction(() => {
      // FTS5 只索引正文块；其他列带 UNINDEXED 作为跳转定位信息。
      db.exec(SEARCH_SCHEMA)
      backfillSearch(db)
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 10, nowIso())
    })
  }
  if (!hasVersion(db, 11)) {
    db.transaction(() => {
      // 0.7.0 老师地基：人格、学生档案、记忆、课堂手记；课堂快照记录当次老师。
      db.exec(TEACHER_SCHEMA)
      const at = nowIso()
      db.run(
        `INSERT INTO teacher_persona(id, name, pronoun, tone, boundaries_json, version, updated_at)
         VALUES (1, '老师', 'she', 'warm-rigorous', '[]', 1, ?)`,
        at,
      )
      db.run(
        `INSERT INTO learner_profile(id, goal, level, subjects_json, exam_date, weekly_minutes, notes, updated_at)
         VALUES (1, '', '', '[]', NULL, 0, '', ?)`,
        at,
      )
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 11, at)
    })
  }
  if (!hasVersion(db, 12)) {
    db.transaction(() => {
      // 0.7.1 老师工具：总结/大纲/查找/题测/复述都落在课程资料里，不另开页面。
      db.exec(STUDY_ARTIFACT_SCHEMA)
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 12, nowIso())
    })
  }
  if (!hasVersion(db, 13)) {
    db.transaction(() => {
      // 0.7.2 用量可对账：区分真实回报与估算，并把缓存命中/未命中、推理 token、模型名一起留下。
      db.exec('ALTER TABLE ai_usage ADD COLUMN cache_miss_tokens INTEGER NOT NULL DEFAULT 0')
      db.exec('ALTER TABLE ai_usage ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0')
      db.exec('ALTER TABLE ai_usage ADD COLUMN provider_reported INTEGER NOT NULL DEFAULT 1')
      db.exec('ALTER TABLE ai_usage ADD COLUMN model TEXT NOT NULL DEFAULT \'\'')
      // 老库没有这个标记：全 0 行本来就只可能来自“没回 usage”，其余行视为真实回报。
      db.exec(
        `UPDATE ai_usage SET provider_reported = 0
         WHERE prompt_tokens = 0 AND cached_tokens = 0 AND completion_tokens = 0`,
      )
      db.exec(
        `UPDATE ai_usage SET provider_reported = 1
         WHERE prompt_tokens > 0 OR cached_tokens > 0 OR completion_tokens > 0`,
      )
      // 老行没有单独记未命中：输入减去命中就是未命中，正好补上。
      db.exec('UPDATE ai_usage SET cache_miss_tokens = MAX(0, prompt_tokens - cached_tokens)')
      db.exec('CREATE INDEX idx_ai_usage_reported ON ai_usage(provider_reported)')
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', 13, nowIso())
    })
  }
}

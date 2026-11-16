import { nowIso } from '../domain/ids'
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
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './helpers/app'
import { Store } from '../src/storage/store'
import { TeachingService } from '../src/teaching/service'
import { TeacherService } from '../src/teaching/teacherService'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { SettingsStore } from '../src/providers/settings'
import { BudgetService } from '../src/ai/budget'
import { AiError } from '../src/ai/client'
import { splitMath } from '../src/shared/math'

const apps: Harness[] = []
const temps: string[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.cleanup()
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-060-'))
  temps.push(root)
  return root
}

function seedBlock(app: Harness, text: string) {
  const store = new Store(app.db)
  const docId = randomUUID()
  const versionId = randomUUID()
  const pageId = randomUUID()
  const blockId = randomUUID()
  store.insertDocument({ id: docId, display_name: '划线测试.pdf', created_at: '2026-11-16T10:00:00.000Z' })
  store.insertVersion({
    id: versionId,
    document_id: docId,
    sha256: 'c'.repeat(64),
    format: 'pdf',
    size_bytes: 1,
    original_relpath: `originals/${versionId}.pdf`,
    status: 'ready',
    parser_version: '9',
    created_at: '2026-11-16T10:00:00.000Z',
  })
  store.insertPage({
    id: pageId,
    document_version_id: versionId,
    ordinal: 1,
    source_kind: 'pdf',
    source_number: 1,
    image_relpath: null,
    width: null,
    height: null,
    status: 'ready',
  })
  store.insertBlock({
    id: blockId,
    document_version_id: versionId,
    page_id: pageId,
    ordinal: 1,
    kind: 'paragraph',
    text,
    locator_json: '{"kind":"pdf","pageNumber":1}',
    extraction_method: 'pdf-text',
    review_state: 'unverified',
  })
  return { docId, versionId, pageId, blockId, text }
}

describe('0.6.0 新功能', () => {
  it('划词高亮按 block 偏移生成，越界/空选会被拒绝，删除后列表同步', async () => {
    const app = await createHarness()
    apps.push(app)
    const block = seedBlock(app, '矩阵的特征值之和等于迹，特征值之积等于行列式。')
    const created = app.service.createHighlight({
      documentVersionId: block.versionId,
      pageId: block.pageId,
      blockId: block.blockId,
      startOffset: 0,
      endOffset: 5,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.quote).toBe('矩阵的特征')
    const list = app.service.highlights({ documentVersionId: block.versionId })
    expect(list.ok && list.data.items).toHaveLength(1)

    const bad = app.service.createHighlight({
      documentVersionId: block.versionId,
      blockId: block.blockId,
      startOffset: 0,
      endOffset: 999,
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_ARGUMENT')

    const deleted = app.service.deleteHighlight({ id: created.data.id })
    expect(deleted.ok && deleted.data.deleted).toBe(true)
    const empty = app.service.highlights({ documentVersionId: block.versionId })
    expect(empty.ok && empty.data.items).toHaveLength(0)
  })

  it('手动加卡、暂停、编辑与手动卡评分都走同一套队列', async () => {
    const app = await createHarness()
    apps.push(app)
    const teaching = new TeachingService({ db: app.db })
    const created = teaching.cardCreate({ front: '什么是特征值？', back: '矩阵作用在特征向量上只做伸缩。' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data.origin).toBe('manual')
    const due = teaching.dueCards()
    expect(due.ok).toBe(true)
    if (!due.ok) return
    expect(due.data.items.some((item) => item.origin === 'manual' && item.card.id === created.data.id)).toBe(true)

    const paused = teaching.cardEdit({ origin: 'manual', cardId: created.data.id, suspended: true })
    expect(paused.ok && paused.data.suspended).toBe(true)
    const afterPause = teaching.dueCards()
    expect(afterPause.ok && afterPause.data.items.some((item) => item.card.id === created.data.id)).toBe(false)

    const edited = teaching.cardEdit({ origin: 'manual', cardId: created.data.id, front: '特征值是什么？', suspended: false })
    expect(edited.ok && edited.data.front).toBe('特征值是什么？')
    const graded = teaching.gradeCard({ origin: 'manual', cardId: created.data.id, remembered: true })
    expect(graded.ok && graded.data.box).toBe(1)
  })

  it('错题重练按五箱走，答对升箱、答错回零', async () => {
    const app = await createHarness()
    apps.push(app)
    const block = seedBlock(app, '光合作用把光能转成化学能。')
    app.db.run(
      `INSERT INTO lectures(id, request_id, document_version_id, title, subject, source_name, greeting, thesis, tonight, next_sitting, raw_text, habit_stamp, created_at)
       VALUES ('l1', 'r1', ?, '光合作用', '生物', '测试', 'g', 't', 'n', 's', 'raw', 'h', '2026-11-16T10:00:00.000Z')`,
      block.versionId,
    )
    app.db.run(
      `INSERT INTO misses(id, lecture_id, prompt, explain, at, box, due, last_graded_at)
       VALUES ('m1', 'l1', '光合作用的场所？', '叶绿体。', 1, 0, 0, NULL)`,
    )
    const teaching = new TeachingService({ db: app.db, now: () => 1000 })
    const ok = teaching.gradeMiss({ missId: 'm1', remembered: true })
    expect(ok.ok && ok.data.box).toBe(1)
    const back = teaching.gradeMiss({ missId: 'm1', remembered: false })
    expect(back.ok && back.data.box).toBe(0)
  })

  it('预算按自然月累计输入+输出 token，到顶后硬拦截', () => {
    const root = tempRoot()
    const db = AppDatabase.open(path.join(root, 'library.sqlite'))
    migrate(db)
    const settings = new SettingsStore(path.join(root, 'settings.json'))
    settings.save({ libreOfficePath: null, ai: null, pinnedDocumentIds: [], budget: { monthlyTokens: 100, hardStop: true } })
    db.run(
      `INSERT INTO ai_usage(session_id, document_version_id, kind, prompt_tokens, cached_tokens, completion_tokens, created_at)
       VALUES (NULL, NULL, 'chat', 80, 0, 30, ?)`,
      new Date().toISOString(),
    )
    const budget = new BudgetService(db, settings)
    try {
      expect(budget.status().used).toBe(110)
      expect(budget.status().exceeded).toBe(true)
      expect(() => budget.beforeCall()).toThrow(AiError)
      expect(() => budget.beforeCall()).toThrow('本月 AI 用量已达 100 tokens 上限')
    } finally {
      db.close()
    }
  })

  it('恢复备份会替换整库、保留本机 settings、把旧库改名留作回滚', async () => {
    const source = await createHarness()
    apps.push(source)
    source.db.run(
      `INSERT INTO documents(id, display_name, created_at) VALUES ('doc-from-backup', '备份里的文稿.pdf', '2026-11-16T10:00:00.000Z')`,
    )
    source.db.run(
      `INSERT INTO document_versions(id, document_id, sha256, format, size_bytes, original_relpath, status, parser_version, created_at)
       VALUES ('version-from-backup', 'doc-from-backup', ?, 'pdf', 4, 'originals/backup.pdf', 'ready', 'test', '2026-11-16T10:00:00.000Z')`,
      'd'.repeat(64),
    )
    source.db.run(
      `INSERT INTO study_sessions(
        id, request_id, document_version_id, title, subject, source_name, overview, outline_json,
        habits_json, warnings_json, truncated, material_chars, material_chunks, status, summary_json,
        teacher_snapshot_json, created_at, updated_at
      ) VALUES ('session-from-backup', ?, 'version-from-backup', '备份课堂', '测试', '备份里的文稿.pdf', '总览', '[]',
        '{}', '[]', 0, 10, 1, 'ready', '', '', '2026-11-16T10:00:00.000Z', '2026-11-16T10:00:00.000Z')`,
      randomUUID(),
    )
    const sourceTeacher = new TeacherService({ db: source.db, now: () => Date.parse('2026-11-16T10:00:00.000Z') })
    sourceTeacher.savePersona({ name: '备份老师', pronoun: 'she', tone: 'warm-rigorous', boundaries: [] })
    sourceTeacher.saveProfile({
      goal: '备份目标', level: '备份水平', subjects: ['测试'], weeklyMinutes: 300, notes: '备份备注',
    })
    sourceTeacher.memorySave({
      kind: 'preference',
      subject: '测试',
      concept: '',
      statement: '这条记忆要跟着备份一起回来。',
      evidence: '备份测试',
      confidence: 0.9,
      sourceSessionId: 'session-from-backup',
      sourceDocumentVersionId: 'version-from-backup',
      userConfirmed: true,
    })
    sourceTeacher.saveNote('session-from-backup', {
      summary: '备份里的老师手记。',
      worked: ['备份成功'],
      stuck: [],
      next: ['恢复后继续上课'],
    })
    const backupPath = path.join(tempRoot(), 'backup')
    await source.service.writeBackup(backupPath)

    let restarted = false
    const destParent = tempRoot()
    const dest = await createHarness({
      backupDir: backupPath,
      restart: () => {
        restarted = true
      },
    })
    apps.push(dest)
    dest.db.run(
      `INSERT INTO documents(id, display_name, created_at) VALUES ('doc-current-only', '恢复后会消失.pdf', '2026-11-16T10:00:00.000Z')`,
    )
    const settingsFile = path.join(dest.root, 'settings.json')
    fs.writeFileSync(settingsFile, JSON.stringify({ pinnedDocumentIds: ['保留我'], ai: null }), 'utf8')

    const preview = await dest.service.inspectRestore('window-a')
    expect(preview.ok).toBe(true)
    if (!preview.ok) return
    expect(preview.data.counts.documents).toBe(1)
    const applied = await dest.service.applyRestore({ token: preview.data.token })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(restarted).toBe(true)
    expect(applied.data.previousPath).toBeTruthy()
    expect(fs.existsSync(applied.data.previousPath!)).toBe(true)

    const restored = AppDatabase.open(path.join(dest.root, 'library.sqlite'))
    try {
      expect(restored.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents')?.n).toBe(1)
      expect(restored.get<{ id: string }>("SELECT id FROM documents WHERE id = 'doc-from-backup'")?.id).toBe('doc-from-backup')
      const restoredTeacher = new TeacherService({ db: restored })
      const overview = restoredTeacher.overview()
      expect(overview.ok).toBe(true)
      if (overview.ok) {
        expect(overview.data.persona.name).toBe('备份老师')
        expect(overview.data.profile.goal).toBe('备份目标')
        expect(overview.data.memories.some((item) => item.statement.includes('跟着备份'))).toBe(true)
      }
      expect(restoredTeacher.noteForSession('session-from-backup')?.summary).toBe('备份里的老师手记。')
    } finally {
      restored.close()
    }
    expect(fs.readFileSync(settingsFile, 'utf8')).toContain('保留我')
    fs.rmSync(applied.data.previousPath!, { recursive: true, force: true })
    fs.rmSync(destParent, { recursive: true, force: true })
  })

  it('自动备份只在到期后生成，目录带产品标记且能按保留份数清理', async () => {
    const backupParent = tempRoot()
    const app = await createHarness({ backupDir: backupParent })
    apps.push(app)
    const settings = new SettingsStore(path.join(app.root, 'settings.json'))
    settings.save({
      libreOfficePath: null,
      ai: null,
      pinnedDocumentIds: [],
      backup: { enabled: true, directory: backupParent, keep: 1, lastAt: null },
    })
    const first = await app.service.autoBackup()
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data.skipped).toBe(false)
    expect(first.data.path).toBeTruthy()
    expect(fs.existsSync(path.join(first.data.path!, 'manifest.json'))).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(path.join(first.data.path!, 'manifest.json'), 'utf8')) as { product: string }
    expect(manifest.product).toBe('灯下')
    const second = await app.service.autoBackup()
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.skipped).toBe(true)
    expect(second.data.reason).toContain('24 小时')
  })

  it('恢复入口拒绝没有 manifest 的普通文件夹', async () => {
    const empty = tempRoot()
    const app = await createHarness({ backupDir: empty })
    apps.push(app)
    const picked = await app.service.inspectRestore('window-a')
    expect(picked.ok).toBe(false)
    if (!picked.ok) expect(picked.error.code).toBe('INVALID_ARGUMENT')
  })

  it('公式分段认四种定界符，未闭合和空公式保留原文', () => {
    expect(splitMath('设 $x^2$ 和 $$y$$')).toEqual([
      { kind: 'text', text: '设 ' },
      { kind: 'math', value: 'x^2', display: false },
      { kind: 'text', text: ' 和 ' },
      { kind: 'math', value: 'y', display: true },
    ])
    expect(splitMath('残留 $x+1')).toEqual([{ kind: 'text', text: '残留 $x+1' }])
    expect(splitMath('空 $$ $$ 保留')).toEqual([{ kind: 'text', text: '空 $$ $$ 保留' }])
    expect(splitMath('行内 \\(a+b\\)')).toEqual([
      { kind: 'text', text: '行内 ' },
      { kind: 'math', value: 'a+b', display: false },
    ])
  })
})

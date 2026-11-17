import { useEffect, useState } from 'react'
import type { TeacherMemory, TeacherMemoryKind, TeacherOverview } from '../../shared/teacher'

type Notify = (tone: 'info' | 'bad', text: string) => void

const KIND_LABEL: Record<TeacherMemoryKind, string> = {
  goal: '目标',
  mastery: '掌握',
  misconception: '易错',
  preference: '偏好',
  strategy: '方法',
  constraint: '限制',
}

const KIND_OPTIONS = Object.keys(KIND_LABEL) as TeacherMemoryKind[]

type Form = {
  name: string
  goal: string
  level: string
  subjects: string
  examDate: string
  weeklyMinutes: string
  notes: string
}

function formOf(overview: TeacherOverview): Form {
  return {
    name: overview.persona.name,
    goal: overview.profile.goal,
    level: overview.profile.level,
    subjects: overview.profile.subjects.join('、'),
    examDate: overview.profile.examDate ?? '',
    weeklyMinutes: overview.profile.weeklyMinutes ? String(overview.profile.weeklyMinutes) : '',
    notes: overview.profile.notes,
  }
}

/** 老师档案不是设置页里的一行配置，而是学生能看见、能改、能删的“她记得你什么”。 */
export function TeacherProfile({
  open,
  onClose,
  notify,
  onPersonaSaved,
}: {
  open: boolean
  onClose: () => void
  notify: Notify
  onPersonaSaved?: (name: string) => void
}) {
  const api = window.desk
  const [overview, setOverview] = useState<TeacherOverview | null>(null)
  const [form, setForm] = useState<Form>({ name: '老师', goal: '', level: '', subjects: '', examDate: '', weeklyMinutes: '', notes: '' })
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [kind, setKind] = useState<TeacherMemoryKind>('preference')
  const [concept, setConcept] = useState('')
  const [statement, setStatement] = useState('')
  const [confirmMemory, setConfirmMemory] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)

  async function refresh() {
    if (!api) return
    setLoading(true)
    const result = await api.teacher.overview()
    setLoading(false)
    if (!result.ok) {
      notify('bad', result.error.message)
      return
    }
    setOverview(result.data)
    setForm(formOf(result.data))
  }

  useEffect(() => {
    if (open) void refresh()
  }, [open])

  async function save() {
    if (!api) return
    const name = form.name.trim()
    if (!name) {
      notify('bad', '老师总得有个名字。')
      return
    }
    const weekly = form.weeklyMinutes.trim() ? Number(form.weeklyMinutes) : 0
    if (!Number.isInteger(weekly) || weekly < 0 || weekly > 10_080) {
      notify('bad', '每周时间请填 0 到 10080 之间的整数分钟。')
      return
    }
    setSaving(true)
    const persona = await api.teacher.savePersona({
      name,
      pronoun: overview?.persona.pronoun ?? 'she',
      tone: overview?.persona.tone ?? 'warm-rigorous',
      boundaries: overview?.persona.boundaries ?? [],
    })
    const profile = await api.teacher.saveProfile({
      goal: form.goal.trim(),
      level: form.level.trim(),
      subjects: form.subjects.split(/[、,，]/).map((item) => item.trim()).filter(Boolean).slice(0, 8),
      examDate: form.examDate.trim() || null,
      weeklyMinutes: weekly,
      notes: form.notes.trim(),
    })
    setSaving(false)
    if (!persona.ok) { notify('bad', persona.error.message); return }
    if (!profile.ok) { notify('bad', profile.error.message); return }
    setOverview((current) => current ? { ...current, persona: persona.data, profile: profile.data } : current)
    onPersonaSaved?.(persona.data.name)
    notify('info', '老师档案已保存，下一次开课会带着它。')
  }

  async function addMemory() {
    if (!api) return
    if (!statement.trim()) {
      notify('bad', '先写下她该记住什么。')
      return
    }
    const result = await api.teacher.saveMemory({
      kind,
      subject: '',
      concept: concept.trim(),
      statement: statement.trim(),
      evidence: '学生手动记下',
      confidence: 0.8,
      userConfirmed: true,
    })
    if (!result.ok) { notify('bad', result.error.message); return }
    setStatement('')
    setConcept('')
    setMemoryOpen(false)
    await refresh()
    notify('info', '这条记忆已写进老师档案。')
  }

  async function removeMemory(id: string) {
    if (!api) return
    if (confirmMemory !== id) {
      setConfirmMemory(id)
      return
    }
    const result = await api.teacher.deleteMemory({ id })
    if (!result.ok) { notify('bad', result.error.message); return }
    setConfirmMemory(null)
    if (editingId === id) setEditingId(null)
    await refresh()
    notify('info', '这条记忆已删除。')
  }

  async function confirmObservation(memory: TeacherMemory) {
    if (!api) return
    const result = await api.teacher.saveMemory({
      ...memory,
      statement: memory.statement,
      userConfirmed: true,
    })
    if (!result.ok) { notify('bad', result.error.message); return }
    await refresh()
    notify('info', '已确认，这条记忆会直接进入下一次课的提示词。')
  }

  async function saveMemoryEdit(memory: TeacherMemory) {
    if (!api) return
    const next = editingText.trim()
    if (!next) {
      notify('bad', '记忆内容不能为空。')
      return
    }
    const result = await api.teacher.saveMemory({
      ...memory,
      statement: next,
      userConfirmed: memory.userConfirmed,
    })
    if (!result.ok) { notify('bad', result.error.message); return }
    setEditingId(null)
    setEditingText('')
    await refresh()
    notify('info', '这条记忆已改写。')
  }

  async function reset() {
    if (!api) return
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    const result = await api.teacher.reset()
    if (!result.ok) { notify('bad', result.error.message); return }
    setConfirmReset(false)
    onPersonaSaved?.('老师')
    notify('info', '老师已回到默认人格，记忆和档案已清空。')
    await refresh()
  }

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal teacher-profile">
        <header>
          <div>
            <h2>老师档案</h2>
            <p className="quiet">同一个老师，跨学科记得你。改的是称呼和档案，不是换一个人。</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}>×</button>
        </header>

        {loading ? <p className="quiet">正在读取老师档案…</p> : null}
        {!loading && !overview ? <p className="quiet">还没有读到老师档案。</p> : null}

        {overview ? (
          <>
            <section className="teacher-profile-block">
              <h3>她是谁</h3>
              <label>
                <span>称呼</span>
                <input value={form.name} maxLength={24} placeholder="老师" onChange={(event) => setForm({ ...form, name: event.target.value })} />
              </label>
              <div className="teacher-profile-grid">
                <label>
                  <span>目标</span>
                  <input value={form.goal} maxLength={120} placeholder="比如：期末考试、CSP" onChange={(event) => setForm({ ...form, goal: event.target.value })} />
                </label>
                <label>
                  <span>水平</span>
                  <input value={form.level} maxLength={120} placeholder="比如：学过但忘、零基础" onChange={(event) => setForm({ ...form, level: event.target.value })} />
                </label>
              </div>
              <div className="teacher-profile-grid">
                <label>
                  <span>学科</span>
                  <input value={form.subjects} placeholder="线性代数、数据结构" onChange={(event) => setForm({ ...form, subjects: event.target.value })} />
                </label>
                <label>
                  <span>每周时间（分钟）</span>
                  <input value={form.weeklyMinutes} inputMode="numeric" placeholder="比如 420" onChange={(event) => setForm({ ...form, weeklyMinutes: event.target.value })} />
                </label>
              </div>
              <label>
                <span>考试日期（可空）</span>
                <input value={form.examDate} maxLength={10} placeholder="YYYY-MM-DD" onChange={(event) => setForm({ ...form, examDate: event.target.value })} />
              </label>
              <label>
                <span>她该注意什么</span>
                <textarea rows={2} value={form.notes} maxLength={1200} placeholder="比如：先给例子，再给定义；不要一次塞太多。" onChange={(event) => setForm({ ...form, notes: event.target.value })} />
              </label>
              <div className="teacher-profile-actions">
                <button className="primary" onClick={() => void save()} disabled={saving || !form.name.trim()}>
                  {saving ? '正在保存…' : '保存老师档案'}
                </button>
                <span className="quiet">保存后，下一次开课和追问会带着这些信息。</span>
              </div>
            </section>

            <section className="teacher-profile-block">
              <div className="teacher-profile-title">
                <div>
                  <h3>她记得你什么</h3>
                  <p className="quiet">已确认的记忆会直接进入老师提示词；不确定的会先写成“我观察到……”。</p>
                </div>
                <button className="ghost" onClick={() => setMemoryOpen((value) => !value)}>
                  {memoryOpen ? '收起' : '记一条'}
                </button>
              </div>

              {memoryOpen ? (
                <div className="teacher-memory-form">
                  <div className="teacher-profile-grid">
                    <label>
                      <span>类型</span>
                      <select value={kind} onChange={(event) => setKind(event.target.value as TeacherMemoryKind)}>
                        {KIND_OPTIONS.map((item) => <option key={item} value={item}>{KIND_LABEL[item]}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>概念（可空）</span>
                      <input value={concept} maxLength={80} placeholder="比如：特征值" onChange={(event) => setConcept(event.target.value)} />
                    </label>
                  </div>
                  <label>
                    <span>她该记住的一句话</span>
                    <textarea rows={2} value={statement} maxLength={400} placeholder="比如：我总是把特征值和特征向量说反。" onChange={(event) => setStatement(event.target.value)} />
                  </label>
                  <button className="primary" onClick={() => void addMemory()}>写进老师档案</button>
                </div>
              ) : null}

              {overview.memories.length === 0 ? (
                <p className="quiet">还没有记忆。上几次课、答几次“停一下”，她会开始记；你也可以手动记一条。</p>
              ) : (
                <div className="teacher-memories">
                  {overview.memories.map((memory) => (
                    <MemoryRow
                      key={memory.id}
                      memory={memory}
                      confirm={confirmMemory === memory.id}
                      editing={editingId === memory.id}
                      editText={editingText}
                      onEditChange={setEditingText}
                      onStartEdit={() => {
                        setEditingId(memory.id)
                        setEditingText(memory.statement)
                      }}
                      onCancelEdit={() => {
                        setEditingId(null)
                        setEditingText('')
                      }}
                      onSaveEdit={() => void saveMemoryEdit(memory)}
                      onConfirm={() => void confirmObservation(memory)}
                      onDelete={() => void removeMemory(memory.id)}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="teacher-profile-block teacher-danger">
              <div>
                <h3>重置老师</h3>
                <p className="quiet">清空记忆和学生档案，名字回到“老师”。课堂记录和老师手记不删。</p>
              </div>
              <button className="danger-text" onClick={() => void reset()}>
                {confirmReset ? '再点一次，确认重置' : '重置记忆与档案'}
              </button>
            </section>
          </>
        ) : null}
      </div>
    </div>
  )
}

function MemoryRow({
  memory,
  confirm,
  editing,
  editText,
  onEditChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onConfirm,
  onDelete,
}: {
  memory: TeacherMemory
  confirm: boolean
  editing: boolean
  editText: string
  onEditChange: (value: string) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  onConfirm: () => void
  onDelete: () => void
}) {
  const status = memory.userConfirmed ? '已确认' : '观察'
  return (
    <div className="teacher-memory">
      <div className="teacher-memory-head">
        <span className={`chip ${memory.userConfirmed ? 'confirmed' : ''}`}>{KIND_LABEL[memory.kind]} · {status}</span>
        <span className="quiet">{memory.subject || '全局'} · 置信度 {Math.round(memory.confidence * 100)}%</span>
        <div className="teacher-memory-actions">
          {!memory.userConfirmed ? (
            <button className="ghost teacher-memory-confirm" onClick={onConfirm}>确认</button>
          ) : null}
          <button className="ghost" onClick={onStartEdit}>改写</button>
          <button className="icon-btn danger-text" title="删除这条记忆" onClick={onDelete}>
            {confirm ? '确认删除' : '×'}
          </button>
        </div>
      </div>
      {editing ? (
        <div className="teacher-memory-edit">
          <textarea rows={2} maxLength={400} value={editText} onChange={(event) => onEditChange(event.target.value)} />
          <div className="teacher-memory-actions">
            <button className="primary" onClick={onSaveEdit} disabled={!editText.trim()}>保存</button>
            <button className="ghost" onClick={onCancelEdit}>取消</button>
          </div>
        </div>
      ) : (
        <p>{memory.statement}</p>
      )}
      {memory.evidence ? <small className="quiet">依据：{memory.evidence}</small> : null}
    </div>
  )
}

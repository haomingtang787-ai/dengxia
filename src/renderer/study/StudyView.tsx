import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentListItem } from '../../shared/contract'
import type { StudyCheck, StudyProgress, StudySessionDetail, StudySessionListItem, StudyUnit } from '../../shared/study'
import { MathText } from '../components/MathText'
import {
  AVOID_OPTIONS,
  DEFAULT_HABITS,
  MINUTE_OPTIONS,
  PACE_OPTIONS,
  STYLE_OPTIONS,
  type Habits,
} from '../../teaching/habits'

type Notify = (tone: 'info' | 'bad', text: string) => void
type Busy = 'create' | 'send' | 'finish' | 'load' | null

function newRequestId(): string {
  return crypto.randomUUID()
}

function minutesLabel(minutes: number): string {
  return `${minutes} 分钟`
}

function progressText(progress: StudyProgress | null): string {
  if (progress?.phase === 'vision') {
    return progress.total > 0
      ? `正在读懂课件里的图片页：已完成 ${progress.done}/${progress.total} 页（页面较多时读图并行 4 路）。`
      : '正在读懂课件里的图片页。'
  }
  if (progress?.phase === 'reading') {
    return progress.total > 0
      ? `正在逐段读懂整份课件：已完成 ${progress.done}/${progress.total} 段（三路并行），读完后马上拆课。这一步会调用你自己的模型 API。`
      : '正在按页切分这份长课件，准备逐段读懂。这一步会调用你自己的模型 API。'
  }
  if (progress?.phase === 'planning') {
    return '整份材料已读懂，正在按你的习惯设计课程、写逐句讲稿。模型输出较长，通常要一两分钟。'
  }
  return '正在完整接收整份材料：逐页取文字或让 AI 读图，再设计课程、写逐句讲稿。这一步会调用你自己的模型 API，请稍等。'
}

function habitSummary(habits: Habits): string {
  const pace = PACE_OPTIONS.find((item) => item.id === habits.pace)?.label ?? '适中'
  const style = STYLE_OPTIONS.find((item) => item.id === habits.style)?.label ?? '先比方'
  const avoid = AVOID_OPTIONS.find((item) => item.id === habits.avoid)?.label ?? '长段落'
  const name = habits.name.trim() ? `${habits.name.trim()}，` : ''
  return `${name}一次约 ${habits.minutes} 分钟；节奏${pace}、方式${style}；避开${avoid}。`
}

export function StudyView({
  notify,
  documents,
  selectedVersionId,
  onOpenDocs,
}: {
  notify: Notify
  documents: DocumentListItem[]
  selectedVersionId: string | null
  onOpenDocs: () => void
}) {
  const api = window.desk
  const [sessions, setSessions] = useState<StudySessionListItem[]>([])
  const [detail, setDetail] = useState<StudySessionDetail | null>(null)
  const [habits, setHabits] = useState<Habits>({ ...DEFAULT_HABITS })
  const [unitId, setUnitId] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [progress, setProgress] = useState<StudyProgress | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // 对话默认收起，把高度让给讲解正文；点标题栏再展开。窄窗里由右下角按钮展开抽屉。
  const [chatOpen, setChatOpen] = useState(false)
  // 侧边栏可收放：大纲、总览/总结都能收起，把宽度让给讲解正文。
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [sideOpen, setSideOpen] = useState(true)
  // 「管理」菜单：清对话 / 清总结 / 删课程，二次点击确认。
  const [manageOpen, setManageOpen] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'chat' | 'summary' | 'delete' | null>(null)
  const autoStarted = useRef('')
  // 三个滚动容器：讲稿区、消息区、当前讲次按钮，分别接管自己的滚动。
  const sheetScrollRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const outlineRef = useRef<HTMLDivElement | null>(null)

  // 新消息进来时贴到底部，老师回复完也滚一下，不用每次手动找。
  const messageCount = detail?.messages.length ?? 0
  useEffect(() => {
    const node = messagesRef.current
    if (!node) return
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
  }, [messageCount, busy, chatOpen])

  // 换一讲时讲稿回到开头，左侧把当前讲滚进视野。
  useEffect(() => {
    sheetScrollRef.current?.scrollTo({ top: 0 })
    const active = outlineRef.current?.querySelector('.study-unit.active')
    active?.scrollIntoView({ block: 'nearest' })
  }, [unitId])

  const selectedDoc = useMemo(
    () => documents.find((doc) => doc.documentVersionId === selectedVersionId) ?? documents[0] ?? null,
    [documents, selectedVersionId],
  )

  const open = useCallback(
    async (sessionId: string) => {
      if (!api) return
      const result = await api.study.get({ sessionId })
      if (!result.ok) {
        notify('bad', result.error.message)
        return
      }
      setDetail(result.data)
      setUnitId(result.data.units[0]?.id ?? null)
      setError('')
    },
    [api, notify],
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!api) return
      const [listResult, habitsResult] = await Promise.all([api.study.list(), api.teaching.habits.get()])
      if (!alive) return
      if (listResult.ok) {
        setSessions(listResult.data.items)
        const preferred = selectedVersionId
          ? listResult.data.items.find((item) => item.documentVersionId === selectedVersionId)
          : listResult.data.items[0]
        if (preferred) await open(preferred.sessionId)
      } else {
        notify('bad', listResult.error.message)
      }
      if (habitsResult.ok) setHabits(habitsResult.data)
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [api, notify, open, selectedVersionId])

  // 长课件读懂要几分钟：把「已读几段」直接显示出来，避免看起来像卡死。
  useEffect(() => {
    const off = api?.study.onProgress?.((next) => setProgress(next))
    return () => off?.()
  }, [api])

  const activeUnit = detail?.units.find((unit) => unit.id === unitId) ?? detail?.units[0] ?? null

  async function createCourse() {
    if (!api || !selectedDoc) {
      notify('bad', '先在左边选一份文稿，或者在「文稿」里上传课件。')
      return
    }
    setBusy('create')
    setError('')
    setProgress(null)
    const result = await api.study.create({
      requestId: newRequestId(),
      documentVersionId: selectedDoc.documentVersionId,
      title: selectedDoc.displayName,
    })
    if (!result.ok) {
      setError(result.error.message)
      notify('bad', result.error.message)
      setBusy(null)
      setProgress(null)
      return
    }
    setDetail(result.data)
    setUnitId(result.data.units[0]?.id ?? null)
    const refreshed = await api.study.list()
    if (refreshed.ok) setSessions(refreshed.data.items)
    notify('info', `AI 已读完 ${selectedDoc.displayName}，拆成 ${result.data.units.length} 讲。`)
    setBusy(null)
    setProgress(null)
  }

  // 用户明确要求上传后不要手动点：进入 AI 私教时，当前文稿还没有课堂就自动完整读懂并拆课。
  useEffect(() => {
    if (loading || detail || busy) return
    if (!selectedDoc) return
    if (sessions.some((item) => item.documentVersionId === selectedDoc.documentVersionId)) return
    if (autoStarted.current === selectedDoc.documentVersionId) return
    autoStarted.current = selectedDoc.documentVersionId
    void createCourse()
  }, [loading, detail, busy, selectedDoc, sessions])

  async function sendQuestion() {
    if (!api || !detail || busy) return
    const content = question.trim()
    if (!content) {
      setError('先写一句想问老师的话。')
      return
    }
    setBusy('send')
    setError('')
    const result = await api.study.send({
      sessionId: detail.sessionId,
      content,
      unitOrdinal: activeUnit?.ordinal ?? null,
    })
    if (!result.ok) {
      setError(result.error.message)
      setBusy(null)
      return
    }
    setDetail(result.data)
    setQuestion('')
    setBusy(null)
  }

  async function finishCourse() {
    if (!api || !detail || busy) return
    setBusy('finish')
    setError('')
    const result = await api.study.finish({ sessionId: detail.sessionId })
    if (!result.ok) {
      setError(result.error.message)
      setBusy(null)
      return
    }
    setDetail(result.data)
    setBusy(null)
    notify('info', '学习分析总结已生成。')
  }

  async function saveCheck(unitOrdinal: number, segmentIndex: number, answer: string): Promise<boolean> {
    if (!api || !detail) return false
    const result = await api.study.check({ sessionId: detail.sessionId, unitOrdinal, segmentIndex, answer })
    if (!result.ok) {
      setError(result.error.message)
      notify('bad', result.error.message)
      return false
    }
    setDetail(result.data)
    setError('')
    return true
  }

  async function patchHabits(patch: Partial<Habits>) {
    const next = { ...habits, ...patch }
    setHabits(next)
    if (!api) return
    const result = await api.teaching.habits.save(next)
    if (!result.ok) notify('bad', result.error.message)
  }

  async function clearChat() {
    if (!api || !detail) return
    const result = await api.study.clearChat({ sessionId: detail.sessionId })
    if (!result.ok) { notify('bad', result.error.message); return }
    setDetail(result.data)
    setManageOpen(false)
    setConfirmAction(null)
    notify('info', '对话记录已清除。')
  }

  async function clearSummary() {
    if (!api || !detail) return
    const result = await api.study.clearSummary({ sessionId: detail.sessionId })
    if (!result.ok) { notify('bad', result.error.message); return }
    setDetail(result.data)
    setManageOpen(false)
    setConfirmAction(null)
    notify('info', '学习总结已清除，可以重新生成。')
  }

  async function deleteCourse() {
    if (!api || !detail) return
    const docId = detail.documentVersionId
    const result = await api.study.delete({ sessionId: detail.sessionId })
    if (!result.ok) { notify('bad', result.error.message); return }
    setDetail(null)
    setUnitId(null)
    setManageOpen(false)
    setConfirmAction(null)
    autoStarted.current = docId
    setSessions(result.data.items)
    notify('info', '这门课已删除。')
  }

  if (loading) {
    return <div className="study-empty"><p className="quiet">正在读取你的课堂…</p></div>
  }

  return (
    <div className={`study${detail ? ' has-course' : ''}`}>
      <header className="study-head">
        <div>
          <span className="auto-pill">AI 私教</span>
          <h2>{detail ? detail.title : '把整份课件变成一门能对话的课'}</h2>
          <p className="quiet">
            {detail
              ? `材料：${detail.sourceName} · ${detail.units.length} 讲 · ${detail.messages.length} 条课堂记录${detail.materialChunks > 1 ? ` · 已分 ${detail.materialChunks} 段逐段读懂` : ''}${detail.checks.length ? ` · 已作答 ${detail.checks.length} 处` : ''}${detail.truncated ? ' · 材料超过 60 万字，只处理了前面部分' : ''}`
              : selectedDoc
                ? `当前选中：${selectedDoc.displayName}。一次创建会完整读取整份材料，再按你的习惯拆课。`
                : '还没有文稿。先去「文稿」上传课件。'}
          </p>
        </div>
        <div className="row study-actions">
          <button className="ghost" onClick={onOpenDocs}>文稿库</button>
          {detail ? (
            <div className="study-manage">
              <button className="ghost" onClick={() => { setManageOpen((open) => !open); setConfirmAction(null) }}>管理</button>
              {manageOpen ? (
                <div className="study-manage-menu">
                  <button onClick={() => (confirmAction === 'chat' ? void clearChat() : setConfirmAction('chat'))}>
                    {confirmAction === 'chat' ? '再点一次，清除全部对话' : '清除对话记录'}
                  </button>
                  <button onClick={() => (confirmAction === 'summary' ? void clearSummary() : setConfirmAction('summary'))}>
                    {confirmAction === 'summary' ? '再点一次，清除总结' : '清除学习总结'}
                  </button>
                  <button className="danger-text" onClick={() => (confirmAction === 'delete' ? void deleteCourse() : setConfirmAction('delete'))}>
                    {confirmAction === 'delete' ? '再点一次，删除这门课' : '删除这门课'}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <button className="primary" onClick={() => void createCourse()} disabled={busy !== null || !selectedDoc}>
            {busy === 'create' ? '正在完整读懂并拆课…' : detail ? '用当前文稿再开一门' : '完整读懂并拆课'}
          </button>
        </div>
      </header>

      {error ? <div className="banner bad">{error}</div> : null}
      {busy === 'create' ? (
        <div className="study-progress">
          <span className="pulse-dot" />
          <p>{progressText(progress)}</p>
        </div>
      ) : null}

      {!detail ? (
        <div className="study-intro">
          <section className="study-intro-main">
            <h3>这一次，不是“识别 + 一键摘要”</h3>
            <p>上传的课件会先被整份接住：文字、图片页、公式和图表说明一起读，作者、机构、版权、页眉页脚等非知识信息会被忽略。</p>
            <div className="study-steps">
              <div><b>01</b><span>完整读懂</span><small>整份材料的文字与图像理解一起进入课程设计，不是逐页孤立摘要。</small></div>
              <div><b>02</b><span>按习惯拆课</span><small>你希望讲透、先定义还是先提问，都会进入拆课和讲解提示。</small></div>
              <div><b>03</b><span>逐句讲</span><small>每一讲都有原文句子、老师讲解和讲完后的追问，不停在知识点标题。</small></div>
              <div><b>04</b><span>多轮对话</span><small>课堂里的每一句追问都会带着课程、本讲和最近对话一起发给你自己的 API。</small></div>
            </div>
          </section>
          <aside className="study-habits">
            <h3>你的学习习惯</h3>
            <p className="quiet">{habitSummary(habits)}</p>
            <label className="study-field">
              <span>称呼</span>
              <input value={habits.name} maxLength={16} placeholder="留空就用「你」" onChange={(event) => void patchHabits({ name: event.target.value })} />
            </label>
            <div className="habit-group">
              <span className="habit-label">节奏</span>
              <div className="habit-row">
                {PACE_OPTIONS.map((item) => (
                  <button key={item.id} className={`pill ${habits.pace === item.id ? 'active' : ''}`} onClick={() => void patchHabits({ pace: item.id })}>{item.label}</button>
                ))}
              </div>
            </div>
            <div className="habit-group">
              <span className="habit-label">讲解方式</span>
              <div className="habit-row">
                {STYLE_OPTIONS.map((item) => (
                  <button key={item.id} className={`pill ${habits.style === item.id ? 'active' : ''}`} onClick={() => void patchHabits({ style: item.id })}>{item.label}</button>
                ))}
              </div>
            </div>
            <div className="habit-group">
              <span className="habit-label">一坐时长</span>
              <div className="habit-row">
                {MINUTE_OPTIONS.map((item) => (
                  <button key={item.id} className={`pill ${habits.minutes === item.id ? 'active' : ''}`} onClick={() => void patchHabits({ minutes: item.id })}>{item.label}</button>
                ))}
              </div>
            </div>
            <div className="habit-group">
              <span className="habit-label">要避开</span>
              <div className="habit-row">
                {AVOID_OPTIONS.map((item) => (
                  <button key={item.id} className={`pill ${habits.avoid === item.id ? 'active' : ''}`} onClick={() => void patchHabits({ avoid: item.id })}>{item.label}</button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      ) : (
        <div className={`study-room${outlineOpen ? '' : ' outline-collapsed'}${sideOpen ? '' : ' side-collapsed'}`}>
          <aside className={`study-outline${outlineOpen ? '' : ' collapsed'}`} ref={outlineRef}>
            {outlineOpen ? (
              <>
                {sessions.length > 1 ? (
                  <label className="study-field">
                    <span>已开的课</span>
                    <select value={detail.sessionId} onChange={(event) => void open(event.target.value)}>
                      {sessions.map((item) => <option key={item.sessionId} value={item.sessionId}>{item.title}</option>)}
                    </select>
                  </label>
                ) : null}
                <div className="study-outline-title">
                  <h3>课程大纲</h3>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="chip">{detail.units.length} 讲</span>
                    <button className="icon-btn" title="收起大纲" onClick={() => setOutlineOpen(false)}>‹</button>
                  </div>
                </div>
                {detail.units.map((unit) => (
                  <button key={unit.id} className={`study-unit ${activeUnit?.id === unit.id ? 'active' : ''}`} onClick={() => setUnitId(unit.id)}>
                    <b>{String(unit.ordinal + 1).padStart(2, '0')}</b>
                    <span>{unit.title}<small>{unit.source} · {minutesLabel(unit.minutes)}</small></span>
                  </button>
                ))}
                {detail.warnings.length ? (
                  <div className="study-warnings">
                    <h4>读取提示</h4>
                    {detail.warnings.slice(0, 4).map((warning) => <p key={warning}>{warning}</p>)}
                  </div>
                ) : null}
              </>
            ) : (
              <button className="study-expand" title="展开大纲" onClick={() => setOutlineOpen(true)}>
                大纲<small>{detail.units.length}</small>
              </button>
            )}
          </aside>

          <main className="study-main">
            <div className="study-scroll" ref={sheetScrollRef}>
              {activeUnit ? (
                <UnitSheet
                  unit={activeUnit}
                  checks={detail.checks}
                  onSave={(segmentIndex, answer) => saveCheck(activeUnit.ordinal, segmentIndex, answer)}
                />
              ) : <p className="empty">这门课还没有小讲。</p>}
            </div>
            <section className={`study-chat${chatOpen ? ' open' : ''}`} aria-live="polite">
              <div className="study-chat-head" role="button" tabIndex={0} onClick={() => setChatOpen((open) => !open)}>
                <div>
                  <h3>课堂对话{chatOpen ? '' : ` · ${detail.messages.length}`}</h3>
                  <p className="quiet">问不懂、问为什么、让老师换个说法都行。每次追问都会带上这门课和本讲上下文。</p>
                </div>
                <span className="study-chat-head-toggle quiet">{chatOpen ? '收起 ▾' : '展开 ▴'}</span>
              </div>
              {chatOpen ? (
                <>
                  <div className="study-messages" ref={messagesRef}>
                    {detail.messages.map((message) => (
                      <div key={message.id} className={`study-message ${message.role}`}>
                        <span className="study-message-role">{message.role === 'user' ? '你' : '老师'}</span>
                        <p><MathText text={message.content} /></p>
                      </div>
                    ))}
                    {busy === 'send' ? <div className="study-message assistant pending"><span className="study-message-role">老师</span><p>正在结合本讲和整门课回答…</p></div> : null}
                  </div>
                  <div className="study-composer">
                    <textarea
                      value={question}
                      placeholder={activeUnit ? `就「${activeUnit.title}」问一句，比如：为什么这一步不能反过来？` : '问老师一句…'}
                      rows={3}
                      onChange={(event) => setQuestion(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void sendQuestion()
                      }}
                    />
                    <div className="study-composer-side">
                      <span className="quiet">Ctrl / Cmd + Enter 发送</span>
                      <button className="primary" onClick={() => void sendQuestion()} disabled={busy !== null || !question.trim()}>
                        {busy === 'send' ? '老师正在回答…' : '发送追问'}
                      </button>
                    </div>
                  </div>
                </>
              ) : null}
            </section>
          </main>

          <aside className={`study-side${sideOpen ? '' : ' collapsed'}`}>
            {sideOpen ? (
              <>
                <div className="study-side-bar">
                  <span className="quiet">总览与总结</span>
                  <button className="icon-btn" title="收起总览" onClick={() => setSideOpen(false)}>›</button>
                </div>
                <section className="study-overview">
                  <h3>整份材料总览</h3>
                  <p>{detail.overview}</p>
                  <div className="study-habit-stamp">
                    <span className="chip">本次习惯</span>
                    <p>{detail.habits.pace === 'slow' ? '讲透' : detail.habits.pace === 'exam' ? '抓考点' : '适中'} · {detail.habits.style === 'define' ? '先定义' : detail.habits.style === 'ask' ? '先提问' : '先比方'} · {detail.habits.minutes} 分钟</p>
                  </div>
                </section>
                <UsageCard usage={detail.usage} />
                <section className="study-summary">
                  <div className="study-outline-title">
                    <h3>学习分析总结</h3>
                    {detail.summary ? <span className="chip">已生成</span> : null}
                  </div>
                  {detail.summary ? (
                    <SummaryView detail={detail} />
                  ) : (
                    <>
                      <p className="quiet">上完几讲、追问几轮后，再让 AI 根据这次课堂记录写掌握、薄弱、易错和下一步。</p>
                      <button className="primary" onClick={() => void finishCourse()} disabled={busy !== null}>
                        {busy === 'finish' ? '正在分析这次学习…' : '生成学习分析总结'}
                      </button>
                    </>
                  )}
                </section>
              </>
            ) : (
              <button className="study-expand" title="展开总览与总结" onClick={() => setSideOpen(true)}>
                摘要<small>{detail.summary ? '已生成' : '未生成'}</small>
              </button>
            )}
          </aside>
          <button className="study-chat-toggle" onClick={() => setChatOpen((open) => !open)}>
            课堂对话 · {detail.messages.length}
          </button>
        </div>
      )}
    </div>
  )
}

function UnitSheet({
  unit,
  checks,
  onSave,
}: {
  unit: StudyUnit
  checks: StudyCheck[]
  onSave: (segmentIndex: number, answer: string) => Promise<boolean>
}) {
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState<number | null>(null)
  const savedFor = (index: number) =>
    checks.find((check) => check.unitOrdinal === unit.ordinal && check.segmentIndex === index) ?? null

  async function submit(index: number) {
    const answer = (drafts[index] ?? savedFor(index)?.answer ?? '').trim()
    if (!answer) return
    setSaving(index)
    const ok = await onSave(index, answer)
    setSaving(null)
    // 保存成功后清掉草稿，让输入框回落到已保存的答案，而不是变成一个空框。
    if (ok) {
      setDrafts((current) => {
        const next = { ...current }
        delete next[index]
        return next
      })
    }
  }

  return (
    <article className="study-unit-sheet">
      <header>
        <span className="study-unit-index">第 {unit.ordinal + 1} 讲</span>
        <h3>{unit.title}</h3>
        <p className="quiet">{unit.source} · {minutesLabel(unit.minutes)}</p>
      </header>
      {unit.keyPoints.length ? (
        <div className="study-keypoints">
          {unit.keyPoints.map((point) => <span key={point} className="chip">{point}</span>)}
        </div>
      ) : null}
      <div className="study-segments">
        {unit.segments.map((segment, index) => {
          const saved = savedFor(index)
          return (
            <section key={`${unit.id}-${index}`} className="study-segment">
              <blockquote>{segment.source}</blockquote>
              <p><MathText text={segment.explain} /></p>
              {segment.check ? (
                <div className="study-check">
                  <b>停一下</b>
                  <span><MathText text={segment.check} /></span>
                  <textarea
                    rows={2}
                    value={drafts[index] ?? saved?.answer ?? ''}
                    placeholder="用自己的话答一句。写下来，学习总结才有证据判断你掌握到哪里。"
                    onChange={(event) => setDrafts((current) => ({ ...current, [index]: event.target.value }))}
                  />
                  <div className="study-check-actions">
                    <button
                      className="ghost"
                      disabled={saving !== null}
                      onClick={() => void submit(index)}
                    >
                      {saving === index ? '正在记下…' : saved ? '改一下答案' : '记下我的答案'}
                    </button>
                    {saved ? <span className="quiet">已记录，会进入学习分析总结</span> : null}
                  </div>
                </div>
              ) : null}
            </section>
          )
        })}
      </div>
    </article>
  )
}

function tokenLabel(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/** 这门课真实花掉的 token 与缓存命中：让学生看到钱花在哪，也能确认缓存真的省了。 */
function UsageCard({ usage }: { usage: StudySessionDetail['usage'] }) {
  if (!usage || usage.calls === 0) return null
  const hit = usage.promptTokens > 0 ? Math.round((usage.cachedTokens / usage.promptTokens) * 100) : 0
  return (
    <section className="study-usage">
      <div className="study-outline-title">
        <h3>API 用量</h3>
        <span className="chip">{usage.calls} 次调用</span>
      </div>
      <p>
        输入 {tokenLabel(usage.promptTokens)} · 输出 {tokenLabel(usage.completionTokens)} tokens
      </p>
      <p className="study-usage-hit">
        前缀缓存命中 {tokenLabel(usage.cachedTokens)}（{hit}%）<span>{hit >= 40 ? '命中正常，追问越多次越便宜' : '命中偏低：多在同讲里追问、少切讲，命中率会上升'}</span>
      </p>
    </section>
  )
}

function SummaryView({ detail }: { detail: StudySessionDetail }) {  const summary = detail.summary
  if (!summary) return null
  return (
    <div className="study-summary-body">
      <p>{summary.overview}</p>
      {summary.mastered.length ? <SummaryGroup title="已经掌握" items={summary.mastered} /> : null}
      {summary.weak.length ? <SummaryGroup title="还要再讲" items={summary.weak} /> : null}
      {summary.pitfalls.length ? <SummaryGroup title="容易错" items={summary.pitfalls} /> : null}
      {summary.next.length ? <SummaryGroup title="下一步" items={summary.next} /> : null}
    </div>
  )
}

function SummaryGroup({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="study-summary-group">
      <h4>{title}</h4>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </div>
  )
}

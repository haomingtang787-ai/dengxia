import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HabitsView, LectureDetail, LectureListItem } from '../../shared/teaching'
import { firstSitting, sittingSentence, type PlanUnit } from '../../teaching/plan'
import {
  DEFAULT_HABITS,
  MINUTE_OPTIONS,
  PACE_OPTIONS,
  type Habits,
} from '../../teaching/habits'

type Notify = (tone: 'info' | 'bad', text: string) => void

export function ClassView({ notify, onOpenDocs }: { notify: Notify; onOpenDocs: () => void }) {
  const api = window.desk
  const [lectures, setLectures] = useState<LectureListItem[]>([])
  const [detail, setDetail] = useState<LectureDetail | null>(null)
  const [habits, setHabits] = useState<Habits>({ ...DEFAULT_HABITS })
  const [unitId, setUnitId] = useState<string | null>(null)
  const [slowTaps, setSlowTaps] = useState(0)
  const [paused, setPaused] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)
  const [quizResults, setQuizResults] = useState<Record<string, { correct: boolean; explain: string }>>({})
  const [quizBusy, setQuizBusy] = useState(false)

  const show = useCallback(
    async (lectureId: string) => {
      if (!api) return
      const result = await api.teaching.lectures.get({ lectureId })
      if (!result.ok) {
        notify('bad', result.error.message)
        return
      }
      const next = result.data
      const cursorUnit = next.units[next.cursor]
      const firstUnknown = next.units.find((unit) => !next.known.includes(unit.id))
      const pick = (cursorUnit && !next.known.includes(cursorUnit.id) ? cursorUnit : firstUnknown) ?? next.units[0] ?? null
      setDetail(next)
      setUnitId(pick?.id ?? null)
      setPaused(Boolean(pick?.pause))
      setQuizResults({})
      setNoteText('')
    },
    [api, notify],
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!api) return
      const [listResult, habitsResult] = await Promise.all([api.teaching.lectures.list(), api.teaching.habits.get()])
      if (!alive) return
      if (listResult.ok) {
        setLectures(listResult.data.items)
        if (listResult.data.items[0]) await show(listResult.data.items[0].lectureId)
      } else {
        notify('bad', listResult.error.message)
      }
      if (habitsResult.ok) setHabits(habitsResult.data)
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [api, notify, show])

  const planUnits: PlanUnit[] = useMemo(
    () =>
      detail
        ? detail.units.map((unit) => ({ id: unit.id, title: unit.title, minutes: unit.minutes, weight: unit.weight }))
        : [],
    [detail],
  )
  const sitting = detail ? firstSitting(planUnits, detail.known, habits.minutes, slowTaps) : []
  const allKnown = detail ? detail.units.length > 0 && detail.known.length === detail.units.length : false
  const sentence = detail ? sittingSentence(sitting, habits, slowTaps, allKnown) : ''
  const unit = detail ? detail.units.find((item) => item.id === unitId) ?? null : null
  const unitIndex = detail && unit ? detail.units.indexOf(unit) : -1

  async function patchHabits(patch: Partial<HabitsView>) {
    const next: Habits = { ...habits, ...patch }
    setHabits(next)
    if (!api) return
    const result = await api.teaching.habits.save(next)
    if (!result.ok) notify('bad', result.error.message)
  }

  async function select(id: string) {
    if (!detail || !api) return
    const index = detail.units.findIndex((item) => item.id === id)
    setUnitId(id)
    const picked = detail.units[index]
    setPaused(Boolean(picked?.pause))
    if (index >= 0) {
      const saved = await api.teaching.setCursor({ lectureId: detail.lectureId, cursor: index })
      if (!saved.ok) notify('bad', saved.error.message)
    }
  }

  function startSitting() {
    const first = sitting[0]
    if (first) void select(first.id)
    if (sitting.length === 0) notify('info', '这一页没有可上的小讲了。')
  }

  async function mark(known: boolean) {
    if (!api || !detail || !unit) return
    setBusy(true)
    const result = await api.teaching.markKnown({ lectureId: detail.lectureId, unitId: unit.id, known })
    setBusy(false)
    if (!result.ok) {
      notify('bad', result.error.message)
      return
    }
    setDetail({ ...detail, known: result.data.known, knownCount: result.data.known.length })
    if (!known) return
    const nextUnknown = detail.units.slice(unitIndex + 1).find((item) => !result.data.known.includes(item.id))
      ?? detail.units.find((item) => !result.data.known.includes(item.id))
    if (nextUnknown) void select(nextUnknown.id)
    else notify('info', '这一页的小讲都点过听懂了，可以留到复习里收。')
  }

  async function pauseHere() {
    if (!api || !detail || unitIndex < 0) return
    const result = await api.teaching.setCursor({ lectureId: detail.lectureId, cursor: unitIndex })
    if (!result.ok) notify('bad', result.error.message)
    else notify('info', '记在这一讲了，下次从这儿接着听。')
  }

  async function answer(quizId: string, choice: number) {
    if (!api || !detail || quizBusy) return
    setQuizBusy(true)
    const result = await api.teaching.answerQuiz({ lectureId: detail.lectureId, quizId, choice })
    setQuizBusy(false)
    if (!result.ok) {
      notify('bad', result.error.message)
      return
    }
    setQuizResults((current) => ({ ...current, [quizId]: { correct: result.data.correct, explain: result.data.explain } }))
    notify(result.data.correct ? 'info' : 'bad', result.data.correct ? '答对了。' : '答错了，已经进错题本。')
  }

  async function generateNote() {    if (!api || !detail) return
    setNoteBusy(true)
    const result = await api.teaching.note({ lectureId: detail.lectureId })
    setNoteBusy(false)
    if (!result.ok) {
      notify('bad', result.error.message)
      return
    }
    setNoteText(result.data.text)
  }

  if (loading) {
    return <article className="sheet"><p className="empty">正在读讲解…</p></article>
  }

  if (!detail) {
    return (
      <article className="sheet">
        <h3>还没有讲解</h3>
        <p className="quiet">回到文稿，选中一页，点「按这一页拆讲」。拆的是原文，不冒充老师的话；接上模型之后，同样的结构会由模型来写。</p>
        <div className="row">
          <button className="primary" onClick={onOpenDocs}>去文稿</button>
        </div>
      </article>
    )
  }

  return (
    <article className="sheet teaching">
      <header>
        <div>
          <h2>{detail.title}</h2>
          <div className="meta">
            <span className="chip">{detail.subject}</span>
            <span className="chip">共 {detail.unitCount} 讲</span>
            <span className={`chip ${detail.knownCount === detail.unitCount ? 'ok' : ''}`}>已听懂 {detail.knownCount}/{detail.unitCount}</span>
            <span>{detail.sourceName}</span>
          </div>
        </div>
      </header>

      {detail.greeting ? <p className="greeting">{detail.greeting}</p> : null}
      {detail.thesis ? <p className="quiet">这一页的主旨：{detail.thesis}</p> : null}

      {lectures.length > 1 ? (
        <div className="tabs">
          {lectures.map((item) => (
            <button
              key={item.lectureId}
              className={`tab ${detail.lectureId === item.lectureId ? 'active' : ''}`}
              onClick={() => void show(item.lectureId)}
            >
              {item.title}
            </button>
          ))}
        </div>
      ) : null}

      <section className="sitting">
        <p className="sitting-line">{sentence}</p>
        <div className="row">
          <button className="primary" onClick={startSitting} disabled={busy || sitting.length === 0}>从这一坐开始</button>
          <button className="ghost" onClick={() => { setSlowTaps((count) => count + 1); notify('info', slowTaps + 1 >= 2 ? '已经放慢：接下来每天只上一讲。' : '好，这一坐我再放慢一点。') }}>
            慢一点
          </button>
          {slowTaps > 0 ? <span className="quiet">已点 {slowTaps} 次慢一点</span> : null}
        </div>
      </section>

      <section className="habit-row">
        <span className="quiet">一坐时长</span>
        {MINUTE_OPTIONS.map((option) => (
          <button key={option.id} className={`pill ${habits.minutes === option.id ? 'active' : ''}`} onClick={() => void patchHabits({ minutes: option.id })}>
            {option.label}
          </button>
        ))}
        <span className="quiet">节奏</span>
        {PACE_OPTIONS.map((option) => (
          <button key={option.id} className={`pill ${habits.pace === option.id ? 'active' : ''}`} onClick={() => void patchHabits({ pace: option.id })}>
            {option.label}
          </button>
        ))}
      </section>

      <div className="unit-list">
        {detail.units.map((item, index) => {
          const known = detail.known.includes(item.id)
          return (
            <button key={item.id} className={`unit ${item.id === unitId ? 'active' : ''} ${known ? 'known' : ''}`} onClick={() => void select(item.id)}>
              <span className="unit-index">{index + 1}</span>
              <span className="unit-title">{item.title}</span>
              <span className="unit-meta">{known ? '已听懂' : `约 ${item.minutes} 分钟`}</span>
            </button>
          )
        })}
      </div>

      {unit ? (
        <section className="teach">
          <h3>第 {unitIndex + 1}/{detail.units.length} 小讲 · 约 {unit.minutes} 分钟</h3>
          {unit.source ? <p className="quiet">来源：{unit.source}</p> : null}
          {unit.pause && paused ? (
            <div className="cue">
              <p>停一下：{unit.pause}</p>
              <button className="ghost" onClick={() => setPaused(false)}>我想过了，继续听</button>
            </div>
          ) : (
            <>
              <div className="teach-body">
                {unit.teaching.split(/\n{2,}/).filter(Boolean).map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
              </div>
              {unit.terms.length ? (
                <div className="row">
                  {unit.terms.map((term) => (
                    <span key={term.word} className="chip" title={term.meaning}>{term.word}：{term.meaning}</span>
                  ))}
                </div>
              ) : null}
              {unit.pitfall ? <p className="warning">坑点：{unit.pitfall}</p> : null}
              {unit.example ? <p className="example">例子：{unit.example}</p> : null}
            </>
          )}
          <div className="row">
            <button className="primary" disabled={busy || detail.known.includes(unit.id)} onClick={() => void mark(true)}>听懂了，下一讲</button>
            <button className="ghost" disabled={busy} onClick={() => void pauseHere()}>暂停在这</button>
            {detail.known.includes(unit.id) ? <button className="ghost" disabled={busy} onClick={() => void mark(false)}>取消听懂</button> : null}
          </div>
        </section>
      ) : null}

      {detail.summary.outline.length > 0 ? (
        <section>
          <h3>这一页的大纲</h3>
          <div className="outline">
            {detail.summary.outline.map((line, index) => (
              <p key={index}>{line}</p>
            ))}
          </div>
        </section>
      ) : null}

      {detail.quizzes.length > 0 ? (
        <section>
          <h3>这一页的题</h3>
          <p className="quiet">选一个；答错会自己进复习里的错题本。</p>
          {detail.quizzes.map((quiz) => {
            const result = quizResults[quiz.id]
            return (
              <div key={quiz.id} className="quiz">
                <p className="quiz-prompt">{quiz.prompt}</p>
                <div className="row">
                  {quiz.choices.map((choice, index) => (
                    <button
                      key={choice}
                      className="pill"
                      disabled={quizBusy || Boolean(result)}
                      onClick={() => void answer(quiz.id, index)}
                    >
                      {choice}
                    </button>
                  ))}
                </div>
                {result ? (
                  <p className={result.correct ? 'quiet' : 'warning'}>
                    {result.correct ? '答对了。' : '答错了。'}
                    {result.explain}
                  </p>
                ) : null}
              </div>
            )
          })}
        </section>
      ) : null}

      <section>
        <h3>课后笔记</h3>
        <p className="quiet">只写已经发生的事：听懂几讲、哪些还没懂、错题和到点的卡片。可以全选复制走。</p>
        <div className="row">
          <button className="ghost" disabled={noteBusy} onClick={() => void generateNote()}>
            {noteText ? '重新生成' : '生成课后笔记'}
          </button>
        </div>
        {noteText ? <pre className="note-text">{noteText}</pre> : null}
      </section>
    </article>
  )
}

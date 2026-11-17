import { useCallback, useEffect, useState } from 'react'
import type { DayMarkView, DueCardItem, MissItem, ReviewSummary, TeachingCard } from '../../shared/teaching'
import type { ReviewSettingsView } from '../../shared/contract'
import { MathText } from '../components/MathText'

type Notify = (tone: 'info' | 'bad', text: string) => void

type CardEditor = {
  mode: 'edit' | 'create'
  origin: 'lecture' | 'manual'
  lectureId?: string
  cardId?: string
  front: string
  back: string
  suspended: boolean
}

export function ReviewView({
  notify,
  onExportCards,
  onExportMisses,
  onBack,
}: {
  notify: Notify
  onExportCards: () => void
  onExportMisses: () => void
  onBack: () => void
}) {
  const api = window.desk
  const [due, setDue] = useState<DueCardItem[]>([])
  const [misses, setMisses] = useState<MissItem[]>([])
  const [cards, setCards] = useState<TeachingCard[]>([])
  const [today, setToday] = useState<DayMarkView | null>(null)
  const [summary, setSummary] = useState<ReviewSummary | null>(null)
  const [settings, setSettings] = useState<ReviewSettingsView>({ cardsPerDay: 10, missesPerDay: 5, remind: true })
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [revealedMiss, setRevealedMiss] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<CardEditor | null>(null)
  const [editorBusy, setEditorBusy] = useState(false)
  const [cardsOpen, setCardsOpen] = useState(false)

  const refresh = useCallback(async () => {
    if (!api) return
    const [dueResult, missResult, todayResult, summaryResult, settingsResult, cardResult] = await Promise.all([
      api.teaching.dueCards(),
      api.teaching.misses({ limit: 40 }),
      api.teaching.today(),
      api.teaching.reviewSummary(),
      api.review.settings(),
      api.teaching.cards.list(),
    ])
    if (dueResult.ok) setDue(dueResult.data.items)
    else notify('bad', dueResult.error.message)
    if (missResult.ok) setMisses(missResult.data.items)
    if (todayResult.ok) setToday(todayResult.data)
    if (summaryResult.ok) setSummary(summaryResult.data)
    if (settingsResult.ok) setSettings(settingsResult.data)
    if (cardResult.ok) setCards(cardResult.data.items)
    setLoading(false)
  }, [api, notify])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 每天最多提醒一次；只在有到点卡（或错题超过目标）且目标没完成时提醒。
  useEffect(() => {
    if (!api || loading || !summary) return
    const now = new Date()
    const hour = now.getHours()
    if (hour < 9 || hour >= 22) return
    if (!settings.remind) return
    const behindCards = summary.due > 0 && summary.reviewedToday < settings.cardsPerDay
    const behindMisses = settings.missesPerDay > 0 && summary.misses >= settings.missesPerDay
    if (!behindCards && !behindMisses) return
    const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
    const storageKey = `dengxia-review-reminded-${dayKey}`
    if (localStorage.getItem(storageKey)) return
    localStorage.setItem(storageKey, '1')
    const body = behindCards
      ? `今天还有 ${summary.due} 张卡到点，已复习 ${summary.reviewedToday}/${settings.cardsPerDay} 张。`
      : `错题本还有 ${summary.misses} 道，今天的目标是 ${settings.missesPerDay} 道。`
    void api.app.notify({ title: '灯下 · 复习提醒', body })
  }, [api, loading, settings, summary])

  const current = due[0] ?? null
  const currentKey = current ? `${current.origin}|${current.lectureId ?? ''}|${current.card.id}` : ''
  const reviewed = summary?.reviewedToday ?? 0
  const goal = Math.max(1, settings.cardsPerDay)
  const goalPercent = Math.min(100, Math.round((reviewed / goal) * 100))

  async function grade(item: DueCardItem, remembered: boolean) {
    if (!api) return
    setBusy(true)
    const result = await api.teaching.gradeCard({
      origin: item.origin,
      lectureId: item.lectureId ?? undefined,
      cardId: item.card.id,
      remembered,
    })
    setBusy(false)
    if (!result.ok) {
      notify('bad', result.error.message)
      return
    }
    notify('info', remembered ? '这张先记下了，过些天再问。' : '忘了的这张，一分钟后再来一次。')
    setRevealed((state) => {
      const next = { ...state }
      delete next[currentKey]
      return next
    })
    await refresh()
  }

  async function gradeMiss(miss: MissItem, remembered: boolean) {
    if (!api) return
    setBusy(true)
    const result = await api.teaching.gradeMiss({ missId: miss.id, remembered })
    setBusy(false)
    if (!result.ok) {
      notify('bad', result.error.message)
      return
    }
    notify('info', remembered ? '这道错题往下一个箱走了。' : '这道错题回到第一箱，一分钟后还会来。')
    setRevealedMiss((state) => {
      const next = { ...state }
      delete next[miss.id]
      return next
    })
    await refresh()
  }

  async function toggleSuspend(card: TeachingCard) {
    if (!api) return
    setBusy(true)
    const result = await api.teaching.cards.edit({
      origin: card.origin,
      lectureId: card.origin === 'lecture' ? card.lectureId ?? undefined : undefined,
      cardId: card.id,
      suspended: !card.suspended,
    })
    setBusy(false)
    if (!result.ok) {
      notify('bad', result.error.message)
      return
    }
    notify('info', card.suspended ? '已恢复这张卡。' : '已暂停这张卡，不再进复习队列。')
    await refresh()
  }

  async function saveEditor() {
    if (!api || !editor) return
    const front = editor.front.trim()
    if (!front) {
      notify('bad', '卡正面不能为空。')
      return
    }
    setEditorBusy(true)
    const result = editor.mode === 'create'
      ? await api.teaching.cards.create({ front, back: editor.back.trim() })
      : await api.teaching.cards.edit({
          origin: editor.origin,
          lectureId: editor.origin === 'lecture' ? editor.lectureId : undefined,
          cardId: editor.cardId ?? '',
          front,
          back: editor.back.trim(),
          suspended: editor.suspended,
        })
    setEditorBusy(false)
    if (!result.ok) {
      notify('bad', result.error.message)
      return
    }
    setEditor(null)
    notify('info', editor.mode === 'create' ? '新卡片已加进复习队列。' : '卡片已保存。')
    await refresh()
  }

  function openEdit(card: TeachingCard) {
    setEditor({
      mode: 'edit',
      origin: card.origin,
      lectureId: card.origin === 'lecture' ? card.lectureId ?? undefined : undefined,
      cardId: card.id,
      front: card.front,
      back: card.back,
      suspended: card.suspended,
    })
  }

  return (
    <article className="sheet teaching">
      <header>
        <div>
          <div className="review-heading">
            <button className="ghost review-back" onClick={onBack}>← 回课堂</button>
            <h2>复习</h2>
          </div>
          <div className="meta">
            {today ? <span className="chip">今天 听懂 {today.known}</span> : null}
            {today ? <span className="chip">题 {today.quizzes}</span> : null}
            <span className="chip">{due.length} 张到点</span>
            <span className="chip">{misses.length} 道错题</span>
          </div>
        </div>
        <div className="row">
          <button className="primary" onClick={() => setEditor({ mode: 'create', origin: 'manual', front: '', back: '', suspended: false })}>新增卡片</button>
          <button className="ghost" onClick={onExportCards}>导出卡片</button>
          <button className="ghost" onClick={onExportMisses}>导出错题</button>
        </div>
      </header>

      <section className="review-goal">
        <div className="row goal-line">
          <span>今日卡片</span>
          <b>{reviewed} / {settings.cardsPerDay}</b>
        </div>
        <div className="goal-bar"><span style={{ width: `${goalPercent}%` }} /></div>
        <p className="quiet">
          每天 {settings.cardsPerDay} 张卡、{settings.missesPerDay} 道错题{settings.remind ? '，没做完会在本机提醒一次' : ''}。
          到点还有 {due.length} 张。
        </p>
      </section>

      {loading ? <p className="empty">正在看到点卡片…</p> : null}

      {!loading && !current ? (
        <p className="empty">没有到点的卡片。听完一页讲解、做过题，这里会按五箱间隔来找你。</p>
      ) : null}

      {current ? (
        <section className="review-card">
          <p className="quiet">
            {current.lectureTitle}
            {' · '}
            {current.origin === 'manual' ? '摘录/手动卡' : '拆课卡'}
            {current.card.suspended ? ' · 已暂停' : ''}
          </p>
          {current.card.quote ? <p className="card-quote">原文：{current.card.quote}</p> : null}
          <p className="card-face"><MathText text={current.card.front} /></p>
          {revealed[currentKey] ? (
            <>
              {current.card.back ? <p className="card-back"><MathText text={current.card.back} /></p> : <p className="quiet">这张卡没有背面，按记忆评一下就好。</p>}
              <div className="row">
                <button className="primary" disabled={busy} onClick={() => void grade(current, true)}>记得</button>
                <button className="ghost" disabled={busy} onClick={() => void grade(current, false)}>忘了</button>
                <button className="ghost" disabled={busy} onClick={() => void toggleSuspend(current.card)}>暂停这张</button>
                <button className="ghost" disabled={busy} onClick={() => openEdit(current.card)}>编辑</button>
              </div>
            </>
          ) : (
            <div className="row">
              <button className="primary" onClick={() => setRevealed((state) => ({ ...state, [currentKey]: true }))}>看答案</button>
              <button className="ghost" onClick={() => openEdit(current.card)}>编辑</button>
              <span className="quiet">还有 {due.length} 张</span>
            </div>
          )}
        </section>
      ) : null}

      <section>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h3>全部卡片 · {cards.length}</h3>
          <button className="link-btn" onClick={() => setCardsOpen((open) => !open)}>{cardsOpen ? '收起' : '展开管理'}</button>
        </div>
        {cardsOpen ? (
          <div className="card-list">
            {cards.length === 0 ? <p className="quiet">还没有卡片。听完课、摘录一段，或者自己新增一张。</p> : null}
            {cards.map((card) => (
              <div key={`${card.origin}-${card.id}`} className={`card-row ${card.suspended ? 'suspended' : ''}`}>
                <div>
                  <p className="card-row-front"><MathText text={card.front} /></p>
                  <span className="quiet">{card.origin === 'manual' ? '手动卡' : '拆课卡'} · 第 {card.box} 箱 · {card.suspended ? '已暂停' : new Date(card.due).toLocaleDateString('zh-CN')}</span>
                </div>
                <div className="row">
                  <button className="ghost" onClick={() => openEdit(card)}>编辑</button>
                  <button className="ghost" onClick={() => void toggleSuspend(card)}>{card.suspended ? '恢复' : '暂停'}</button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section>
        <h3>错题本</h3>
        {misses.length === 0 ? <p className="quiet">还没有错题。答错的题会自己进来。</p> : null}
        <div className="misses">
          {misses.map((miss) => (
            <div key={miss.id} className="miss">
              <p className="miss-prompt"><MathText text={miss.prompt} /></p>
              {revealedMiss[miss.id] ? (
                <>
                  {miss.explain ? <p className="quiet"><MathText text={miss.explain} /></p> : null}
                  <div className="row">
                    <button className="primary" disabled={busy} onClick={() => void gradeMiss(miss, true)}>这次记得</button>
                    <button className="ghost" disabled={busy} onClick={() => void gradeMiss(miss, false)}>又忘了</button>
                  </div>
                </>
              ) : (
                <div className="row">
                  <button className="ghost" onClick={() => setRevealedMiss((state) => ({ ...state, [miss.id]: true }))}>再练一次</button>
                  <span className="quiet">第 {miss.box} 箱{miss.lastGradedAt ? ` · 上次 ${new Date(miss.lastGradedAt).toLocaleDateString('zh-CN')}` : ''}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {editor ? (
        <div className="modal-overlay" onClick={() => setEditor(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>{editor.mode === 'create' ? '新增卡片' : '编辑卡片'}</h2>
              <button className="icon-btn" onClick={() => setEditor(null)}>×</button>
            </header>
            <label>
              正面（问题）
              <input
                value={editor.front}
                maxLength={500}
                autoFocus
                onChange={(event) => setEditor((current) => (current ? { ...current, front: event.target.value } : current))}
              />
            </label>
            <label>
              背面（答案，可留空）
              <textarea
                value={editor.back}
                maxLength={1000}
                rows={4}
                onChange={(event) => setEditor((current) => (current ? { ...current, back: event.target.value } : current))}
              />
            </label>
            {editor.mode === 'edit' ? (
              <label className="goal-check">
                <input
                  type="checkbox"
                  checked={editor.suspended}
                  onChange={(event) => setEditor((current) => (current ? { ...current, suspended: event.target.checked } : current))}
                />
                暂停这张卡（不删内容，只是不再进复习队列）
              </label>
            ) : null}
            <div className="row">
              <button className="primary" disabled={editorBusy} onClick={() => void saveEditor()}>{editorBusy ? '保存中…' : '保存'}</button>
              <button className="ghost" onClick={() => setEditor(null)}>取消</button>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  )
}

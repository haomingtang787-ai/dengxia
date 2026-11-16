import { useCallback, useEffect, useState } from 'react'
import type { DayMarkView, DueCardItem, MissItem, ReviewSummary } from '../../shared/teaching'
import type { ReviewSettingsView } from '../../shared/contract'

type Notify = (tone: 'info' | 'bad', text: string) => void

export function ReviewView({
  notify,
  onExportCards,
  onExportMisses,
}: {
  notify: Notify
  onExportCards: () => void
  onExportMisses: () => void
}) {
  const api = window.desk
  const [due, setDue] = useState<DueCardItem[]>([])
  const [misses, setMisses] = useState<MissItem[]>([])
  const [today, setToday] = useState<DayMarkView | null>(null)
  const [summary, setSummary] = useState<ReviewSummary | null>(null)
  const [settings, setSettings] = useState<ReviewSettingsView>({ cardsPerDay: 10, missesPerDay: 5, remind: true })
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!api) return
    const [dueResult, missResult, todayResult, summaryResult, settingsResult] = await Promise.all([
      api.teaching.dueCards(),
      api.teaching.misses({ limit: 20 }),
      api.teaching.today(),
      api.teaching.reviewSummary(),
      api.review.settings(),
    ])
    if (dueResult.ok) setDue(dueResult.data.items)
    else notify('bad', dueResult.error.message)
    if (missResult.ok) setMisses(missResult.data.items)
    if (todayResult.ok) setToday(todayResult.data)
    if (summaryResult.ok) setSummary(summaryResult.data)
    if (settingsResult.ok) setSettings(settingsResult.data)
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

  async function grade(item: DueCardItem, remembered: boolean) {
    if (!api) return
    setBusy(true)
    const result = await api.teaching.gradeCard({ lectureId: item.lectureId, cardId: item.card.id, remembered })
    setBusy(false)
    if (!result.ok) {
      notify('bad', result.error.message)
      return
    }
    notify('info', remembered ? '这张先记下了，过些天再问。' : '忘了的这张，一分钟后再来一次。')
    setRevealed((current) => {
      const next = { ...current }
      delete next[`${item.lectureId}|${item.card.id}`]
      return next
    })
    await refresh()
  }

  const current = due[0] ?? null
  const currentKey = current ? `${current.lectureId}|${current.card.id}` : ''
  const reviewed = summary?.reviewedToday ?? 0
  const goal = Math.max(1, settings.cardsPerDay)
  const goalPercent = Math.min(100, Math.round((reviewed / goal) * 100))

  return (
    <article className="sheet teaching">
      <header>
        <div>
          <h2>复习</h2>
          <div className="meta">
            {today ? <span className="chip">今天 听懂 {today.known}</span> : null}
            {today ? <span className="chip">题 {today.quizzes}</span> : null}
            <span className="chip">{due.length} 张到点</span>
            <span className="chip">{misses.length} 道错题</span>
          </div>
        </div>
        <div className="row">
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
          <p className="quiet">{current.lectureTitle}</p>
          <p className="card-face">{current.card.front}</p>
          {revealed[currentKey] ? (
            <>
              <p className="card-back">{current.card.back}</p>
              <div className="row">
                <button className="primary" disabled={busy} onClick={() => void grade(current, true)}>记得</button>
                <button className="ghost" disabled={busy} onClick={() => void grade(current, false)}>忘了</button>
              </div>
            </>
          ) : (
            <div className="row">
              <button className="primary" onClick={() => setRevealed((state) => ({ ...state, [currentKey]: true }))}>看答案</button>
              <span className="quiet">还有 {due.length} 张</span>
            </div>
          )}
        </section>
      ) : null}

      <section>
        <h3>错题本</h3>
        {misses.length === 0 ? <p className="quiet">还没有错题。答错的题会自己进来。</p> : null}
        <div className="misses">
          {misses.map((miss) => (
            <div key={miss.id} className="miss">
              <p className="miss-prompt">{miss.prompt}</p>
              {miss.explain ? <p className="quiet">{miss.explain}</p> : null}
            </div>
          ))}
        </div>
      </section>
    </article>
  )
}

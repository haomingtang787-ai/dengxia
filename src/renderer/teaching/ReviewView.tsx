import { useCallback, useEffect, useState } from 'react'
import type { DayMarkView, DueCardItem, MissItem } from '../../shared/teaching'

type Notify = (tone: 'info' | 'bad', text: string) => void

export function ReviewView({ notify }: { notify: Notify }) {
  const api = window.desk
  const [due, setDue] = useState<DueCardItem[]>([])
  const [misses, setMisses] = useState<MissItem[]>([])
  const [today, setToday] = useState<DayMarkView | null>(null)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!api) return
    const [dueResult, missResult, todayResult] = await Promise.all([
      api.teaching.dueCards(),
      api.teaching.misses({ limit: 20 }),
      api.teaching.today(),
    ])
    if (dueResult.ok) setDue(dueResult.data.items)
    else notify('bad', dueResult.error.message)
    if (missResult.ok) setMisses(missResult.data.items)
    if (todayResult.ok) setToday(todayResult.data)
    setLoading(false)
  }, [api, notify])

  useEffect(() => {
    void refresh()
  }, [refresh])

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

  return (
    <article className="sheet teaching">
      <header>
        <div>
          <h2>复习</h2>
          <div className="meta">
            {today ? <span className="chip">今天 听懂 {today.known}</span> : null}
            {today ? <span className="chip">卡片 {today.cards}</span> : null}
            {today ? <span className="chip">题 {today.quizzes}</span> : null}
            <span className="chip">{due.length} 张到点</span>
            <span className="chip">{misses.length} 道错题</span>
          </div>
        </div>
      </header>

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

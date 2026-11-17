import { useEffect, useMemo, useRef, useState } from 'react'
import type { StudyArtifact, StudyQuizAnswer, StudySessionDetail, StudyToolKind } from '../../shared/study'

type ToolPayload = { query?: string; answer?: string; answers?: StudyQuizAnswer[] }

export function StudyTools({
  detail,
  unitOrdinal,
  focus,
  busy,
  onFocus,
  onRun,
}: {
  detail: StudySessionDetail
  unitOrdinal: number | null
  focus: StudyToolKind | null
  busy: string | null
  onFocus: (tool: StudyToolKind | null) => void
  onRun: (tool: StudyToolKind, payload?: ToolPayload) => Promise<boolean>
}) {
  const [query, setQuery] = useState('')
  const [teachback, setTeachback] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [localError, setLocalError] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)
  const teachbackRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (focus === 'search') window.setTimeout(() => searchRef.current?.focus(), 80)
    if (focus === 'teachback') window.setTimeout(() => teachbackRef.current?.focus(), 80)
  }, [focus])

  const artifacts = useMemo(() => {
    const byKind = new Map<string, StudyArtifact>()
    for (const artifact of detail.artifacts ?? []) {
      const key = `${artifact.kind}:${artifact.scope}`
      if (!byKind.has(key)) byKind.set(key, artifact)
    }
    return [...byKind.values()]
  }, [detail.artifacts])

  const latest = (kind: StudyArtifact['kind'], scope?: string) => {
    const pool = artifacts.filter((artifact) => artifact.kind === kind && (scope == null || artifact.scope === scope))
    return pool.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  }

  const currentScope = unitOrdinal == null ? 'course' : `unit:${unitOrdinal}`
  const summary = latest('summary', currentScope) ?? latest('summary')
  const outline = latest('outline', currentScope) ?? latest('outline')
  const search = latest('search')
  const quiz = latest('quiz', currentScope) ?? latest('quiz')
  const teachbackArtifact = latest('teachback', currentScope) ?? latest('teachback')
  const blocked = busy !== null

  async function submitQuiz() {
    const questions = quiz?.body.questions ?? []
    const filled = questions.map((question) => ({
      questionId: question.id,
      answer: (answers[question.id] ?? '').trim(),
    }))
    if (filled.some((item) => !item.answer)) {
      setLocalError('每道题都写一句再交给老师。')
      return
    }
    setLocalError('')
    const ok = await onRun('quiz-grade', { answers: filled })
    if (ok) setAnswers({})
  }

  return (
    <section className="study-tools">
      <div className="study-tools-head">
        <div>
          <h3>老师工具</h3>
          <p>可以直接点，也可以直接在对话框里说“总结这一讲”“考考我”；右栏不重复放按钮墙。</p>
        </div>
        <span className="chip">{detail.artifacts?.length ?? 0} 份生成物</span>
      </div>

      <div className="study-tool-actions">
        <button className="ghost" disabled={blocked} onClick={() => { onFocus('summary'); void onRun('summary') }}>总结这一讲</button>
        <button className="ghost" disabled={blocked} onClick={() => { onFocus('quiz'); void onRun('quiz') }}>考考我这讲</button>
        <button className="ghost" disabled={blocked} onClick={() => { onFocus('outline'); void onRun('outline') }}>列复习大纲</button>
        <button className="ghost" disabled={blocked} onClick={() => onFocus('search')}>找原文</button>
        <button className="ghost" disabled={blocked} onClick={() => onFocus('teachback')}>我讲给你听</button>
      </div>

      {focus === 'search' ? (
        <div className="study-tool-input">
          <label className="study-field">
            <span>查这门课里的原文</span>
            <input
              ref={searchRef}
              value={query}
              maxLength={80}
              placeholder="比如：DRAM 为什么刷新 / 存储矩阵"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && query.trim()) { setLocalError(''); void onRun('search', { query: query.trim() }) } }}
            />
          </label>
          <button className="primary" disabled={blocked || !query.trim()} onClick={() => { setLocalError(''); void onRun('search', { query: query.trim() }) }}>
            {busy === 'tool' ? '正在查…' : '找原文'}
          </button>
        </div>
      ) : null}

      {focus === 'teachback' ? (
        <div className="study-tool-input">
          <label className="study-field">
            <span>用你自己的话讲一遍，老师按原文找缺口</span>
            <textarea
              ref={teachbackRef}
              rows={4}
              value={teachback}
              maxLength={2000}
              placeholder="别照着讲稿念；讲清因果、对比和例子。"
              onChange={(event) => setTeachback(event.target.value)}
            />
          </label>
          <button className="primary" disabled={blocked || teachback.trim().length < 20} onClick={() => { setLocalError(''); void onRun('teachback', { answer: teachback.trim() }).then((ok) => { if (ok) setTeachback('') }) }}>
            {busy === 'tool' ? '老师在听…' : '交给老师看'}
          </button>
          {teachback.trim().length > 0 && teachback.trim().length < 20 ? <p className="quiet">再写长一点，至少 20 个字。</p> : null}
        </div>
      ) : null}

      {localError ? <div className="banner bad">{localError}</div> : null}

      <div className="study-tool-artifacts">
        {summary ? <SummaryArtifact artifact={summary} /> : null}
        {outline ? <OutlineArtifact artifact={outline} /> : null}
        {search ? <SearchArtifact artifact={search} /> : null}
        {quiz ? <QuizArtifact artifact={quiz} answers={answers} setAnswers={setAnswers} onSubmit={submitQuiz} blocked={blocked} /> : null}
        {teachbackArtifact ? <TeachbackArtifact artifact={teachbackArtifact} /> : null}
        {!summary && !outline && !search && !quiz && !teachbackArtifact ? (
          <p className="empty">还没有生成物。点“考考我”或“总结这一讲”，结果会落在课程资料里。</p>
        ) : null}
      </div>
    </section>
  )
}

function ArtifactHead({ artifact, chip }: { artifact: StudyArtifact; chip: string }) {
  return (
    <div className="study-outline-title">
      <h3>{artifact.title}</h3>
      <span className="chip">{chip}</span>
    </div>
  )
}

function SummaryArtifact({ artifact }: { artifact: StudyArtifact }) {
  return (
    <section className="study-tool-card">
      <ArtifactHead artifact={artifact} chip="总结" />
      <p>{artifact.body.text}</p>
      {artifact.body.citations?.length ? (
        <div className="study-tool-citations">
          {artifact.body.citations.slice(0, 4).map((citation) => (
            <span key={`${citation.unitOrdinal}-${citation.segmentIndex}`} className="chip">
              第 {citation.unitOrdinal + 1} 讲 · {citation.source.slice(0, 28)}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function OutlineArtifact({ artifact }: { artifact: StudyArtifact }) {
  return (
    <section className="study-tool-card">
      <ArtifactHead artifact={artifact} chip="大纲" />
      <div className="study-tool-outline">
        {(artifact.body.items ?? []).map((item) => (
          <div key={`${item.title}-${item.source}`}>
            <b>{item.title}</b>
            <small>{item.source}</small>
            {item.points.length ? <p>{item.points.join(' · ')}</p> : null}
          </div>
        ))}
      </div>
    </section>
  )
}

function SearchArtifact({ artifact }: { artifact: StudyArtifact }) {
  const matches = artifact.body.matches ?? []
  return (
    <section className="study-tool-card">
      <ArtifactHead artifact={artifact} chip={`${matches.length} 处`} />
      <p className="quiet">{artifact.body.message}</p>
      {matches.map((match) => (
        <blockquote key={`${match.unitOrdinal}-${match.segmentIndex}`} className="study-tool-match">
          <span>第 {match.unitOrdinal + 1} 讲 · {match.unitTitle} · 第 {match.segmentIndex + 1} 句</span>
          <p>{match.excerpt}</p>
        </blockquote>
      ))}
    </section>
  )
}

function QuizArtifact({
  artifact,
  answers,
  setAnswers,
  onSubmit,
  blocked,
}: {
  artifact: StudyArtifact
  answers: Record<string, string>
  setAnswers: (next: Record<string, string>) => void
  onSubmit: () => void
  blocked: boolean
}) {
  const questions = artifact.body.questions ?? []
  return (
    <section className="study-tool-card">
      <ArtifactHead artifact={artifact} chip={artifact.body.graded ? '已判' : '先答后判'} />
      {questions.map((question, index) => (
        <div key={question.id} className="study-tool-quiz-question">
          <b>{index + 1}. {question.prompt}</b>
          {question.hint ? <small>提示：{question.hint}</small> : null}
          <blockquote>{question.source}</blockquote>
          <textarea
            rows={2}
            value={answers[question.id] ?? ''}
            maxLength={1200}
            placeholder="先写你的答案。老师看完再判，不提前给答案。"
            onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
          />
        </div>
      ))}
      {artifact.body.graded ? (
        <div className="study-tool-feedback">
          <b>老师反馈</b>
          <p>{artifact.body.feedback}</p>
          {artifact.body.gaps?.length ? <p className="quiet">还缺：{artifact.body.gaps.join('；')}</p> : null}
        </div>
      ) : (
        <button className="primary" disabled={blocked} onClick={onSubmit}>
          {blocked ? '老师正在看…' : '交给老师判'}
        </button>
      )}
    </section>
  )
}

function TeachbackArtifact({ artifact }: { artifact: StudyArtifact }) {
  return (
    <section className="study-tool-card">
      <ArtifactHead artifact={artifact} chip="复述" />
      <p className="quiet">你说的：{artifact.body.answer}</p>
      <p>{artifact.body.feedback}</p>
      {artifact.body.covered?.length ? <p className="quiet">讲对了：{artifact.body.covered.join('；')}</p> : null}
      {artifact.body.gaps?.length ? <p className="quiet">还缺：{artifact.body.gaps.join('；')}</p> : null}
    </section>
  )
}

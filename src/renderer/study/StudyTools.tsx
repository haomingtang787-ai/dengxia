import { useEffect, useMemo, useRef, useState } from 'react'
import type { PageView } from '../../shared/contract'
import type { StudyArtifact, StudyQuizAnswer, StudyQuizResult, StudySessionDetail, StudySlideCitation, StudyToolKind } from '../../shared/study'
import { pageForPageNumber, toolCitation } from './evidence'

type ToolPayload = { query?: string; answer?: string; answers?: StudyQuizAnswer[] }

export function StudyTools({
  detail,
  unitOrdinal,
  pages,
  onOpenPage,
  focus,
  busy,
  onFocus,
  onRun,
  only = null,
}: {
  detail: StudySessionDetail
  unitOrdinal: number | null
  pages: PageView[]
  onOpenPage: (citation: StudySlideCitation, page: PageView | null) => void
  focus: StudyToolKind | null
  busy: string | null
  onFocus: (tool: StudyToolKind | null) => void
  onRun: (tool: StudyToolKind, payload?: ToolPayload) => Promise<boolean>
  only?: StudyToolKind | null
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
  const focusOnly: StudyArtifact['kind'] | null = only === 'quiz-grade' ? 'quiz' : only
  const showArtifact = (kind: StudyArtifact['kind']) => !focusOnly || focusOnly === kind
  const focusTitle = focusOnly === 'quiz'
    ? '本讲小测'
    : focusOnly === 'summary'
      ? '本讲总结'
      : focusOnly === 'outline'
        ? '本讲复习大纲'
        : focusOnly === 'search'
          ? '找原文'
          : focusOnly === 'teachback'
            ? '我讲给你听'
            : '老师工具'
  const focusHint = focusOnly === 'quiz'
    ? '先答，再交给老师判；可以只交已答的题，每题都能回原页。'
    : '只放这一项，不把总览、老师手记和别的学习资料一起摊开。'
  const summary = latest('summary', currentScope) ?? latest('summary')
  const outline = latest('outline', currentScope) ?? latest('outline')
  const search = latest('search')
  const quiz = latest('quiz', currentScope) ?? latest('quiz')
  const teachbackArtifact = latest('teachback', currentScope) ?? latest('teachback')
  const blocked = busy !== null

  async function submitQuiz() {
    const questions = quiz?.body.questions ?? []
    const filled = questions
      .map((question, index) => ({
        questionId: question.id,
        answer: (answers[question.id] ?? '').trim(),
        graded: Boolean(quiz?.body.results?.some((result) => result.index === index + 1)),
      }))
      .filter((item) => item.answer && !item.graded)
    if (filled.length === 0) {
      setLocalError('先写一题再交给老师；没答的题可以留着下次答。')
      return
    }
    setLocalError('')
    await onRun('quiz-grade', { answers: filled.map(({ questionId, answer }) => ({ questionId, answer })) })
  }

  return (
    <section className={`study-tools${focusOnly ? ' focused' : ''}`}>
      <div className="study-tools-head">
        <div>
          <h3>{focusTitle}</h3>
          <p>{focusOnly ? focusHint : '可以直接点，也可以直接在对话框里说“总结这一讲”“考考我”；右栏不重复放按钮墙。'}</p>
        </div>
        <span className="chip">{detail.artifacts?.length ?? 0} 份学习资料</span>
      </div>

      {!focusOnly ? (
        <div className="study-tool-actions">
          <button className="ghost" disabled={blocked} onClick={() => { onFocus('summary'); void onRun('summary') }}>总结这一讲</button>
          <button className="ghost" disabled={blocked} onClick={() => { onFocus('quiz'); void onRun('quiz') }}>考考我这讲</button>
          <button className="ghost" disabled={blocked} onClick={() => { onFocus('outline'); void onRun('outline') }}>列复习大纲</button>
          <button className="ghost" disabled={blocked} onClick={() => onFocus('search')}>找原文</button>
          <button className="ghost" disabled={blocked} onClick={() => onFocus('teachback')}>我讲给你听</button>
        </div>
      ) : null}

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
        {showArtifact('summary') && summary ? <SummaryArtifact artifact={summary} pages={pages} onOpenPage={onOpenPage} /> : null}
        {showArtifact('outline') && outline ? <OutlineArtifact artifact={outline} /> : null}
        {showArtifact('search') && search ? <SearchArtifact artifact={search} /> : null}
        {showArtifact('quiz') && quiz ? <QuizArtifact artifact={quiz} answers={answers} setAnswers={setAnswers} onSubmit={submitQuiz} blocked={blocked} pages={pages} onOpenPage={onOpenPage} /> : null}
        {showArtifact('teachback') && teachbackArtifact ? <TeachbackArtifact artifact={teachbackArtifact} /> : null}
        {!focusOnly && !summary && !outline && !search && !quiz && !teachbackArtifact ? (
          <p className="empty">还没有学习资料。点“考考我”或“总结这一讲”，结果会落在课程资料里。</p>
        ) : null}
        {focusOnly && !quiz && focusOnly === 'quiz' ? <p className="empty">还没出题；点右栏“本讲小测”开始。</p> : null}
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

function SummaryArtifact({
  artifact,
  pages,
  onOpenPage,
}: {
  artifact: StudyArtifact
  pages: PageView[]
  onOpenPage: (citation: StudySlideCitation, page: PageView | null) => void
}) {
  return (
    <section className="study-tool-card">
      <ArtifactHead artifact={artifact} chip="总结" />
      <p>{artifact.body.text}</p>
      {artifact.body.citations?.length ? (
        <div className="study-tool-citations">
          {artifact.body.citations.slice(0, 4).map((citation) => {
            const pageNumber = citation.pageNumber ?? null
            const page = pageForPageNumber(pages, pageNumber)
            return pageNumber ? (
              <button
                key={`${citation.unitOrdinal}-${citation.segmentIndex}`}
                className="study-tool-cite"
                onClick={() => onOpenPage(toolCitation(pageNumber, citation.source, page), page)}
              >
                <b>p.{pageNumber}</b>
                <span>第 {citation.unitOrdinal + 1} 讲 · {citation.source.slice(0, 28)}</span>
              </button>
            ) : (
              <span key={`${citation.unitOrdinal}-${citation.segmentIndex}`} className="chip">
                第 {citation.unitOrdinal + 1} 讲 · {citation.source.slice(0, 28)}
              </span>
            )
          })}
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
  pages,
  onOpenPage,
}: {
  artifact: StudyArtifact
  answers: Record<string, string>
  setAnswers: (next: Record<string, string>) => void
  onSubmit: () => void
  blocked: boolean
  pages: PageView[]
  onOpenPage: (citation: StudySlideCitation, page: PageView | null) => void
}) {
  const questions = artifact.body.questions ?? []
  const resultFor = (index: number): StudyQuizResult | null =>
    artifact.body.results?.find((result) => result.index === index + 1) ?? null
  const gradedCount = artifact.body.results?.length ?? 0
  const allGraded = questions.length > 0 && gradedCount >= questions.length
  const answeredCount = questions.filter((question, index) =>
    !resultFor(index + 1) && (answers[question.id] ?? '').trim()
  ).length

  return (
    <section className="study-tool-card">
      <ArtifactHead
        artifact={artifact}
        chip={allGraded ? '已判' : gradedCount ? `${gradedCount}/${questions.length} 已判` : '先答后判'}
      />
      {questions.map((question, index) => {
        const pageNumber = question.pageNumber ?? null
        const page = pageForPageNumber(pages, pageNumber)
        const result = resultFor(index)
        return (
          <div key={question.id} className="study-tool-quiz-question">
            <b>{index + 1}. {question.prompt}</b>
            {question.hint ? <small>提示：{question.hint}</small> : null}
            <blockquote className="study-tool-source">
              {pageNumber ? (
                <button className="study-tool-cite" onClick={() => onOpenPage(toolCitation(pageNumber, question.source, page), page)}>
                  <b>p.{pageNumber}</b>
                  <span>题面出处</span>
                </button>
              ) : null}
              <span>{question.source}</span>
            </blockquote>
            {result ? (
              <div className={`study-tool-result ${result.correct ? 'ok' : 'bad'}`}>
                <b>{result.correct ? '答对' : '答错'} · 第 {index + 1} 题</b>
                <p>{result.explain}</p>
                {pageNumber ? (
                  <button className="study-tool-cite" onClick={() => onOpenPage(toolCitation(pageNumber, question.source, page), page)}>
                    <b>p.{pageNumber}</b>
                    <span>回原页</span>
                  </button>
                ) : null}
              </div>
            ) : (
              <textarea
                rows={2}
                value={answers[question.id] ?? ''}
                maxLength={1200}
                placeholder="先写你的答案。老师看完再判，不提前给答案。"
                onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
              />
            )}
          </div>
        )
      })}
      {allGraded ? (
        <div className="study-tool-feedback">
          <b>老师反馈</b>
          <p>{artifact.body.feedback}</p>
          {artifact.body.gaps?.length ? <p className="quiet">还缺：{artifact.body.gaps.join('；')}</p> : null}
        </div>
      ) : (
        <>
          {gradedCount ? (
            <p className="quiet">已判 {gradedCount} 题；没答的题可以继续写，再交给老师。</p>
          ) : null}
          <button className="primary" disabled={blocked || answeredCount === 0} onClick={onSubmit}>
            {blocked ? '老师正在看…' : answeredCount ? `交给老师判（${answeredCount} 题）` : '先写一题再交给老师'}
          </button>
        </>
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

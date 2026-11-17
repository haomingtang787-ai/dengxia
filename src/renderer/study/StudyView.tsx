import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentListItem, PageView } from '../../shared/contract'
import type { ReviewSummary } from '../../shared/teaching'
import type {
  StudyCheck,
  StudyCourseSession,
  StudyCourseTree,
  StudyCourseTreeItem,
  StudyCourseUnit,
  StudyMessage,
  StudyMode,
  StudyProgress,
  StudyQuizAnswer,
  StudySessionDetail,
  StudySessionListItem,
  StudySkill,
  StudySlideCitation,
  StudyToolKind,
  StudyUnit,
  StudyUsage,
  StudyUsageAudit,
} from '../../shared/study'
import { MathText } from '../components/MathText'
import { DEFAULT_AI } from '../../shared/ai'
import { TeacherProfile } from './TeacherProfile'
import { StudyTools } from './StudyTools'
import {
  AVOID_OPTIONS,
  DEFAULT_HABITS,
  MINUTE_OPTIONS,
  PACE_OPTIONS,
  STYLE_OPTIONS,
  type Habits,
} from '../../teaching/habits'

type Notify = (tone: 'info' | 'bad', text: string) => void
type Busy = 'create' | 'send' | 'finish' | 'tool' | 'load' | 'course' | null

function newRequestId(): string {
  return crypto.randomUUID()
}

function minutesLabel(minutes: number): string {
  return `${minutes} 分钟`
}

function progressText(progress: StudyProgress | null): string {
  if (progress?.phase === 'vision') {
    return progress.total > 0
      ? `正在读懂课件里的图片页：已完成 ${progress.done}/${progress.total} 页。`
      : '正在读懂课件里的图片页。'
  }
  if (progress?.phase === 'reading') {
    return progress.total > 0
      ? `正在逐段读懂整份课件：已完成 ${progress.done}/${progress.total} 段，读完后马上拆课。`
      : '正在按页切分这份长课件，准备逐段读懂。'
  }
  if (progress?.phase === 'planning') {
    return '整份材料已读懂，正在按你的习惯设计课程、写逐句讲稿。'
  }
  return '正在完整接收整份材料：逐页取文字或让 AI 读图，再设计课程、写逐句讲稿。'
}

function habitSummary(habits: Habits): string {
  const pace = PACE_OPTIONS.find((item) => item.id === habits.pace)?.label ?? '适中'
  const style = STYLE_OPTIONS.find((item) => item.id === habits.style)?.label ?? '先比方'
  const avoid = AVOID_OPTIONS.find((item) => item.id === habits.avoid)?.label ?? '长段落'
  const name = habits.name.trim() ? `${habits.name.trim()}，` : ''
  return `${name}一次约 ${habits.minutes} 分钟；节奏${pace}、方式${style}；避开${avoid}。`
}

function tokenLabel(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function timeLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function pageNumberFromSource(source: string): number | null {
  const match = source.match(/第\s*(\d+)\s*页/)
  return match ? Number(match[1]) : null
}

function stripCoursePrefix(value: string, courseName: string): string {
  if (!courseName) return value
  const escaped = courseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return value.replace(new RegExp(`^${escaped}[-—– ]*`), '')
}

function bboxStyle(bbox: [number, number, number, number]): { left: string; top: string; width: string; height: string } {
  return {
    left: `${Math.max(0, Math.min(1, bbox[0])) * 100}%`,
    top: `${Math.max(0, Math.min(1, bbox[1])) * 100}%`,
    width: `${Math.max(0, Math.min(1, bbox[2])) * 100}%`,
    height: `${Math.max(0, Math.min(1, bbox[3])) * 100}%`,
  }
}

function pageForCitation(citation: StudySlideCitation, pages: PageView[]): PageView | null {
  return pages.find((page) => page.pageId === citation.pageId)
    ?? pages.find((page) => page.ordinal === citation.pageNumber - 1)
    ?? null
}

export function StudyView({
  notify,
  documents,
  selectedVersionId,
  onImport,
  onOpenReview,
  onOpenSettings,
}: {
  notify: Notify
  documents: DocumentListItem[]
  selectedVersionId: string | null
  onImport: () => Promise<string | null>
  onOpenReview: () => void
  onOpenSettings: () => void
}) {
  const api = window.desk
  const [courses, setCourses] = useState<StudyCourseTree | null>(null)
  const [sessions, setSessions] = useState<StudySessionListItem[]>([])
  const [detail, setDetail] = useState<StudySessionDetail | null>(null)
  const [habits, setHabits] = useState<Habits>({ ...DEFAULT_HABITS })
  const [unitId, setUnitId] = useState<string | null>(null)
  const [activeCourseId, setActiveCourseId] = useState<string | null>(null)
  const [expandedCourses, setExpandedCourses] = useState<Set<string>>(new Set())
  const [question, setQuestion] = useState('')
  const [mode, setMode] = useState<StudyMode>('direct')
  const [skill, setSkill] = useState<StudySkill>('auto')
  const [modelName, setModelName] = useState<string>(DEFAULT_AI.model)
  const [modelChoices, setModelChoices] = useState<string[]>([])
  const [modelBusy, setModelBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [railBusy, setRailBusy] = useState<'review' | 'cards' | null>(null)
  const [railNote, setRailNote] = useState('')
  const [reviewStats, setReviewStats] = useState<ReviewSummary | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [progress, setProgress] = useState<StudyProgress | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [leftOpen, setLeftOpen] = useState(true)
  const [railQuery, setRailQuery] = useState('')
  const [rightOpen, setRightOpen] = useState(false)
  const [materialsOpen, setMaterialsOpen] = useState(false)
  const [toolFocus, setToolFocus] = useState<StudyToolKind | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [teacherOpen, setTeacherOpen] = useState(false)
  const [teacherName, setTeacherName] = useState('老师')
  const [confirmAction, setConfirmAction] = useState<'chat' | 'summary' | 'delete' | null>(null)
  const [pages, setPages] = useState<PageView[]>([])
  const [pagesReady, setPagesReady] = useState(false)
  const [slidePeek, setSlidePeek] = useState<{ citation: StudySlideCitation; page: PageView | null } | null>(null)
  const [courseDialog, setCourseDialog] = useState<{ mode: 'create' | 'rename'; courseId?: string; name: string } | null>(null)
  const [courseDialogBusy, setCourseDialogBusy] = useState(false)
  const autoStarted = useRef('')
  const importedVersion = useRef<string | null>(null)
  const importPending = useRef(false)
  const stickBottom = useRef(false)
  const streamRef = useRef<HTMLDivElement | null>(null)
  const questionRef = useRef<HTMLTextAreaElement | null>(null)

  const selectedDoc = useMemo(
    () => documents.find((doc) => doc.documentVersionId === selectedVersionId) ?? documents[0] ?? null,
    [documents, selectedVersionId],
  )

  const refreshCourses = useCallback(async () => {
    if (!api) return
    const result = await api.study.courses()
    if (result.ok) setCourses(result.data)
    else notify('bad', result.error.message)
  }, [api, notify])

  const open = useCallback(async (sessionId: string): Promise<StudySessionDetail | null> => {
    if (!api) return null
    const result = await api.study.get({ sessionId })
    if (!result.ok) {
      notify('bad', result.error.message)
      return null
    }
    setDetail(result.data)
    setUnitId(result.data.units[0]?.id ?? null)
    setActiveCourseId(result.data.courseId ?? null)
    if (result.data.courseId) {
      setExpandedCourses((current) => new Set(current).add(result.data.courseId!))
    }
    setError('')
    stickBottom.current = false
    return result.data
  }, [api, notify])

  const refreshReviewStats = useCallback(async () => {
    if (!api) return
    const result = await api.teaching.reviewSummary()
    if (result.ok) setReviewStats(result.data)
  }, [api])

  useEffect(() => {
    void refreshReviewStats()
  }, [refreshReviewStats])

  useEffect(() => {
    let alive = true
    void api?.teacher.overview().then((result) => {
      if (!alive || !result.ok) return
      setTeacherName(result.data.persona.name)
    })
    return () => {
      alive = false
    }
  }, [api])

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!api) return
      const [courseResult, listResult, habitsResult, aiResult] = await Promise.all([
        api.study.courses(),
        api.study.list(),
        api.teaching.habits.get(),
        api.ai.status(),
      ])
      if (!alive) return
      if (courseResult.ok) {
        setCourses(courseResult.data)
        const first = courseResult.data.items[0]
        if (first) {
          setActiveCourseId((current) => current ?? first.courseId)
          setExpandedCourses((current) => current.size ? current : new Set([first.courseId]))
        }
      } else {
        notify('bad', courseResult.error.message)
      }
      if (listResult.ok) setSessions(listResult.data.items)
      else notify('bad', listResult.error.message)
      if (habitsResult.ok) setHabits(habitsResult.data)
      if (aiResult.ok && aiResult.data.model) setModelName(aiResult.data.model)
      if (listResult.ok) {
        const preferred = selectedVersionId
          ? listResult.data.items.find((item) => item.documentVersionId === selectedVersionId)
          : listResult.data.items[0]
        if (preferred) {
          importedVersion.current = null
          importPending.current = false
          await open(preferred.sessionId)
        } else if (selectedVersionId && (importPending.current || selectedVersionId === importedVersion.current)) {
          // 刚导入、还没拆课的文稿：先把旧课堂退场，让下面的自动拆课接住它。
          importedVersion.current = null
          importPending.current = false
          setDetail(null)
          setUnitId(null)
        }
      }
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [api, notify, open, selectedVersionId])

  useEffect(() => {
    const off = api?.study.onProgress?.((next) => setProgress(next))
    return () => off?.()
  }, [api])

  // 一份课件的页图只取一次；老师回答里的 citations 用 pageId 对上它。
  // 单次 IPC 最多 200 页，长课件按页循环取完，避免第 201 页以后没有对照图。
  useEffect(() => {
    let alive = true
    setPages([])
    setPagesReady(false)
    if (!detail) return
    void (async () => {
      if (!api) return
      const collected: PageView[] = []
      let offset = 0
      for (let guard = 0; guard < 20; guard += 1) {
        const result = await api.documents.pages({ documentVersionId: detail.documentVersionId, offset, limit: 200 })
        if (!alive) return
        if (!result.ok) break
        collected.push(...result.data.items)
        if (result.data.items.length === 0 || collected.length >= result.data.total) break
        offset += result.data.items.length
      }
      if (!alive) return
      setPages(collected)
      setPagesReady(true)
    })()
    return () => {
      alive = false
    }
  }, [api, detail?.documentVersionId])

  const activeUnit = detail?.units.find((unit) => unit.id === unitId) ?? detail?.units[0] ?? null
  const courseItems = courses?.items ?? []
  const activeCourse = courseItems.find((course) => course.courseId === (detail?.courseId ?? activeCourseId)) ?? null
  const courseName = activeCourse?.name ?? detail?.subject ?? '未分类'
  const visibleCourses = useMemo(() => {
    const query = railQuery.trim().toLowerCase()
    if (!query) return courseItems
    return courseItems
      .map((course) => {
        const courseMatches = course.name.toLowerCase().includes(query)
        return {
          ...course,
          sessions: courseMatches
            ? course.sessions
            : course.sessions.filter((session) =>
                session.title.toLowerCase().includes(query)
                || session.sourceName.toLowerCase().includes(query)
                || session.units.some((unit) => unit.title.toLowerCase().includes(query)),
              ),
        }
      })
      .filter((course) => course.name.toLowerCase().includes(query) || course.sessions.length > 0)
  }, [courseItems, railQuery])
  const totalMinutes = detail?.units.reduce((sum, unit) => sum + unit.minutes, 0) ?? 0
  const latestAssistantId = useMemo(() => {
    if (!detail) return null
    return [...detail.messages].reverse().find((message) => message.role === 'assistant' && message.citations.length > 0)?.id ?? null
  }, [detail])

  useEffect(() => {
    setToolFocus(null)
    setRightOpen(false)
    setRailNote('')
  }, [detail?.sessionId])

  useEffect(() => {
    let alive = true
    void api?.ai.models().then((result) => {
      if (alive && result.ok) setModelChoices(result.data.models)
    })
    return () => {
      alive = false
    }
  }, [api])

  const modelOptions = useMemo(() => {
    const extras = modelChoices.length ? modelChoices : ['deepseek-chat', 'deepseek-reasoner']
    return Array.from(new Set([modelName, ...extras].filter((item) => item && item !== '模型')))
  }, [modelChoices, modelName])

  useEffect(() => {
    if (!stickBottom.current) return
    const messages = streamRef.current?.querySelectorAll<HTMLElement>('.ws-message')
    const last = messages?.item(messages.length - 1)
    if (!last) return
    last.scrollIntoView({ block: 'end', behavior: 'smooth' })
    if (busy !== 'send') stickBottom.current = false
  }, [detail?.messages.length, busy])

  function scrollToUnit(ordinal: number) {
    const node = streamRef.current?.querySelector<HTMLElement>(`[data-unit="${ordinal}"]`)
    node?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  async function jumpToUnit(session: StudyCourseSession, unit: StudyCourseUnit) {
    if (!detail || detail.sessionId !== session.sessionId) {
      const opened = await open(session.sessionId)
      if (!opened) return
    }
    setUnitId(unit.id)
    setActiveCourseId(session.courseId ?? null)
    setRightOpen(false)
    window.setTimeout(() => scrollToUnit(unit.ordinal), 140)
  }

  function toggleCourse(courseId: string) {
    setExpandedCourses((current) => {
      const next = new Set(current)
      if (next.has(courseId)) next.delete(courseId)
      else next.add(courseId)
      return next
    })
    setActiveCourseId(courseId)
  }

  function openCourseMenu(event: React.MouseEvent, course: StudyCourseTreeItem, action: 'rename' | 'delete' | 'up' | 'down') {
    event.stopPropagation()
    if (action === 'rename') {
      setCourseDialog({ mode: 'rename', courseId: course.courseId, name: course.name })
      return
    }
    if (action === 'delete') {
      if (!window.confirm(`删除课程「${course.name}」会连同里面的课件、对话和用量一起删除。继续？`)) return
      void deleteCourse(course)
      return
    }
    const index = courseItems.findIndex((item) => item.courseId === course.courseId)
    const target = action === 'up' ? index - 1 : index + 1
    if (index < 0 || target < 0 || target >= courseItems.length) return
    const ids = courseItems.map((item) => item.courseId)
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    void api?.study.courseReorder({ ids }).then((result) => {
      if (result.ok) setCourses(result.data)
      else notify('bad', result.error.message)
    })
  }

  async function deleteCourse(course: StudyCourseTreeItem) {
    if (!api) return
    const result = await api.study.courseDelete({ courseId: course.courseId })
    if (!result.ok) { notify('bad', result.error.message); return }
    setCourses(result.data)
    if (detail?.courseId === course.courseId) {
      setDetail(null)
      setUnitId(null)
    }
    notify('info', `课程「${course.name}」已删除。`)
  }

  async function submitCourseDialog(name: string) {
    if (!api || !courseDialog) return
    setCourseDialogBusy(true)
    const result = courseDialog.mode === 'create'
      ? await api.study.courseCreate({ name })
      : await api.study.courseRename({ courseId: courseDialog.courseId!, name })
    setCourseDialogBusy(false)
    if (!result.ok) { notify('bad', result.error.message); return }
    setCourses(result.data)
    const created = result.data.items.find((item) => item.name === name)
    if (created) {
      setActiveCourseId(created.courseId)
      setExpandedCourses((current) => new Set(current).add(created.courseId))
    }
    setCourseDialog(null)
    notify('info', courseDialog.mode === 'create' ? '课程已建好。' : '课程名已改。')
  }

  async function runImport() {
    if (importing) return
    setImporting(true)
    importPending.current = true
    try {
      const imported = await onImport()
      if (imported) importedVersion.current = imported
      else importPending.current = false
    } finally {
      setImporting(false)
    }
  }

  async function changeModel(next: string) {
    if (!api || !next || next === modelName || modelBusy) return
    setModelBusy(true)
    const status = await api.ai.status()
    if (!status.ok) {
      setModelBusy(false)
      notify('bad', status.error.message)
      return
    }
    const saved = await api.ai.saveConfig({
      baseUrl: status.data.baseUrl,
      model: next,
      visionModel: status.data.visionModel,
      apiKey: '',
    })
    setModelBusy(false)
    if (!saved.ok) {
      notify('bad', saved.error.message)
      return
    }
    setModelName(saved.data.model)
    notify('info', `模型已切换到 ${saved.data.model}，下一句起生效。`)
  }

  async function generateReview() {
    if (!api || !detail || busy || railBusy) return
    setRailBusy('review')
    setRailNote('正在整理这一讲的总结和大纲…')
    setError('')
    const base = { sessionId: detail.sessionId, unitOrdinal: activeUnit?.ordinal ?? null }
    const summary = await api.study.tool({ ...base, tool: 'summary' })
    if (!summary.ok) {
      setRailBusy(null)
      setRailNote('复习资料没生成，稍后再试。')
      notify('bad', summary.error.message)
      return
    }
    const outline = await api.study.tool({ ...base, tool: 'outline' })
    setRailBusy(null)
    if (!outline.ok) {
      setDetail(summary.data)
      setRailNote('总结已好；大纲这次没写成。')
      notify('bad', `总结已生成，但大纲没写成：${outline.error.message}`)
      return
    }
    setDetail(outline.data)
    setRailNote('复习总结和大纲已生成，点下面的生成物就能看。')
    notify('info', '复习总结和大纲已放进右栏「生成物」，点开就能看。')
  }

  function cardSeeds(unit: StudyUnit) {
    const points = unit.keyPoints.map((point) => {
      const match = unit.segments.find((segment) => segment.explain.includes(point) || segment.check.includes(point))
      return { front: point, back: match?.explain ?? unit.source, quote: match?.source ?? unit.source }
    })
    if (points.length) return points
    return unit.segments.map((segment) => ({ front: segment.check, back: segment.explain, quote: segment.source }))
  }

  async function generateCards() {
    if (!api || !detail || !activeUnit || busy || railBusy) return
    const seeds = cardSeeds(activeUnit)
      .map((seed) => ({ ...seed, front: seed.front.trim().slice(0, 240), back: seed.back.trim().slice(0, 800), quote: seed.quote.trim().slice(0, 800) }))
      .filter((seed) => seed.front)
    if (!seeds.length) {
      notify('bad', '这一讲还没有能抽成卡片的知识点。先让老师讲一遍，再试。')
      return
    }
    setRailBusy('cards')
    setRailNote('正在把这一讲的知识点做成卡片…')
    const existingResult = await api.teaching.cards.list()
    const existing = new Set(existingResult.ok ? existingResult.data.items.map((card) => card.front.trim()) : [])
    let created = 0
    let failed = 0
    for (const seed of seeds.slice(0, 5)) {
      if (existing.has(seed.front)) continue
      const result = await api.teaching.cards.create({
        front: seed.front,
        back: seed.back,
        quote: seed.quote,
        documentVersionId: detail.documentVersionId,
      })
      if (!result.ok) {
        failed += 1
        continue
      }
      existing.add(seed.front)
      created += 1
    }
    setRailBusy(null)
    await refreshReviewStats()
    if (created) setRailNote(`已生成 ${created} 张卡片，去「复习」里看。`)
    else if (failed) setRailNote('卡片这次没写成，稍后再试。')
    else setRailNote('这些知识点已经有卡片了，没有重复生成。')
    if (created) notify('info', `已把这一讲的 ${created} 张卡片放进复习队列，去「复习」里看。`)
    else if (failed) notify('bad', '卡片这次没写成，稍后再试一次。')
    else notify('info', '这些知识点已经有卡片了，没有重复生成。')
  }

  function personalizeTutoring() {
    setMode('guided')
    setSkill('diagnose')
    setQuestion((current) => current.trim() || '按我的学习习惯，先帮我找出这一讲最该补的一个漏洞。')
    questionRef.current?.focus()
    setRailNote('已切到引导式；按发送开始个性化辅导。')
    notify('info', '已切到引导式；按发送开始个性化辅导。')
  }

  async function createSession() {
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
      courseId: activeCourse?.courseId ?? activeCourseId ?? null,
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
    setActiveCourseId(result.data.courseId ?? null)
    if (result.data.courseId) {
      setExpandedCourses((current) => new Set(current).add(result.data.courseId!))
    }
    await refreshCourses()
    notify('info', `AI 已读完 ${selectedDoc.displayName}，拆成 ${result.data.units.length} 讲。`)
    setBusy(null)
    setProgress(null)
  }

  useEffect(() => {
    if (loading || detail || busy) return
    if (!selectedDoc) return
    if (sessions.some((item) => item.documentVersionId === selectedDoc.documentVersionId)) return
    if (autoStarted.current === selectedDoc.documentVersionId) return
    autoStarted.current = selectedDoc.documentVersionId
    void createSession()
  }, [loading, detail, busy, selectedDoc, sessions, activeCourseId])

  async function sendQuestion() {
    if (!api || !detail || busy) return
    const content = question.trim()
    if (!content) {
      setError('先写一句想问老师的话。')
      return
    }
    setBusy('send')
    setError('')
    stickBottom.current = true
    const before = new Map(detail.artifacts.map((item) => [item.id, item.updatedAt]))
    const result = await api.study.send({
      sessionId: detail.sessionId,
      content,
      unitOrdinal: activeUnit?.ordinal ?? null,
      mode,
      skill,
    })
    if (!result.ok) {
      setError(result.error.message)
      setBusy(null)
      return
    }
    setDetail(result.data)
    setQuestion('')
    setBusy(null)
    const changed = result.data.artifacts.find((item) => before.get(item.id) !== item.updatedAt)
    if (changed) notify('info', '老师把生成物放到右栏「生成物」里了。')
  }

  async function runTool(
    tool: StudyToolKind,
    payload: { query?: string; answer?: string; answers?: StudyQuizAnswer[] } = {},
  ): Promise<boolean> {
    if (!api || !detail || busy) return false
    setBusy('tool')
    setError('')
    const result = await api.study.tool({
      sessionId: detail.sessionId,
      tool,
      unitOrdinal: activeUnit?.ordinal ?? null,
      ...payload,
    })
    setBusy(null)
    if (!result.ok) {
      setError(result.error.message)
      notify('bad', result.error.message)
      return false
    }
    setDetail(result.data)
    setMaterialsOpen(true)
    setToolFocus(tool === 'quiz-grade' ? 'quiz' : tool)
    const labels: Partial<Record<StudyToolKind, string>> = {
      search: '老师找到了本地原文。',
      summary: '总结已放进右栏生成物。',
      outline: '复习大纲已放进右栏生成物。',
      quiz: '题测已放进右栏生成物，先答再判。',
      'quiz-grade': '老师看完了你的作答。',
      teachback: '老师听完了你的复述。',
    }
    if (labels[tool]) notify('info', labels[tool]!)
    return true
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
    notify('info', result.data.teacherNote
      ? '学习分析总结和老师手记已生成。'
      : '学习分析总结已生成；老师手记这次没写成，不影响总结。')
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
    setMoreOpen(false)
    setConfirmAction(null)
    notify('info', '对话记录已清除。')
  }

  async function clearSummary() {
    if (!api || !detail) return
    const result = await api.study.clearSummary({ sessionId: detail.sessionId })
    if (!result.ok) { notify('bad', result.error.message); return }
    setDetail(result.data)
    setMoreOpen(false)
    setConfirmAction(null)
    notify('info', '学习总结已清除，可以重新生成。')
  }

  async function deleteSession() {
    if (!api || !detail) return
    const docId = detail.documentVersionId
    const result = await api.study.delete({ sessionId: detail.sessionId })
    if (!result.ok) { notify('bad', result.error.message); return }
    setDetail(null)
    setUnitId(null)
    setMoreOpen(false)
    setMaterialsOpen(false)
    setConfirmAction(null)
    autoStarted.current = docId
    setSessions(result.data.items)
    await refreshCourses()
    notify('info', '这份课件的课堂已删除。')
  }

  const usageTotal = detail ? detail.usage.promptTokens + detail.usage.completionTokens : 0

  if (loading) {
    return <div className="study-empty"><p className="quiet">正在读取你的课程…</p></div>
  }

  const leftRail = (
    <aside className={`ws-left${leftOpen ? '' : ' collapsed'}`}>
      {leftOpen ? (
        <>
          <div className="ws-brand">
            <span className="ws-logo">灯</span>
            <div className="ws-brand-text">
              <b>灯下</b>
              <small>只在这台电脑上的老师</small>
            </div>
            <button className="ws-collapse" title="收起左栏" onClick={() => setLeftOpen(false)}>‹</button>
          </div>

          <div className="ws-rail-actions">
            <div className="ws-rail-buttons">
              <button className="ws-new-course" title="新建课程" onClick={() => setCourseDialog({ mode: 'create', name: '' })}>
                <span>＋</span> 新建课程
              </button>
              <button className="ws-import-course" title="导入课件" onClick={() => void runImport()} disabled={importing}>
                <span>{importing ? '…' : '⇧'}</span> {importing ? '导入中' : '导入课件'}
              </button>
            </div>
            <label className="ws-search">
              <span>⌕</span>
              <input
                value={railQuery}
                placeholder="搜索课程、课件或讲"
                onChange={(event) => setRailQuery(event.target.value)}
              />
            </label>
          </div>

          <div className="ws-tree-label">
            <span>课程</span>
            <small>{courseItems.length} 门 · {courseItems.reduce((sum, course) => sum + course.sessions.length, 0)} 份课件</small>
          </div>

          <div className="ws-course-list">
            {visibleCourses.map((course) => {
              const expanded = expandedCourses.has(course.courseId) || Boolean(railQuery.trim())
              const active = (detail?.courseId ?? activeCourseId) === course.courseId
              return (
                <div key={course.courseId} className={`ws-course${expanded ? ' open' : ''}${active ? ' active' : ''}`}>
                  <div className="ws-course-row" onClick={() => toggleCourse(course.courseId)} role="button" tabIndex={0}
                    onKeyDown={(event) => { if (event.key === 'Enter') toggleCourse(course.courseId) }}>
                    <span className="ws-course-caret">{expanded ? '▾' : '▸'}</span>
                    <span className="ws-course-name">{course.name}</span>
                    <span className="ws-course-count">{course.sessions.length}</span>
                    <span className="ws-course-actions" onClick={(event) => event.stopPropagation()}>
                      <button title="上移" onClick={(event) => openCourseMenu(event, course, 'up')}>↑</button>
                      <button title="下移" onClick={(event) => openCourseMenu(event, course, 'down')}>↓</button>
                      <button title="改名" onClick={(event) => openCourseMenu(event, course, 'rename')}>改</button>
                      <button title="删除课程" onClick={(event) => openCourseMenu(event, course, 'delete')}>×</button>
                    </span>
                  </div>
                  {expanded ? (
                    <div className="ws-course-body">
                      {course.sessions.length === 0 ? (
                        <div className="ws-course-empty">
                          <p>还没有课件。</p>
                          <button className="ghost" onClick={() => void runImport()} disabled={importing}>
                            {importing ? '正在导入…' : '导入课件'}
                          </button>
                        </div>
                      ) : course.sessions.map((session) => {
                        const isActive = detail?.sessionId === session.sessionId
                        return (
                          <div key={session.sessionId} className="ws-doc-group">
                            <button
                              className={`ws-doc${isActive ? ' active' : ''}`}
                              onClick={() => void open(session.sessionId)}
                              title={session.sourceName}
                            >
                              <span className="ws-doc-text">
                                <b>{stripCoursePrefix(session.sourceName || session.title, course.name)}</b>
                              </span>
                              <span className="ws-doc-count">{session.unitCount} 讲</span>
                            </button>
                            {isActive ? (
                              <div className="ws-doc-units">
                                {session.units.map((unit) => (
                                  <button
                                    key={unit.id}
                                    className={`ws-unit${activeUnit?.id === unit.id ? ' active' : ''}`}
                                    onClick={() => void jumpToUnit(session, unit)}
                                  >
                                    <span className="ws-unit-n">{String(unit.ordinal + 1).padStart(2, '0')}</span>
                                    <span className="ws-unit-title">{unit.title}</span>
                                    <small>{unit.minutes}m</small>
                                  </button>
                                ))}
                                {session.units.length === 0 ? <p className="ws-doc-empty">还没有分讲。</p> : null}
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              )
            })}
            {courseItems.length === 0 ? (
              <div className="ws-course-empty first">
                <p>还没有课程。先建一门课，再用「导入课件」把课件放进来。</p>
                <button className="primary" onClick={() => setCourseDialog({ mode: 'create', name: '' })}>新建课程</button>
              </div>
            ) : courseItems.length > 0 && visibleCourses.length === 0 ? (
              <div className="ws-course-empty"><p>没有搜到。换个词，或清空搜索。</p></div>
            ) : null}
          </div>

          <footer className="ws-left-foot">
            <button onClick={onOpenReview}>
              <span>◫</span>
              <b>复习</b>
              <small>到点再练</small>
            </button>
            <button onClick={onOpenSettings}>
              <span>⚙</span>
              <b>设置</b>
              <small>模型与本机</small>
            </button>
          </footer>
        </>
      ) : (
        <button className="ws-icon ws-expand-left" title="展开课程" onClick={() => setLeftOpen(true)}>课程</button>
      )}
    </aside>
  )

  const contextRail = detail ? (
    <ContextRail
      detail={detail}
      unit={activeUnit}
      open={rightOpen}
      busy={busy !== null}
      railBusy={railBusy}
      railNote={railNote}
      reviewStats={reviewStats}
      onClose={() => setRightOpen(false)}
      onOpenMaterials={(focus) => { setToolFocus(focus); setMaterialsOpen(true) }}
      onReview={() => void generateReview()}
      onCards={() => void generateCards()}
      onQuiz={() => void runTool('quiz')}
      onOpenReview={onOpenReview}
      onPersonalize={personalizeTutoring}
    />
  ) : null

  return (
    <div className={`ws-study${leftOpen ? '' : ' left-collapsed'}${rightOpen ? ' right-open' : ''}`}>
      {leftRail}

      {!detail ? (
        <main className="ws-center ws-intro-center">
          <header className="ws-center-head">
            <div>
              <div className="ws-crumb">AI 私教 · 对话式课堂</div>
              <h2>今天想学什么？</h2>
              <p className="quiet">
                {selectedDoc
                  ? `当前选中：${selectedDoc.displayName}。左边选课程，或直接开课。`
                  : '把课件交给老师，或者从左栏打开一门课，直接接着聊。'}
              </p>
            </div>
            <div className="ws-head-actions">
              <button className="ghost" onClick={() => setTeacherOpen(true)}>老师档案</button>
              {selectedDoc ? (
                <button className="primary" onClick={() => void createSession()} disabled={busy !== null}>
                  {busy === 'create' ? '正在完整读懂并拆课…' : '完整读懂并拆课'}
                </button>
              ) : null}
            </div>
          </header>
          {error ? <div className="banner bad">{error}</div> : null}
          {busy === 'create' ? (
            <div className="study-progress">
              <span className="pulse-dot" />
              <p>{progressText(progress)}</p>
            </div>
          ) : null}
          <div className="ws-intro-scroll">
            <div className="ws-home-shell">
              <div className="ws-home-mark">今天 · 等你开口</div>
              <div className="ws-message assistant ws-home-message">
                <span className="ws-avatar">师</span>
                <div className="ws-bubble ws-home-bubble">
                  <p>把课件发给我，我先整份读懂，再按你的习惯拆成几讲。你也可以从左栏打开一门课，直接接着聊。</p>
                  <div className="ws-home-starters">
                    <button onClick={() => void runImport()} disabled={importing}>
                      <b>⇧</b>
                      <span>导入课件<small>PDF / PPT / Word</small></span>
                    </button>
                    <button onClick={() => setCourseDialog({ mode: 'create', name: '' })}>
                      <b>＋</b>
                      <span>新建课程<small>先建一门课</small></span>
                    </button>
                  </div>
                </div>
              </div>
              <details className="ws-home-habits">
                <summary>
                  <span>你的学习习惯</span>
                  <small>{habitSummary(habits)}</small>
                  <em>调整</em>
                </summary>
                <div className="ws-home-habits-body">
                  <label className="study-field">
                    <span>称呼</span>
                    <input value={habits.name} maxLength={16} placeholder="留空就用「你」" onChange={(event) => void patchHabits({ name: event.target.value })} />
                  </label>
                <div className="habit-group">
                  <span className="habit-label">节奏</span>
                  <div className="habit-row">
                    {PACE_OPTIONS.map((item) => (
                      <button key={item.id} className={`pill ${habits.pace === item.id ? ' active' : ''}`} onClick={() => void patchHabits({ pace: item.id })}>{item.label}</button>
                    ))}
                  </div>
                </div>
                <div className="habit-group">
                  <span className="habit-label">讲解方式</span>
                  <div className="habit-row">
                    {STYLE_OPTIONS.map((item) => (
                      <button key={item.id} className={`pill ${habits.style === item.id ? ' active' : ''}`} onClick={() => void patchHabits({ style: item.id })}>{item.label}</button>
                    ))}
                  </div>
                </div>
                <div className="habit-group">
                  <span className="habit-label">一坐时长</span>
                  <div className="habit-row">
                    {MINUTE_OPTIONS.map((item) => (
                      <button key={item.id} className={`pill ${habits.minutes === item.id ? ' active' : ''}`} onClick={() => void patchHabits({ minutes: item.id })}>{item.label}</button>
                    ))}
                  </div>
                </div>
                <div className="habit-group">
                  <span className="habit-label">要避开</span>
                  <div className="habit-row">
                    {AVOID_OPTIONS.map((item) => (
                      <button key={item.id} className={`pill ${habits.avoid === item.id ? ' active' : ''}`} onClick={() => void patchHabits({ avoid: item.id })}>{item.label}</button>
                    ))}
                  </div>
                </div>
                </div>
              </details>
              <p className="ws-home-foot">课件只留在这台电脑；没有账号，没有云同步。</p>
            </div>
          </div>
        </main>
      ) : (
        <main className="ws-center">
          <header className="ws-center-head">
            <div className="ws-center-title">
              <div className="ws-crumb">
                <span>{courseName}</span>
                <span className="ws-slash">/</span>
                <span>{stripCoursePrefix(detail.sourceName || detail.title, courseName)}</span>
              </div>
              <h2>
                {activeUnit ? <>第 {activeUnit.ordinal + 1} 讲 · {activeUnit.title.split(/[：:]/)[0]}</> : detail.title}
                {activeUnit ? <span className="ws-live-dot">正在讲</span> : null}
              </h2>
              <p className="ws-head-meta">
                {detail.units.length} 讲 · 约 {totalMinutes} 分钟 · {pages.length ? `讲义 ${pages.length} 页 · ` : ''}上次更新 {timeLabel(detail.updatedAt)}
              </p>
            </div>
            <div className="ws-head-actions">
              <button className="ghost ws-context-toggle" onClick={() => setRightOpen((open) => !open)}>这一讲</button>
              <button className="ghost ws-materials-btn" onClick={() => setMaterialsOpen(true)}>整份课件</button>
              <div className="study-manage">
                <button className="ghost" onClick={() => { setMoreOpen((open) => !open); setConfirmAction(null) }}>更多</button>
                {moreOpen ? (
                  <div className="study-manage-menu ws-more-menu">
                    <p className="study-menu-label">这份课件</p>
                    <button onClick={() => { setMoreOpen(false); setMaterialsOpen(true) }}>整份课件资料</button>
                    <button onClick={() => { setMoreOpen(false); setTeacherOpen(true) }}>老师档案</button>
                    <button onClick={() => { setMoreOpen(false); void runImport() }}>导入另一份课件</button>
                    <button disabled={busy !== null || !selectedDoc} onClick={() => { setMoreOpen(false); void createSession() }}>
                      用当前文稿再开一门
                    </button>
                    <div className="study-menu-divider" />
                    <p className="study-menu-label">收尾与整理</p>
                    <button onClick={() => { setMoreOpen(false); setMaterialsOpen(true) }}>学习总结与老师手记</button>
                    <button onClick={() => (confirmAction === 'chat' ? void clearChat() : setConfirmAction('chat'))}>
                      {confirmAction === 'chat' ? '再点一次，清除全部对话' : '清除对话记录'}
                    </button>
                    <button onClick={() => (confirmAction === 'summary' ? void clearSummary() : setConfirmAction('summary'))}>
                      {confirmAction === 'summary' ? '再点一次，清除总结' : '清除学习总结'}
                    </button>
                    <button className="danger-text" onClick={() => (confirmAction === 'delete' ? void deleteSession() : setConfirmAction('delete'))}>
                      {confirmAction === 'delete' ? '再点一次，删除这份课件课堂' : '删除这份课件课堂'}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          {error ? <div className="banner bad">{error}</div> : null}
          {busy === 'create' ? (
            <div className="study-progress">
              <span className="pulse-dot" />
              <p>{progressText(progress)}</p>
            </div>
          ) : null}

          <div className="ws-stream" ref={streamRef}>
            {detail.messages.length === 0 ? <p className="quiet ws-empty-stream">老师还没开口。</p> : null}
            <div className="ws-system">开课与总览 · 这份课件已拆成 {detail.units.length} 讲</div>
            {overviewMessages(detail).map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                teacherName={teacherName}
                latest={false}
                pages={pages}
                pagesReady={pagesReady}
                onOpenPage={(citation, page) => setSlidePeek({ citation, page })}
              />
            ))}

            {detail.units.map((unit) => {
              const unitMessages = messagesForUnit(detail, unit)
              return (
                <section key={unit.id} className="ws-unit-block">
                  <div className={`ws-unit-divider${unit.ordinal === 0 ? ' first' : ''}`} data-unit={unit.ordinal}>
                    <span>第 {unit.ordinal + 1} 讲 · {unit.title}</span>
                    <small>{minutesLabel(unit.minutes)}</small>
                  </div>
                  <LectureBlock
                    unit={unit}
                    checks={detail.checks}
                    active={activeUnit?.id === unit.id}
                    onSave={saveCheck}
                  />
                  {unitMessages.map((message) => (
                    <ChatMessage
                      key={message.id}
                      message={message}
                      teacherName={teacherName}
                      latest={message.id === latestAssistantId}
                      pages={pages}
                      pagesReady={pagesReady}
                      onOpenPage={(citation, page) => setSlidePeek({ citation, page })}
                    />
                  ))}
                  {busy === 'send' && activeUnit?.id === unit.id ? (
                    <div className="ws-message assistant pending">
                      <span className="ws-avatar">师</span>
                      <div className="ws-bubble"><p>正在对照这一讲的讲义页回答…</p></div>
                    </div>
                  ) : null}
                </section>
              )
            })}
            {orphanMessages(detail).map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                teacherName={teacherName}
                latest={message.id === latestAssistantId}
                pages={pages}
                pagesReady={pagesReady}
                onOpenPage={(citation, page) => setSlidePeek({ citation, page })}
              />
            ))}
          </div>

          <div className="ws-composer">
            <div className="ws-composer-box">
              <div className="ws-composer-input">
                <button className="ws-plus" title="打开整份课件与资料" onClick={() => setMaterialsOpen(true)}>＋</button>
                <textarea
                  ref={questionRef}
                  value={question}
                  rows={2}
                  placeholder={activeUnit ? `问第 ${activeUnit.ordinal + 1} 讲：哪里没听懂，或者要我换一种讲法…` : '问老师一句…'}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void sendQuestion()
                    }
                  }}
                />
              </div>
              <div className="ws-composer-tools">
                <div className="ws-mode">
                  <button className={mode === 'direct' ? 'active' : ''} onClick={() => setMode('direct')}>直接讲解</button>
                  <button className={mode === 'guided' ? 'active' : ''} onClick={() => setMode('guided')}>引导我</button>
                </div>
                <label className="ws-skill">
                  <span>技能：</span>
                  <select value={skill} onChange={(event) => setSkill(event.target.value as StudySkill)}>
                    <option value="auto">自动</option>
                    <option value="explain">讲解</option>
                    <option value="diagnose">诊断</option>
                    <option value="socratic">苏格拉底</option>
                    <option value="quiz">出题</option>
                    <option value="error">纠错</option>
                    <option value="review">复习</option>
                    <option value="teachback">复述</option>
                  </select>
                </label>
                <label className="ws-model" title="切换模型">
                  <i />
                  <select
                    value={modelName}
                    onChange={(event) => void changeModel(event.target.value)}
                    disabled={modelBusy}
                    aria-label="切换模型"
                  >
                    {modelOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                  <span className="ws-model-caret">⌄</span>
                </label>
                <span className="ws-mini-usage">课件 {tokenLabel(usageTotal)}</span>
                <button className="ws-send" aria-label="发送" onClick={() => void sendQuestion()} disabled={busy !== null || !question.trim()}>
                  {busy === 'send' ? '…' : '↑'}
                </button>
              </div>
            </div>
            <p className="ws-composer-note">Enter 发送 · Shift+Enter 换行 · 回答会对照这一讲的讲义页</p>
          </div>
        </main>
      )}

      {contextRail}
      {slidePeek ? (
        <PagePeek
          citation={slidePeek.citation}
          page={slidePeek.page}
          onClose={() => setSlidePeek(null)}
        />
      ) : null}
      {detail ? (
        <CourseMaterials
          open={materialsOpen}
          onClose={() => setMaterialsOpen(false)}
          detail={detail}
          busy={busy}
          notify={notify}
          toolFocus={toolFocus}
          onToolFocus={setToolFocus}
          onTool={runTool}
          unitOrdinal={activeUnit?.ordinal ?? null}
          onFinish={() => void finishCourse()}
          onNoteChange={(note) => setDetail((current) => current ? { ...current, teacherNote: note } : current)}
        />
      ) : null}
      {courseDialog ? (
        <CourseDialog
          mode={courseDialog.mode}
          initialName={courseDialog.name}
          busy={courseDialogBusy}
          onCancel={() => setCourseDialog(null)}
          onSubmit={(name) => void submitCourseDialog(name)}
        />
      ) : null}
      <TeacherProfile open={teacherOpen} onClose={() => setTeacherOpen(false)} notify={notify} onPersonaSaved={setTeacherName} />
    </div>
  )
}

/** 开场白和 unit_ordinal 为 null 的总览消息放在所有讲之前。 */
function overviewMessages(detail: StudySessionDetail): StudyMessage[] {
  return detail.messages.filter((message, index) => index === 0 || message.unitOrdinal == null)
}

/** 第一讲的消息要把开场白排除掉，否则开场白会落在第 1 讲里。 */
function messagesForUnit(detail: StudySessionDetail, unit: StudyUnit): StudyMessage[] {
  return detail.messages.filter((message, index) => index !== 0 && message.unitOrdinal === unit.ordinal)
}

function orphanMessages(detail: StudySessionDetail): StudyMessage[] {
  return detail.messages.filter((message, index) =>
    index !== 0
    && message.unitOrdinal != null
    && !detail.units.some((unit) => unit.ordinal === message.unitOrdinal),
  )
}

function ChatMessage({
  message,
  teacherName,
  latest,
  pages,
  pagesReady,
  onOpenPage,
}: {
  message: StudyMessage
  teacherName: string
  latest: boolean
  pages: PageView[]
  pagesReady: boolean
  onOpenPage: (citation: StudySlideCitation, page: PageView | null) => void
}) {
  if (message.role === 'user') {
    return (
      <div className="ws-message user">
        <div className="ws-message-main">
          <div className="ws-message-head user">
            <span>你</span>
            <span>{timeLabel(message.createdAt)}</span>
          </div>
          <div className="ws-bubble">
            <p><MathText text={message.content} /></p>
          </div>
        </div>
      </div>
    )
  }
  const citations = message.citations
  const cards = latest && pagesReady ? citations.slice(0, 2) : []
  const chips = latest && pagesReady ? citations.slice(2) : citations
  return (
    <div className="ws-message assistant">
      <span className="ws-avatar">师</span>
      <div className="ws-message-main">
        <div className="ws-message-head">
          <b>{teacherName || '老师'}</b>
          <span>{timeLabel(message.createdAt)}</span>
        </div>
        <div className="ws-bubble">
          <p><MathText text={message.content} /></p>
          {cards.length ? (
            <div className="ws-cites">
              {cards.map((citation) => (
                <CitationCard
                  key={`${message.id}-${citation.pageNumber}-${citation.quote.slice(0, 8)}`}
                  citation={citation}
                  page={pageForCitation(citation, pages)}
                  onOpen={(page) => onOpenPage(citation, page)}
                />
              ))}
              {chips.length ? (
                <div className="ws-cite-chips">
                  {chips.map((citation) => (
                    <button key={`${message.id}-chip-${citation.pageNumber}`} onClick={() => onOpenPage(citation, pageForCitation(citation, pages))}>
                      还有 p.{citation.pageNumber}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : chips.length ? (
            <div className="ws-cite-chips">
              {chips.map((citation) => (
                <button key={`${message.id}-chip-${citation.pageNumber}`} onClick={() => onOpenPage(citation, pageForCitation(citation, pages))}>
                  p.{citation.pageNumber}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function CitationCard({
  citation,
  page,
  onOpen,
}: {
  citation: StudySlideCitation
  page: PageView | null
  onOpen: (page: PageView | null) => void
}) {
  const image = page?.previewResourceId
  return (
    <article className="ws-cite">
      <button className="ws-cite-thumb" onClick={() => onOpen(page)} title={`打开第 ${citation.pageNumber} 页`}>
        {image ? (
          <>
            <img src={`app-resource://${image}`} alt={`第 ${citation.pageNumber} 页`} />
            {citation.bbox ? <span className="ws-cite-box" style={bboxStyle(citation.bbox)} /> : null}
          </>
        ) : (
          <span className="ws-cite-noimg">
            <b>p.{citation.pageNumber}</b>
            <small>这一页没有页面图</small>
          </span>
        )}
      </button>
      <div className="ws-cite-text">
        <div className="ws-cite-label">
          <span>对照讲义</span>
          <b>p.{citation.pageNumber}</b>
          <button className="ws-cite-open" onClick={() => onOpen(page)}>打开这一页 ↗</button>
        </div>
        <blockquote>{citation.quote}</blockquote>
        <p className="ws-cite-caption">
          {image
            ? (citation.bbox ? '整页图，黄框标出原句位置' : '整页图；这一句无法定位，直接保留原句')
            : '原句卡：这一页没有页面图'}
        </p>
      </div>
    </article>
  )
}

function PagePeek({
  citation,
  page,
  onClose,
}: {
  citation: StudySlideCitation
  page: PageView | null
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal ws-peek">
        <header>
          <div>
            <h2>对照讲义 p.{citation.pageNumber}</h2>
            <p className="quiet">
              {citation.bbox
                ? '整页原图，不裁剪；黄色框是老师刚才引用的位置。'
                : '整页原图，不裁剪；这一句没有可定位的框，下面保留原句。'}
            </p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}>×</button>
        </header>
        <div className="ws-peek-body">
          {page?.previewResourceId ? (
            <div className="ws-peek-image">
              <img src={`app-resource://${page.previewResourceId}`} alt={`第 ${citation.pageNumber} 页`} />
              {citation.bbox ? <span className="ws-cite-box" style={bboxStyle(citation.bbox)} /> : null}
            </div>
          ) : (
            <div className="ws-peek-noimg">这一页没有页面图，下面保留原句。</div>
          )}
          <blockquote>{citation.quote}</blockquote>
        </div>
      </div>
    </div>
  )
}

function LectureBlock({
  unit,
  checks,
  active,
  onSave,
}: {
  unit: StudyUnit
  checks: StudyCheck[]
  active: boolean
  onSave: (unitOrdinal: number, segmentIndex: number, answer: string) => Promise<boolean>
}) {
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [saving, setSaving] = useState<number | null>(null)
  const savedFor = (index: number) =>
    checks.find((check) => check.unitOrdinal === unit.ordinal && check.segmentIndex === index) ?? null

  async function submit(index: number) {
    const answer = (drafts[index] ?? savedFor(index)?.answer ?? '').trim()
    if (!answer) return
    setSaving(index)
    const ok = await onSave(unit.ordinal, index, answer)
    setSaving(null)
    if (ok) {
      setDrafts((current) => {
        const next = { ...current }
        delete next[index]
        return next
      })
    }
  }

  return (
    <article className={`ws-lecture${active ? ' active' : ''}`}>
      <div className="ws-segments">
        {unit.segments.map((segment, index) => {
          const saved = savedFor(index)
          const page = pageNumberFromSource(segment.source) ?? pageNumberFromSource(unit.source)
          return (
            <section key={`${unit.id}-${index}`} className="ws-segment ws-message assistant ws-lecture-msg">
              <span className="ws-avatar">师</span>
              <div className="ws-message-main">
                <div className="ws-message-head">
                  <b>老师</b>
                  <span>{index === 0 ? '这一讲讲稿' : `接着讲 · 第 ${index + 1} 段`}</span>
                </div>
                <div className="ws-bubble">
                  <p><MathText text={segment.explain} /></p>
                  {segment.source ? (
                    <div className="ws-lecture-cite">
                      {page ? <span className="ws-page-chip">p.{page}</span> : null}
                      <span className="ws-lecture-quote">{segment.source}</span>
                    </div>
                  ) : null}
                  {segment.check ? (
                    <details className="ws-check">
                      <summary>
                        <b>停一下</b>
                        <span><MathText text={segment.check} /></span>
                      </summary>
                      <div className="ws-check-body">
                        <textarea
                          rows={2}
                          value={drafts[index] ?? saved?.answer ?? ''}
                          placeholder="用自己的话答一句。写下来，学习总结才有证据判断你掌握到哪里。"
                          onChange={(event) => setDrafts((current) => ({ ...current, [index]: event.target.value }))}
                        />
                        <div className="ws-check-actions">
                          <button className="ghost" disabled={saving !== null} onClick={() => void submit(index)}>
                            {saving === index ? '正在记下…' : saved ? '改一下答案' : '记下我的答案'}
                          </button>
                          {saved ? <span className="quiet">已记录，会进入学习总结</span> : null}
                        </div>
                      </div>
                    </details>
                  ) : null}
                </div>
              </div>
            </section>
          )
        })}
      </div>
    </article>
  )
}

function ContextRail({
  detail,
  unit,
  open,
  busy,
  railBusy,
  railNote,
  reviewStats,
  onClose,
  onOpenMaterials,
  onReview,
  onCards,
  onQuiz,
  onOpenReview,
  onPersonalize,
}: {
  detail: StudySessionDetail
  unit: StudyUnit | null
  open: boolean
  busy: boolean
  railBusy: 'review' | 'cards' | null
  railNote: string
  reviewStats: ReviewSummary | null
  onClose: () => void
  onOpenMaterials: (focus: StudyToolKind | null) => void
  onReview: () => void
  onCards: () => void
  onQuiz: () => void
  onOpenReview: () => void
  onPersonalize: () => void
}) {
  const artifacts = detail.artifacts
    .filter((artifact) => unit && (artifact.scope === `unit:${unit.ordinal}` || artifact.scope === 'course'))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 4)
  const quiz = [...detail.artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find((artifact) => artifact.kind === 'quiz')
  const quizQuestions = quiz?.body.questions ?? []
  const questionCount = quizQuestions.length
  const note = detail.teacherNote
  const pointPages = unit?.segments.map((segment) => pageNumberFromSource(segment.source)) ?? []
  const fallbackPage = unit ? pageNumberFromSource(unit.source) : null
  const pageNumbers = [...new Set(pointPages.filter((page): page is number => page != null))]
  const pageRange = pageNumbers.length
    ? (pageNumbers.length === 1 ? `p.${pageNumbers[0]}` : `p.${Math.min(...pageNumbers)}–p.${Math.max(...pageNumbers)}`)
    : fallbackPage ? `p.${fallbackPage}` : ''
  const shortTitle = unit?.title.split(/[：:]/)[0] || detail.title
  return (
    <aside className={`ws-context${open ? ' open' : ''}`}>
      <header className="ws-context-head">
        <div className="ws-context-kicker">
          <span>这一讲</span>
          <span className="ws-pin">只看 · 跟着跳走</span>
          <button className="icon-btn ws-context-close" title="收起" onClick={onClose}>×</button>
        </div>
        <div className="ws-context-title">
          <span>{unit ? `第 ${unit.ordinal + 1} 讲` : '整份课件'}</span>
          <h3>{shortTitle}</h3>
        </div>
        <p className="ws-context-meta">
          {unit ? `讲义 ${pageRange || '见讲稿'} · 约 ${unit.minutes} 分钟` : `共 ${detail.units.length} 讲 · 约 ${detail.units.reduce((sum, item) => sum + item.minutes, 0)} 分钟`}
        </p>
      </header>

      <section className="ws-actions-card">
        <div className="ws-card-head">
          <h4>学习动作</h4>
          <span>一键就做</span>
        </div>
        <div className="ws-action-grid">
          <button disabled={busy || railBusy !== null} onClick={onReview}>
            <span>▤</span>
            <b>{railBusy === 'review' ? '正在生成…' : '复习资料'}</b>
            <small>总结 + 大纲</small>
          </button>
          <button disabled={busy || railBusy !== null} onClick={onCards}>
            <span>▦</span>
            <b>{railBusy === 'cards' ? '正在生成…' : '一键卡片'}</b>
            <small>从这一讲的知识点</small>
          </button>
          <button disabled={busy || railBusy !== null} onClick={onQuiz}>
            <span>◫</span>
            <b>题测</b>
            <small>{questionCount ? `${questionCount} 道题` : '先答后判'}</small>
          </button>
          <button disabled={busy || railBusy !== null} onClick={onOpenReview}>
            <span>↺</span>
            <b>错题本</b>
            <small>{reviewStats ? `${reviewStats.misses} 道错题` : '到点再练'}</small>
          </button>
          <button className="wide" disabled={busy || railBusy !== null} onClick={onPersonalize}>
            <span>◎</span>
            <b>个性化辅导</b>
            <small>按你的学习习惯，先找最该补的一块</small>
          </button>
        </div>
        {railNote ? <p className="ws-rail-note">{railNote}</p> : null}
      </section>

      <div className="ws-context-scroll">
        <section className="ws-context-section ws-context-card">
          <div className="ws-card-head">
            <h4>知识点</h4>
            <span>{unit?.keyPoints.length ?? 0} 条</span>
          </div>
          {unit?.keyPoints.length ? (
            <div className="ws-points">
              {unit.keyPoints.map((point, index) => (
                <div className="ws-point" key={point}>
                  <span className="ws-point-n">{String(index + 1).padStart(2, '0')}</span>
                  <p>{point}</p>
                  {pointPages[index] || fallbackPage ? <small>p.{pointPages[index] ?? fallbackPage}</small> : null}
                </div>
              ))}
            </div>
          ) : <p className="quiet">这一讲还没有单独列知识点。</p>}
        </section>

        {quizQuestions.length ? (
          <section className="ws-context-section ws-context-card ws-quiz-card">
            <div className="ws-card-head">
              <h4>这一讲的题</h4>
              <span>{quizQuestions.length} 道 · 先答后判</span>
            </div>
            <ol className="ws-quiz-list">
              {quizQuestions.map((question, index) => (
                <li key={question.id}>
                  <span>{index + 1}</span>
                  <p>{question.prompt}</p>
                </li>
              ))}
            </ol>
            <button className="ws-quiz-open" onClick={() => onOpenMaterials('quiz')}>去作答</button>
          </section>
        ) : null}

        <section className="ws-context-section ws-context-card">
          <div className="ws-card-head">
            <h4>老师手记</h4>
            <span>{note ? '已写下' : '空'}</span>
          </div>
          {note ? (
            <div className="ws-note-rows">
              <div className="ws-note-row">
                <span className="ok">讲通了</span>
                <p>{note.worked.slice(0, 2).join('；') || note.summary}</p>
              </div>
              {note.stuck.length ? (
                <div className="ws-note-row">
                  <span className="warn">还卡着</span>
                  <p>{note.stuck.slice(0, 2).join('；')}</p>
                </div>
              ) : null}
              {note.next.length ? (
                <div className="ws-note-row">
                  <span>下次先</span>
                  <p>{note.next.slice(0, 2).join('；')}</p>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="quiet">还没有手记。生成学习总结时，老师会一起写下这次课的四段手记。</p>
          )}
        </section>

        <section className="ws-context-section ws-context-card">
          <div className="ws-card-head">
            <h4>这一讲的生成物</h4>
            <span>{artifacts.length} 份</span>
          </div>
          {artifacts.length ? (
            <div className="ws-artifacts">
              {artifacts.map((artifact) => (
                <button className="ws-artifact-chip" key={artifact.id} onClick={() => onOpenMaterials(artifact.kind as StudyToolKind)}>
                  <span>{artifact.title}</span>
                  <small className="done">done</small>
                </button>
              ))}
            </div>
          ) : <p className="quiet">问老师「总结这讲 / 考考我 / 找原文」，生成物会出现在这里。</p>}
        </section>

        <section className="ws-context-section ws-context-card">
          <div className="ws-card-head">
            <h4>这份课件用量</h4>
            <span>按课件合计</span>
          </div>
          <UsageSummary usage={detail.usage} />
        </section>
      </div>

      <footer className="ws-context-brand">
        <b>灯下 · 本地优先</b>
        <span>没有账号，没有云同步</span>
      </footer>
    </aside>
  )
}

function UsageSummary({ usage }: { usage: StudyUsage }) {
  if (usage.calls === 0) return <p className="quiet">还没开始用模型。</p>
  const hit = usage.promptTokens > 0 ? Math.round((usage.cachedTokens / usage.promptTokens) * 100) : 0
  const missed = Math.max(0, usage.promptTokens - usage.cachedTokens)
  return (
    <div className="ws-usage-summary">
      <div className="ws-usage-line"><span>调用</span><b>{usage.calls} 次</b></div>
      <div className="ws-usage-line"><span>输入</span><b>{tokenLabel(usage.promptTokens)}</b><small>命中 {tokenLabel(usage.cachedTokens)} / 未命中 {tokenLabel(missed)}</small></div>
      <div className="ws-usage-line"><span>输出</span><b>{tokenLabel(usage.completionTokens)}</b><small>含推理 token</small></div>
      <div className="ws-usage-bar"><i style={{ width: `${Math.min(100, Math.max(0, hit))}%` }} /></div>
      <div className="ws-usage-foot">
        <span>缓存命中 {hit}%</span>
        <span>{usage.estimatedCalls > 0 ? `${usage.estimatedCalls} 次未回 usage` : '供应商已回传 usage'}</span>
      </div>
    </div>
  )
}

function CourseDialog({
  mode,
  initialName,
  busy,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'rename'
  initialName: string
  busy: boolean
  onCancel: () => void
  onSubmit: (name: string) => void
}) {
  const [name, setName] = useState(initialName)
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <div className="modal ws-course-dialog">
        <header>
          <div>
            <h2>{mode === 'create' ? '新建课程' : '给课程改名'}</h2>
            <p className="quiet">课程是左栏第一层；下面放课件，再下面才是讲。</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onCancel}>×</button>
        </header>
        <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) onSubmit(name.trim()) }}>
          <label className="study-field">
            <span>课程名</span>
            <input autoFocus value={name} maxLength={60} placeholder="例如：线性代数" onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="row ws-dialog-actions">
            <button type="button" className="ghost" onClick={onCancel} disabled={busy}>取消</button>
            <button type="submit" className="primary" disabled={busy || !name.trim()}>
              {busy ? '保存中…' : mode === 'create' ? '建这门课' : '保存新名字'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** 课程资料抽屉：整份课件的总览、学习总结、老师手记、工具和用量。 */
function CourseMaterials({
  open,
  onClose,
  detail,
  busy,
  notify,
  toolFocus,
  onToolFocus,
  onTool,
  unitOrdinal,
  onFinish,
  onNoteChange,
}: {
  open: boolean
  onClose: () => void
  detail: StudySessionDetail
  busy: Busy
  notify: Notify
  toolFocus: StudyToolKind | null
  onToolFocus: (tool: StudyToolKind | null) => void
  onTool: (tool: StudyToolKind, payload?: { query?: string; answer?: string; answers?: StudyQuizAnswer[] }) => Promise<boolean>
  unitOrdinal: number | null
  onFinish: () => void
  onNoteChange: (note: StudySessionDetail['teacherNote']) => void
}) {
  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="modal course-materials">
        <header>
          <div>
            <h2>整份课件资料</h2>
            <p className="quiet">总览、学习分析、老师手记、老师工具和用量都放在这里。</p>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}>×</button>
        </header>

        <div className="course-materials-body">
          <div className="course-materials-column">
            <section className="study-overview">
              <div className="study-outline-title">
                <h3>整份材料总览</h3>
                <span className="chip">开课时读懂</span>
              </div>
              <p>{detail.overview}</p>
              <div className="study-habit-stamp">
                <span className="chip">本次习惯</span>
                <p>{detail.habits.pace === 'slow' ? '讲透' : detail.habits.pace === 'exam' ? '抓考点' : '适中'} · {detail.habits.style === 'define' ? '先定义' : detail.habits.style === 'ask' ? '先提问' : '先比方'} · {detail.habits.minutes} 分钟</p>
              </div>
            </section>

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
                  <button className="primary" onClick={onFinish} disabled={busy !== null}>
                    {busy === 'finish' ? '正在分析这次学习…' : '生成学习分析总结'}
                  </button>
                </>
              )}
            </section>
          </div>

          <div className="course-materials-column">
            {detail.teacherNote ? (
              <TeacherNoteCard note={detail.teacherNote} notify={notify} onChange={onNoteChange} />
            ) : (
              <section className="study-teacher-note">
                <div className="study-outline-title">
                  <h3>老师手记</h3>
                  <span className="chip">下课写下</span>
                </div>
                <p className="quiet">还没有手记。生成学习分析总结时，老师会一起写下这次课的四段手记。</p>
              </section>
            )}
            <UsageCard usage={detail.usage} sessionId={detail.sessionId} />
          </div>

          <StudyTools
            detail={detail}
            unitOrdinal={unitOrdinal}
            focus={toolFocus}
            busy={busy}
            onFocus={onToolFocus}
            onRun={onTool}
          />
        </div>
      </div>
    </div>
  )
}

function linesOf(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 5)
}

function TeacherNoteCard({
  note,
  notify,
  onChange,
}: {
  note: NonNullable<StudySessionDetail['teacherNote']>
  notify: Notify
  onChange: (note: StudySessionDetail['teacherNote']) => void
}) {
  const api = window.desk
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [summary, setSummary] = useState(note.summary)
  const [worked, setWorked] = useState(note.worked.join('\n'))
  const [stuck, setStuck] = useState(note.stuck.join('\n'))
  const [next, setNext] = useState(note.next.join('\n'))

  useEffect(() => {
    if (editing) return
    setSummary(note.summary)
    setWorked(note.worked.join('\n'))
    setStuck(note.stuck.join('\n'))
    setNext(note.next.join('\n'))
  }, [note, editing])

  async function save() {
    if (!api) return
    if (!summary.trim()) {
      notify('bad', '老师手记的总览不能为空。')
      return
    }
    setSaving(true)
    const result = await api.teacher.saveNote({
      sessionId: note.sessionId,
      summary: summary.trim(),
      worked: linesOf(worked),
      stuck: linesOf(stuck),
      next: linesOf(next),
    })
    setSaving(false)
    if (!result.ok) { notify('bad', result.error.message); return }
    onChange(result.data)
    setEditing(false)
    notify('info', '老师手记已更新，下一次课会用新的版本。')
  }

  async function remove() {
    if (!api) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    const result = await api.teacher.deleteNote({ sessionId: note.sessionId })
    if (!result.ok) { notify('bad', result.error.message); return }
    onChange(null)
    notify('info', '老师手记已删除。学习总结不受影响。')
  }

  return (
    <section className="study-teacher-note">
      <div className="study-outline-title">
        <h3>老师手记</h3>
        {editing ? null : <span className="chip">下课写下</span>}
        <div className="teacher-note-actions">
          {editing ? (
            <>
              <button className="ghost" onClick={() => void save()} disabled={saving || !summary.trim()}>
                {saving ? '保存中…' : '保存'}
              </button>
              <button className="ghost" onClick={() => setEditing(false)} disabled={saving}>取消</button>
            </>
          ) : (
            <>
              <button className="ghost" onClick={() => setEditing(true)}>编辑</button>
              <button className="ghost danger-text" onClick={() => void remove()}>
                {confirmDelete ? '再点一次删除' : '删除'}
              </button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <div className="teacher-note-editor">
          <label className="study-field">
            <span>总览</span>
            <textarea rows={3} maxLength={1200} value={summary} onChange={(event) => setSummary(event.target.value)} />
          </label>
          <label className="study-field">
            <span>这次讲通了（一行一条）</span>
            <textarea rows={2} value={worked} onChange={(event) => setWorked(event.target.value)} />
          </label>
          <label className="study-field">
            <span>还卡着（一行一条）</span>
            <textarea rows={2} value={stuck} onChange={(event) => setStuck(event.target.value)} />
          </label>
          <label className="study-field">
            <span>下次先做（一行一条）</span>
            <textarea rows={2} value={next} onChange={(event) => setNext(event.target.value)} />
          </label>
        </div>
      ) : (
        <>
          <p>{note.summary}</p>
          {note.worked.length ? <SummaryGroup title="这次讲通了" items={note.worked} /> : null}
          {note.stuck.length ? <SummaryGroup title="还卡着" items={note.stuck} /> : null}
          {note.next.length ? <SummaryGroup title="下次先做" items={note.next} /> : null}
        </>
      )}
    </section>
  )
}

/** 这份课件真实花掉的 token 与缓存命中：整份合计，不按讲拆。 */
function UsageCard({ usage, sessionId }: { usage: StudySessionDetail['usage']; sessionId: string }) {
  const [audit, setAudit] = useState<StudyUsageAudit | null>(null)
  const [auditError, setAuditError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  if (!usage || usage.calls === 0) return null
  const api = window.desk
  if (!api) return null
  const hit = usage.promptTokens > 0 ? Math.round((usage.cachedTokens / usage.promptTokens) * 100) : 0
  const miss = usage.cacheMissTokens > 0 ? usage.cacheMissTokens : Math.max(0, usage.promptTokens - usage.cachedTokens)
  const check = async () => {
    setChecking(true)
    setAuditError(null)
    const result = await api.study.usageAudit({ sessionId })
    setChecking(false)
    if (result.ok) setAudit(result.data)
    else setAuditError(result.error.message)
  }
  return (
    <section className="study-usage">
      <div className="study-outline-title">
        <h3>这份课件用量</h3>
        <span className="chip">{usage.calls} 次调用</span>
      </div>
      <p>
        输入 {tokenLabel(usage.promptTokens)}（命中 {tokenLabel(usage.cachedTokens)} / 未命中 {tokenLabel(miss)}）
        · 输出 {tokenLabel(usage.completionTokens)} tokens
        {usage.reasoningTokens > 0 ? `（其中推理 ${tokenLabel(usage.reasoningTokens)}）` : ''}
      </p>
      <p className="study-usage-hit">
        前缀缓存命中 {tokenLabel(usage.cachedTokens)}（{hit}%）
        <span>{hit >= 40 ? '命中正常，同一讲里继续追问会更便宜' : '命中偏低：换讲、换技能或长间隔都会打断前缀缓存'}</span>
      </p>
      {usage.estimatedCalls > 0 ? (
        <p className="warning">
          有 {usage.estimatedCalls} 次调用没有返回 usage，这部分按 0 估算；真实消耗可能更高。其余
          {usage.reportedCalls} 次由供应商真实回传。
        </p>
      ) : (
        <p className="quiet">这 {usage.reportedCalls} 次调用都由供应商真实回传 usage，可直接与官方账单对账。</p>
      )}
      <div className="study-usage-actions">
        <button className="ghost" onClick={() => void check()} disabled={checking}>
          {checking ? '正在核对余额…' : '核对官方余额'}
        </button>
      </div>
      {auditError ? <p className="warning">{auditError}</p> : null}
      {audit ? (
        <div className="study-usage-audit">
          {audit.kinds.length ? (
            <div className="study-usage-kinds">
              {audit.kinds.map((row) => (
                <p key={row.kind}>
                  {usageKindLabel(row.kind)}：{row.calls} 次 · 输入 {tokenLabel(row.promptTokens)} · 输出 {tokenLabel(row.completionTokens)}
                  {row.estimatedCalls > 0 ? ` · 估算 ${row.estimatedCalls} 次` : ''}
                </p>
              ))}
            </div>
          ) : null}
          {audit.balance?.length ? (
            <p>
              官方余额：
              {audit.balance.map((item) => `${item.totalBalance} ${item.currency}（赠送 ${item.grantedBalance} / 充值 ${item.toppedUpBalance}）`).join('；')}
            </p>
          ) : (
            <p className="quiet">{audit.balanceError ?? '官方接口没有返回余额。'}</p>
          )}
          <p className="quiet">{audit.officialNote}</p>
        </div>
      ) : null}
    </section>
  )
}

function usageKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    chat: '讲解对话',
    plan: '开课拆课',
    'plan-repair': '拆课重试',
    digest: '分段理解',
    vision: '读图',
    ocr: 'OCR',
    summary: '学习总结',
    'teacher-note': '老师手记',
    'tool-summary': '工具总结',
    'tool-quiz': '题测出题',
    'tool-quiz-grade': '题测判题',
    'tool-teachback': '复述反馈',
  }
  return labels[kind] ?? kind
}

function SummaryView({ detail }: { detail: StudySessionDetail }) {
  const summary = detail.summary
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

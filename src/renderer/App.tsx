import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BlockView, DocumentDetail, DocumentListItem, JobChangedEvent, JobSnapshot, Locator, PageView, Prerequisites, PreviewFocus, ReviewSettingsView, StorageUsage, LibraryStats, BackupResult, ExportPayload } from '../shared/contract'
import type { UpdateDownloadProgress } from '../shared/app'
import { ReviewView } from './teaching/ReviewView'
import { StudyView } from './study/StudyView'
import type { AiConfigView } from '../shared/ai'
import { DEFAULT_AI } from '../shared/ai'
import type { ImageReading, AutoReadResult } from '../shared/images'
import type { PageResearch } from '../shared/research'
import type { SearchHit } from '../shared/search'
import type { HighlightView } from '../shared/highlights'
import { HighlightText } from './components/HighlightText'
import { MathText } from './components/MathText'
import { HelpGuide } from './components/HelpGuide'
import { FEATURE_LABELS } from './study/guide'

const STATE_LABEL: Record<string, string> = {
  queued: '排队',
  running: '处理中',
  succeeded: '完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  stored: '已保存',
  parsing: '解析中',
  ready: '可预览',
}

const FORMAT_LABEL: Record<string, string> = {
  pptx: 'PPTX',
  docx: 'DOCX',
  pdf: 'PDF',
  txt: 'TXT',
  markdown: 'Markdown',
  png: 'PNG',
  jpeg: 'JPEG',
}

const REVIEW_LABEL: Record<string, string> = {
  unverified: '未校验',
  needs_review: '需复核',
  user_verified: '已人工确认',
}

type Notice = { tone: 'info' | 'bad'; text: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 有 AI 读懂结果时只展示和讲解 AI 版本，本机 OCR 只在 AI 不可用时兜底。 */
function preferredReadings(items: ImageReading[]): ImageReading[] {
  const ai = items.filter((item) => item.kind === 'vision')
  return ai.length ? ai : items
}

async function loadAllPages(documentVersionId: string): Promise<PageView[]> {
  const pages: PageView[] = []
  let offset = 0
  const limit = 50
  for (;;) {
    const result = await window.desk!.documents.pages({ documentVersionId, offset, limit })
    if (!result.ok) throw new Error(result.error.message)
    pages.push(...result.data.items)
    offset += result.data.items.length
    if (offset >= result.data.total || result.data.items.length === 0) break
  }
  return pages
}

async function loadBlocks(body: { pageId?: string; documentVersionId?: string; scope?: 'unpaged' }): Promise<BlockView[]> {
  const blocks: BlockView[] = []
  let offset = 0
  const limit = 50
  for (;;) {
    const result = await window.desk!.documents.blocks({ ...body, offset, limit })
    if (!result.ok) throw new Error(result.error.message)
    blocks.push(...result.data.items)
    offset += result.data.items.length
    if (offset >= result.data.total || result.data.items.length === 0) break
  }
  return blocks
}

export function App() {
  const api = window.desk
  const [notice, setNotice] = useState<Notice | null>(null)
  const [prereq, setPrereq] = useState<Prerequisites | null>(null)
  const [docs, setDocs] = useState<DocumentListItem[]>([])
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<DocumentDetail | null>(null)
  const [pages, setPages] = useState<PageView[]>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [pageBlocks, setPageBlocks] = useState<BlockView[]>([])
  const [unpaged, setUnpaged] = useState<BlockView[]>([])
  const [focus, setFocus] = useState<PreviewFocus | null>(null)
  const [busy, setBusy] = useState(false)
  const [booting, setBooting] = useState(true)
  const [view, setView] = useState<'doc' | 'study' | 'review'>(() => {
    const requested = new URLSearchParams(location.search).get('view')
    if (requested === 'review') return 'review'
    if (requested === 'doc') return 'doc'
    if (requested === 'study' || requested === 'class') return 'study'
    return 'study'
  })
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])
  useEffect(() => {
    if (new URLSearchParams(location.search).get('help') === 'off') return
    try {
      if (window.localStorage.getItem('desk-help-seen-v1') !== '1') setHelpOpen(true)
    } catch {
      setHelpOpen(true)
    }
  }, [])
  const closeHelp = useCallback(() => {
    setHelpOpen(false)
    try {
      window.localStorage.setItem('desk-help-seen-v1', '1')
    } catch {
      // 本机存储不可用时，仍然让用户关掉当前弹层。
    }
  }, [])
  const showNotice = useCallback((tone: 'info' | 'bad', text: string) => setNotice({ tone, text }), [])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.tone === 'bad' ? 12000 : 8000)
    return () => window.clearTimeout(timer)
  }, [notice])
  const [aiOpen, setAiOpen] = useState(false)
  // 第一次打开先给一页“怎么用”，之后右上角“怎么用”随时能再打开。
  const [helpOpen, setHelpOpen] = useState(false)
  // 左侧文稿栏可收起：听课时把宽度让给讲稿。
  const [libraryOpen, setLibraryOpen] = useState(true)
  // 删除文稿是破坏性操作：先点「×」展开确认条，再点「确认删除」才真的删。
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  // 文稿整理：搜索、格式筛选、重命名与置顶。
  const [search, setSearch] = useState('')
  const [formatFilter, setFormatFilter] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const listFilter = useRef({ query: '', format: '' })
  // 顶栏全文搜索：和左侧「搜文稿名」分开，搜的是正文块。
  const [globalQuery, setGlobalQuery] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searchTotal, setSearchTotal] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchLoadingMore, setSearchLoadingMore] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [highlights, setHighlights] = useState<HighlightView[]>([])
  const [selection, setSelection] = useState<{ block: BlockView; start: number; end: number; quote: string; x: number; y: number } | null>(null)
  const [excerpt, setExcerpt] = useState<{ block: BlockView; quote: string; front: string; back: string } | null>(null)
  const [excerptBusy, setExcerptBusy] = useState(false)
  // 设置里的复习目标与本机数据。
  const [reviewForm, setReviewForm] = useState<ReviewSettingsView>({ cardsPerDay: 10, missesPerDay: 5, remind: true })
  const [storage, setStorage] = useState<StorageUsage | null>(null)
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [backup, setBackup] = useState<BackupResult | null>(null)
  const [appSettings, setAppSettings] = useState<import('../shared/data').AppSettingsView | null>(null)
  const [restorePreview, setRestorePreview] = useState<import('../shared/data').RestorePreview | null>(null)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [dataBusy, setDataBusy] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<UpdateDownloadProgress | null>(null)
  const [updateFile, setUpdateFile] = useState<string | null>(null)
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const [aiStatus, setAiStatus] = useState<AiConfigView | null>(null)
  const [aiForm, setAiForm] = useState<{ baseUrl: string; model: string; visionModel: string; apiKey: string }>({ baseUrl: DEFAULT_AI.baseUrl, model: DEFAULT_AI.model, visionModel: '', apiKey: '' })
  const [aiMessage, setAiMessage] = useState<Notice | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiModels, setAiModels] = useState<string[]>([])
  const [modelsBusy, setModelsBusy] = useState(false)
  const [appInfo, setAppInfo] = useState<{ version: string; name: string } | null>(null)
  const [updateResult, setUpdateResult] = useState<import('../shared/app').UpdateCheckResult | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [readings, setReadings] = useState<ImageReading[]>([])
  const [research, setResearch] = useState<PageResearch[]>([])
  const [autoStatuses, setAutoStatuses] = useState<Record<string, AutoReadResult>>({})
  const [autoProgress, setAutoProgress] = useState<{ done: number; total: number; ordinal: number } | null>(null)
  const autoRunning = useRef<{ versionId: string; token: number } | null>(null)
  const autoToken = useRef(0)
  const activeVersion = useRef<string | null>(null)
  const studyAutoOpen = useRef<string | null>(null)

  const refreshList = useCallback(async () => {
    if (!window.desk) return
    const result = await window.desk.documents.list({
      offset: 0,
      limit: 100,
      query: listFilter.current.query || undefined,
      format: listFilter.current.format || undefined,
    })
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setDocs(result.data.items)
    setTotal(result.data.total)
  }, [])

  const openVersion = useCallback(async (documentVersionId: string, preferredPage?: number, autoRead = true) => {
    if (!window.desk) return
    const [got, loadedPages, loose, imageReadings, researchItems, highlightItems] = await Promise.all([
      window.desk.documents.get({ documentVersionId }),
      loadAllPages(documentVersionId),
      loadBlocks({ documentVersionId, scope: 'unpaged' }),
      window.desk.images.readings({ documentVersionId }),
      window.desk.research.list({ documentVersionId }),
      window.desk.documents.highlights({ documentVersionId }),
    ])
    if (!got.ok) {
      setNotice({ tone: 'bad', text: got.error.message })
      return
    }
    setSelected(documentVersionId)
    activeVersion.current = documentVersionId
    setDetail(got.data)
    setPages(loadedPages)
    setUnpaged(loose)
    setReadings(imageReadings.ok ? imageReadings.data.items : [])
    setResearch(researchItems.ok ? researchItems.data.items : [])
    setHighlights(highlightItems.ok ? highlightItems.data.items : [])
    setSelection(null)
    setAutoStatuses({})
    const nextIndex = preferredPage ? Math.max(0, loadedPages.findIndex((page) => page.ordinal === preferredPage)) : 0
    setPageIndex(nextIndex < 0 ? 0 : nextIndex)
    if (autoRead) void autoReadVersion(documentVersionId)
  }, [])

  const openSearchHit = useCallback(async (hit: SearchHit) => {
    setSearchOpen(false)
    setView('doc')
    await openVersion(hit.documentVersionId, hit.pageNumber ?? undefined)
    setFocus({
      documentVersionId: hit.documentVersionId,
      pageId: hit.pageId ?? undefined,
      pageNumber: hit.pageNumber ?? undefined,
      blockId: hit.blockId,
    })
    window.setTimeout(() => {
      document.getElementById(`block-${hit.blockId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 260)
  }, [openVersion])

  async function loadMoreSearch() {
    if (!api || searchBusy || searchLoadingMore || searchHits.length >= searchTotal) return
    const query = globalQuery.trim()
    if (!query) return
    setSearchLoadingMore(true)
    const result = await api.documents.search({ query, limit: 20, offset: searchHits.length })
    setSearchLoadingMore(false)
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setSearchHits((current) => {
      const seen = new Set(current.map((hit) => `${hit.documentVersionId}:${hit.blockId}`))
      return [...current, ...result.data.items.filter((hit) => !seen.has(`${hit.documentVersionId}:${hit.blockId}`))]
    })
    setSearchTotal(result.data.total)
  }

  useEffect(() => {
    if (!api) {
      setBooting(false)
      return
    }
    void (async () => {
      const status = await api.prerequisites.get()
      if (status.ok) setPrereq(status.data)
      else setNotice({ tone: 'bad', text: status.error.message })
      const ai = await api.ai.status()
      if (ai.ok) {
        setAiStatus(ai.data)
        if (ai.data.baseUrl) {
          setAiForm((current) => ({ ...current, baseUrl: ai.data.baseUrl, model: ai.data.model || current.model, visionModel: ai.data.visionModel || current.visionModel }))
        }
      }
      await refreshList()
      setBooting(false)
    })()
    const offJob = api.jobs.onChanged((event: JobChangedEvent) => {
      setDocs((current) => current.map((item) => item.job?.jobId === event.jobId ? { ...item, job: { ...item.job, ...event, jobId: event.jobId } } : item))
      setDetail((current) => {
        if (!current || current.job?.jobId !== event.jobId) return current
        return { ...current, job: { ...(current.job ?? { jobId: event.jobId, error: undefined }), ...event, jobId: event.jobId } }
      })
      if (event.state !== 'queued' && event.state !== 'running') {
        void refreshList()
        setSelected((current) => {
          if (current) void openVersion(current, undefined, viewRef.current === 'doc')
          return current
        })
      }
    })
    const offFocus = api.preview.onFocus((next) => {
      setFocus(next)
      setSelected((current) => {
        if (current !== next.documentVersionId) void openVersion(next.documentVersionId, next.pageNumber)
        return next.documentVersionId
      })
      if (next.pageNumber) {
        setPages((current) => {
          const index = current.findIndex((page) => page.ordinal === next.pageNumber)
          if (index >= 0) setPageIndex(index)
          return current
        })
      }
    })
    return () => {
      offJob()
      offFocus()
    }
  }, [api, openVersion, refreshList])

  // 输入停顿 250ms 再查库；格式切换立即刷新。
  useEffect(() => {
    if (!api || booting) return
    const timer = window.setTimeout(() => void refreshList(), search ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [api, booting, search, formatFilter, refreshList])

  useEffect(() => {
    if (!api) return
    const query = globalQuery.trim()
    if (!query) {
      setSearchHits([])
      setSearchTotal(0)
      setSearchBusy(false)
      return
    }
    let alive = true
    setSearchBusy(true)
    const timer = window.setTimeout(() => {
      void api.documents.search({ query, limit: 20, offset: 0 }).then((result) => {
        if (!alive) return
        setSearchBusy(false)
        if (!result.ok) {
          setSearchHits([])
          setSearchTotal(0)
          return
        }
        setSearchHits(result.data.items)
        setSearchTotal(result.data.total)
      })
    }, 250)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [api, globalQuery])

  useEffect(() => {
    if (!api) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
        searchRef.current?.focus()
      }
      if (event.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api])

  useEffect(() => {
    if (!api) return
    const off = api.app.onUpdateProgress(setUpdateProgress)
    return () => {
      off()
    }
  }, [api])

  useEffect(() => {
    if (booting || view !== 'study' || selected || docs.length === 0) return
    const versionId = docs[0].documentVersionId
    if (studyAutoOpen.current === versionId) return
    studyAutoOpen.current = versionId
    void openVersion(versionId, undefined, false)
  }, [booting, view, selected, docs, openVersion])

  useEffect(() => {
    const page = pages[pageIndex]
    if (!page || !window.desk) {
      setPageBlocks([])
      return
    }
    void loadBlocks({ pageId: page.pageId }).then(setPageBlocks).catch((error: Error) => setNotice({ tone: 'bad', text: error.message }))
  }, [pages, pageIndex])

  const page = pages[pageIndex] ?? null
  const activeJob = detail?.job ?? null
  const invalidHighlights = highlights.filter((item) => !item.valid)

  async function importFiles(): Promise<string | null> {
    if (!window.desk) return null
    setBusy(true)
    const picked = await window.desk.documents.pick()
    if (!picked.ok) {
      setNotice({ tone: 'bad', text: picked.error.message })
      setBusy(false)
      return null
    }
    if (picked.data.cancelled) {
      setNotice({ tone: 'info', text: '没有选择文件。' })
      setBusy(false)
      return null
    }
    let last: string | null = null
    for (const file of picked.data.files) {
      const result = await window.desk.documents.import({ handle: file.handle, requestId: crypto.randomUUID() })
      if (!result.ok) setNotice({ tone: 'bad', text: `${file.name}：${result.error.message}` })
      else {
        last = result.data.documentVersionId
        if (result.data.duplicate) setNotice({ tone: 'info', text: `《${file.name}》之前导入过，已直接打开原稿，没有重复入库。` })
      }
    }
    await refreshList()
    if (last) await openVersion(last, undefined, view !== 'study')
    setBusy(false)
    return last
  }

  async function togglePin(item: DocumentListItem) {
    if (!window.desk) return
    const result = await window.desk.documents.pin({ documentVersionId: item.documentVersionId, pinned: !item.pinned })
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    await refreshList()
    setNotice({ tone: 'info', text: result.data.pinned ? `《${item.displayName}》已置顶。` : `《${item.displayName}》已取消置顶。` })
  }

  function startRename(item: DocumentListItem) {
    setRenamingId(item.documentVersionId)
    setRenameText(item.displayName)
  }

  async function submitRename(item: DocumentListItem) {
    if (!window.desk || !renameText.trim()) return
    const result = await window.desk.documents.rename({ documentVersionId: item.documentVersionId, displayName: renameText.trim() })
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setRenamingId(null)
    setDetail((current) => (current && current.documentVersionId === item.documentVersionId ? { ...current, displayName: result.data.displayName } : current))
    await refreshList()
    setNotice({ tone: 'info', text: `已改名为《${result.data.displayName}》。` })
  }

  async function deleteDocument(item: DocumentListItem) {
    if (!window.desk || deleting) return
    setDeleting(true)
    const result = await window.desk.documents.delete({ documentVersionId: item.documentVersionId })
    setDeleting(false)
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    if (selected === item.documentVersionId) {
      // 先让自动读懂循环失效，再清空详情，避免它继续往已删的文稿上写。
      autoToken.current += 1
      activeVersion.current = null
      autoRunning.current = null
      setSelected(null)
      setDetail(null)
      setPages([])
      setPageIndex(0)
      setPageBlocks([])
      setUnpaged([])
      setReadings([])
      setResearch([])
      setFocus(null)
      setAutoStatuses({})
    }
    if (renamingId === item.documentVersionId) setRenamingId(null)
    setConfirmDeleteId(null)
    await refreshList()
    setNotice({ tone: 'info', text: `《${item.displayName}》已删除。` })
  }

  async function openAi() {
    setAiOpen(true)
    setAiMessage(null)
    setAiModels([])
    if (!api) return
    const status = await api.ai.status()
    if (status.ok) {
      setAiStatus(status.data)
      setAiForm((current) => ({
        baseUrl: status.data.baseUrl || current.baseUrl,
        model: status.data.model || current.model,
        visionModel: status.data.visionModel || current.visionModel,
        apiKey: '',
      }))
    }
    const info = await api.app.info()
    if (info.ok) setAppInfo(info.data)
    const [review, usage, overview, dataSettings] = await Promise.all([api.review.settings(), api.data.storage(), api.data.stats(), api.data.settings()])
    if (review.ok) setReviewForm(review.data)
    if (usage.ok) setStorage(usage.data)
    if (overview.ok) setStats(overview.data)
    if (dataSettings.ok) setAppSettings(dataSettings.data)
  }

  async function checkUpdate() {
    if (!api || updateBusy) return
    setUpdateBusy(true)
    setUpdateResult(null)
    setUpdateFile(null)
    setUpdateProgress(null)
    const result = await api.app.checkUpdate()
    if (result.ok) setUpdateResult(result.data)
    setUpdateBusy(false)
  }

  async function saveReviewGoal() {
    if (!api) return
    setDataBusy(true)
    const result = await api.review.saveSettings(reviewForm)
    setDataBusy(false)
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setReviewForm(result.data)
    setNotice({ tone: 'info', text: `复习计划已保存：每天 ${result.data.cardsPerDay} 张卡、${result.data.missesPerDay} 道错题。` })
  }

  async function saveDataSettings(patch: import('../shared/data').SaveAppSettingsBody) {
    if (!api || dataBusy) return
    setDataBusy(true)
    const result = await api.data.saveSettings(patch)
    setDataBusy(false)
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setAppSettings(result.data)
  }

  async function chooseBackupDirectory() {
    if (!api || dataBusy) return
    setDataBusy(true)
    const picked = await api.data.pickBackupDir()
    setDataBusy(false)
    if (!picked.ok || !picked.data.path) return
    await saveDataSettings({ backup: { enabled: true, directory: picked.data.path } })
    setNotice({ tone: 'info', text: '自动备份位置已保存。' })
  }

  async function inspectRestore() {
    if (!api || restoreBusy) return
    setRestoreBusy(true)
    const result = await api.data.inspectRestore()
    setRestoreBusy(false)
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setRestorePreview(result.data)
  }

  async function applyRestore() {
    if (!api || !restorePreview || restoreBusy) return
    setRestoreBusy(true)
    const result = await api.data.applyRestore({ token: restorePreview.token })
    setRestoreBusy(false)
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setRestorePreview(null)
    setNotice({ tone: 'info', text: `已恢复 ${result.data.counts.documents} 份文稿、${result.data.counts.pages} 页；应用会自己重启。` })
  }

  async function backupLibrary() {
    if (!api || dataBusy) return
    setDataBusy(true)
    const result = await api.data.backup()
    setDataBusy(false)
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setBackup(result.data)
    setNotice({ tone: 'info', text: `已备份 ${result.data.files} 个文件（${formatBytes(result.data.bytes)}）到 ${result.data.path}` })
  }

  async function downloadUpdate() {
    if (!api || !updateResult?.assetUrl || !updateResult.assetName || updateDownloading) return
    setUpdateDownloading(true)
    setUpdateProgress({ received: 0, total: updateResult.assetSize ?? 0, percent: 0 })
    const result = await api.app.downloadUpdate({
      assetUrl: updateResult.assetUrl,
      assetName: updateResult.assetName,
      assetSize: updateResult.assetSize,
    })
    setUpdateDownloading(false)
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setUpdateFile(result.data.filePath)
    setNotice({ tone: 'info', text: `安装包已下载（${formatBytes(result.data.size)}），点「打开安装包」覆盖安装即可。` })
  }

  async function openDownloadedUpdate() {
    if (!api || !updateFile) return
    const result = await api.app.openUpdate({ filePath: updateFile })
    if (!result.ok) setNotice({ tone: 'bad', text: result.error.message })
  }

  async function exportCards() {
    if (!api) return
    const result = await api.teaching.exportCards()
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    await saveExport(result.data)
  }

  async function exportMisses() {
    if (!api) return
    const result = await api.teaching.exportMisses()
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    await saveExport(result.data)
  }

  async function saveExport(payload: ExportPayload) {
    if (!api) return
    const result = await api.app.saveText(payload)
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    if (result.data.saved) setNotice({ tone: 'info', text: `已导出：${result.data.path}` })
  }

  async function saveAi(test: boolean) {
    if (!api) return
    setAiBusy(true)
    const saved = await api.ai.saveConfig(aiForm)
    if (!saved.ok) {
      setAiBusy(false)
      setAiMessage({ tone: 'bad', text: saved.error.message })
      return
    }
    setAiStatus(saved.data)
    setAiForm((current) => ({ ...current, apiKey: '' }))
    if (selected) void autoReadVersion(selected, true)
    if (!test) {
      setAiBusy(false)
      setAiMessage({ tone: 'info', text: '模型配置已保存在这台电脑上。' })
      return
    }
    const tested = await api.ai.test()
    setAiBusy(false)
    if (!tested.ok) setAiMessage({ tone: 'bad', text: tested.error.message })
    else setAiMessage({ tone: 'info', text: `模型连上了：${tested.data.reply}` })
  }

  async function fetchModels() {
    if (!api) return
    setModelsBusy(true)
    const result = await api.ai.models({ baseUrl: aiForm.baseUrl, apiKey: aiForm.apiKey })
    setModelsBusy(false)
    if (!result.ok) {
      setAiMessage({ tone: 'bad', text: result.error.message })
      return
    }
    setAiModels(result.data.models)
    setAiForm((current) =>
      result.data.models.includes(current.model) ? current : { ...current, model: result.data.models[0] },
    )
    setAiMessage({ tone: 'info', text: `拉到 ${result.data.models.length} 个模型，选一个再保存。` })
  }

  async function autoReadVersion(versionId: string, force = false) {
    if (!api) return
    const running = autoRunning.current
    if (!force && running?.versionId === versionId) return
    const token = ++autoToken.current
    autoRunning.current = { versionId, token }
    try {
      for (let i = 0; i < 80; i++) {
        if (autoToken.current !== token || activeVersion.current !== versionId) return
        const got = await api.documents.get({ documentVersionId: versionId })
        if (!got.ok) return
        const state = got.data.job?.state
        if (!state || (state !== 'queued' && state !== 'running')) break
        await sleep(750)
      }
      const loaded = await loadAllPages(versionId)
      if (!loaded.length || autoToken.current !== token || activeVersion.current !== versionId) return
      const ai = await api.ai.status()
      const configured = Boolean(ai.ok && ai.data.configured)
      const errors: string[] = []
      setAutoProgress({ done: 0, total: loaded.length, ordinal: loaded[0].ordinal })
      for (let i = 0; i < loaded.length; i++) {
        if (autoToken.current !== token || activeVersion.current !== versionId) break
        const item = loaded[i]
        setAutoProgress({ done: i, total: loaded.length, ordinal: item.ordinal })
        const result = await api.images.auto({ documentVersionId: versionId, pageId: item.pageId })
        if (!result.ok) {
          errors.push(`第 ${item.ordinal} 页：${result.error.message}`)
        } else {
          setAutoStatuses((current) => ({ ...current, [item.pageId]: result.data }))
          for (const message of result.data.errors) errors.push(`第 ${item.ordinal} 页：${message}`)
        }
        const [reads, researches] = await Promise.all([
          api.images.readings({ documentVersionId: versionId }),
          api.research.list({ documentVersionId: versionId }),
        ])
        if (activeVersion.current === versionId) {
          if (reads.ok) setReadings(reads.data.items)
          if (researches.ok) setResearch(researches.data.items)
        }
      }
      if (activeVersion.current === versionId && autoToken.current === token) {
        if (!configured) {
          showNotice('info', '已用本机 OCR 兜底识别。填好模型后重新打开文稿，会自动让 AI 读懂和查证。')
        } else if (errors.length) {
          showNotice('info', `自动读懂完成，有 ${errors.length} 处辅助信息没补上：${errors[0]}。讲稿和页证据不受影响。`)
        } else {
          showNotice('info', `已自动读懂 ${loaded.length} 页：AI 知识点、联网核对都完成。`)
        }
      }
    } catch (error) {
      if (activeVersion.current === versionId && autoToken.current === token) {
        showNotice('bad', `自动读懂失败：${error instanceof Error ? error.message : '未知错误'}`)
      }
    } finally {
      if (autoToken.current === token) {
        autoRunning.current = null
        setAutoProgress(null)
      }
    }
  }

  async function retryAutoPage() {
    if (!api || !detail || !page) return
    setAutoProgress({ done: pageIndex, total: pages.length, ordinal: page.ordinal })
    try {
      const result = await api.images.auto({ documentVersionId: detail.documentVersionId, pageId: page.pageId })
      if (!result.ok) {
        showNotice('bad', result.error.message)
        return
      }
      setAutoStatuses((current) => ({ ...current, [page.pageId]: result.data }))
      const [reads, researches] = await Promise.all([
        api.images.readings({ documentVersionId: detail.documentVersionId }),
        api.research.list({ documentVersionId: detail.documentVersionId }),
      ])
      if (reads.ok) setReadings(reads.data.items)
      if (researches.ok) setResearch(researches.data.items)
      showNotice(result.data.errors.length ? 'bad' : 'info', result.data.errors[0] ?? '这一页已自动读懂。')
    } finally {
      setAutoProgress(null)
    }
  }

  async function chooseOffice() {
    if (!window.desk) return
    setBusy(true)
    const result = await window.desk.prerequisites.pickLibreOffice()
    setBusy(false)
    if (!result.ok) setNotice({ tone: 'bad', text: result.error.message })
    else setPrereq(result.data)
  }

  async function recheckOffice() {
    if (!window.desk) return
    setBusy(true)
    const result = await window.desk.prerequisites.recheck()
    setBusy(false)
    if (!result.ok) setNotice({ tone: 'bad', text: result.error.message })
    else {
      setPrereq(result.data)
      setNotice({ tone: 'info', text: result.data.libreOffice.message })
    }
  }

  async function cancelJob(job: JobSnapshot) {
    if (!window.desk) return
    const result = await window.desk.jobs.cancel({ jobId: job.jobId })
    if (!result.ok) setNotice({ tone: 'bad', text: result.error.message })
  }

  async function retryJob(job: JobSnapshot) {
    if (!window.desk) return
    const result = await window.desk.jobs.retry({ jobId: job.jobId, requestId: crypto.randomUUID() })
    if (!result.ok) setNotice({ tone: 'bad', text: result.error.message })
    else setNotice({ tone: 'info', text: '已重新排队。' })
  }

  async function locate(locator: Locator) {
    if (!window.desk) return
    const result = await window.desk.documents.openSource(locator)
    if (!result.ok) setNotice({ tone: 'bad', text: result.error.message })
    else if (!result.data.opened) setNotice({ tone: 'info', text: '内部预览没有定位到这个来源。' })
  }

  async function addHighlight() {
    if (!api || !selection || !selected) return
    const result = await api.documents.createHighlight({
      documentVersionId: selected,
      pageId: selection.block.locator.pageId ?? null,
      blockId: selection.block.blockId,
      startOffset: selection.start,
      endOffset: selection.end,
    })
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setHighlights((current) => [...current, result.data])
    setSelection(null)
  }

  async function removeHighlight(id: string) {
    if (!api) return
    const result = await api.documents.deleteHighlight({ id })
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setHighlights((current) => current.filter((item) => item.id !== id))
  }

  async function cleanupInvalidHighlights() {
    if (!api || !selected) return
    const result = await api.documents.cleanupHighlights({ documentVersionId: selected })
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setHighlights((current) => current.filter((item) => item.valid))
    setNotice({ tone: 'info', text: `已清理 ${result.data.deleted} 处失效高亮。` })
  }

  function startExcerpt() {
    if (!selection) return
    setExcerpt({ block: selection.block, quote: selection.quote, front: selection.quote, back: '' })
    setSelection(null)
  }

  async function saveExcerpt() {
    if (!api || !excerpt || !selected) return
    const front = excerpt.front.trim()
    if (!front) {
      setNotice({ tone: 'bad', text: '卡正面不能为空。' })
      return
    }
    setExcerptBusy(true)
    const result = await api.teaching.cards.create({
      front,
      back: excerpt.back.trim(),
      quote: excerpt.quote,
      documentVersionId: selected,
      pageId: excerpt.block.locator.pageId ?? null,
    })
    setExcerptBusy(false)
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setExcerpt(null)
    setNotice({ tone: 'info', text: `已做成复习卡，会进入「${FEATURE_LABELS.review}」。` })
  }

  const outline = useMemo(() => [...unpaged, ...pageBlocks], [unpaged, pageBlocks])
  const pageReadings = page ? preferredReadings(readings.filter((item) => item.pageId === page.pageId)) : []
  const pageResearch = page ? research.find((item) => item.pageId === page.pageId) : undefined
  const pageAuto = page ? autoStatuses[page.pageId] : undefined

  if (!api) {
    return (
      <main className="sheet" style={{ margin: 24 }}>
        <h2>灯下需要在桌面窗口里运行</h2>
        <p>这个页面是 Electron 渲染进程。单独用浏览器打开时没有本机文件选择和数据库，也不会假装导入成功。</p>
      </main>
    )
  }

  const teacherShell = view === 'study' || view === 'review'
  return (
    <div className={`app${teacherShell ? ' teacher-app' : ''}`}>
      <div className="top-stack">
        <header className="top">
          <div className="brand">
            <div className="brand-title">
              <svg className="brand-logo" viewBox="0 0 24 24" aria-hidden="true">
                <path style={{ fill: 'var(--c-primary)' }} d="M9 2.5h6v2h-2v4.1a6 6 0 0 1 4.2 5.7v2.2H6.8v-2.2a6 6 0 0 1 4.2-5.7V4.5H9v-2z" />
                <path style={{ fill: 'var(--c-warning)' }} d="M11 15.6h2v2.2h-2z" />
                <path style={{ fill: 'var(--c-primary-deep)' }} d="M10.2 18.6h3.6l-.5 2.2h-2.6z" />
              </svg>
              <strong>灯下</strong>
            </div>
            <span>本地文稿 · 完整读懂、按习惯拆课、逐句讲解与学习总结</span>
          </div>
          <div className="top-side">
            <div className="row">
              <nav className="tabs">
                <button className={`tab ${view === 'doc' ? 'active' : ''}`} title="按课件原样阅读、搜索和看页码" onClick={() => setView('doc')}>课件库</button>
                <button className={`tab ${view === 'study' ? 'active' : ''}`} title="跟老师一讲一讲地学" onClick={() => setView('study')}>课堂</button>
                <button className={`tab ${view === 'review' ? 'active' : ''}`} title="复习今天该复习的卡片和课堂错题" onClick={() => setView('review')}>{FEATURE_LABELS.review}</button>
              </nav>
              <button className="ghost" onClick={() => void openAi()}>模型设置{aiStatus?.configured ? ' · 已配置' : aiStatus ? ' · 未配置' : ''}</button>
              <button className="ghost" onClick={() => setHelpOpen(true)} title="打开使用指南">怎么用</button>
            </div>
            <p className="quiet">没有账号，没有云同步；模型只用你自己填的那一个。</p>
          </div>
        </header>
        <div className="top-search">
          <span className="top-search-icon" aria-hidden="true">⌕</span>
          <input
            ref={searchRef}
            value={globalQuery}
            onChange={(event) => {
              setGlobalQuery(event.target.value)
              setSearchOpen(true)
            }}
            onFocus={() => setSearchOpen(true)}
            placeholder="搜正文和页面文字…"
            spellCheck={false}
            aria-label="全文搜索"
          />
          <span className="top-search-key">Ctrl K</span>
          {searchOpen && (globalQuery.trim() || searchBusy) ? (
            <div className="search-panel">
              <div className="search-panel-head">
                <span>{searchBusy ? '正在找…' : searchTotal ? `找到 ${searchTotal} 处` : '没有找到'}</span>
                <button className="link-btn" onClick={() => setSearchOpen(false)}>关闭</button>
              </div>
              {!searchBusy && searchTotal === 0 ? (
                <p className="empty">换一个词试试。搜索只查正文块和页面文字；卡片、摘录和 AI 知识点暂不进入结果。</p>
              ) : null}
              {searchHits.map((hit) => (
                <button key={`${hit.blockId}-${hit.snippet}`} className="search-hit" onClick={() => void openSearchHit(hit)}>
                  <span className="search-hit-title">{hit.displayName}<small>{hit.pageNumber ? `第 ${hit.pageNumber} 页` : '未分页'}</small></span>
                  <span className="search-hit-snippet">{hit.snippet}</span>
                </button>
              ))}
              {searchHits.length > 0 && searchHits.length < searchTotal ? (
                <button className="ghost search-more" disabled={searchLoadingMore} onClick={() => void loadMoreSearch()}>
                  {searchLoadingMore ? '加载中…' : `加载更多（已显示 ${searchHits.length} / ${searchTotal}）`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {notice ? <div className={`banner ${notice.tone === 'bad' ? 'bad' : 'info'}`}>{notice.text}</div> : null}
      </div>
      <div className={`shell ${view === 'doc' ? '' : 'two'}${libraryOpen ? '' : ' library-collapsed'}${teacherShell ? ' teacher-only' : ''}`}>
        <aside className={`panel library${libraryOpen ? '' : ' collapsed'}`}>
          {libraryOpen ? (
            <>
              <header>
                <h2>文稿</h2>
                <div className="row" style={{ gap: 6 }}>
                  <button className="primary" onClick={() => void importFiles()} disabled={busy}>导入</button>
                  <button className="icon-btn" title="收起文稿栏" onClick={() => setLibraryOpen(false)}>‹</button>
                </div>
              </header>
              <div className="doc-search">
                <input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value)
                    listFilter.current.query = event.target.value.trim()
                  }}
                  placeholder="搜文稿名…"
                  spellCheck={false}
                  aria-label="搜索文稿"
                />
                <select
                  value={formatFilter}
                  onChange={(event) => {
                    setFormatFilter(event.target.value)
                    listFilter.current.format = event.target.value
                  }}
                  aria-label="按格式筛选"
                >
                  <option value="">全部格式</option>
                  {Object.entries(FORMAT_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <p className="doc-count">
                {search || formatFilter ? `找到 ${total} 份` : `共 ${total} 份`}
                {search || formatFilter ? <button className="link-btn" onClick={() => { setSearch(''); setFormatFilter(''); listFilter.current = { query: '', format: '' } }}>清除筛选</button> : null}
              </p>
              <div className="doc-list">
                {booting ? <p className="empty">正在读取本机文库…</p> : null}
                {!booting && docs.length === 0 ? (
                  <p className="empty">
                    {search || formatFilter
                      ? '没有匹配的文稿。换个关键词，或点「清除筛选」。'
                      : '还没有文稿。可以选择 PPTX、DOCX、PDF、TXT、Markdown 或图片。文件只留在这台电脑上。'}
                  </p>
                ) : null}
                {docs.map((item) => (
                  <div key={item.documentVersionId} className={`doc-item ${selected === item.documentVersionId ? 'active' : ''}`}>
                    <button className={`doc ${selected === item.documentVersionId ? 'active' : ''}`} onClick={() => void openVersion(item.documentVersionId)}>
                      <b>{item.pinned ? '★ ' : ''}{item.displayName}</b>
                      <small>{FORMAT_LABEL[item.format] ?? item.format} · {STATE_LABEL[item.job?.state ?? item.status] ?? item.status}</small>
                    </button>
                    {renamingId === item.documentVersionId ? (
                      <form
                        className="doc-rename"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void submitRename(item)
                        }}
                      >
                        <input
                          value={renameText}
                          onChange={(event) => setRenameText(event.target.value)}
                          maxLength={120}
                          autoFocus
                          aria-label="新的文稿名"
                        />
                        <button className="primary" type="submit" disabled={!renameText.trim()}>保存</button>
                        <button className="ghost" type="button" onClick={() => setRenamingId(null)}>取消</button>
                      </form>
                    ) : (
                      <div className="doc-tools">
                        <button className="doc-act" title={item.pinned ? '取消置顶' : '置顶'} onClick={() => void togglePin(item)} disabled={deleting}>
                          {item.pinned ? '★' : '☆'}
                        </button>
                        <button className="doc-act" title="重命名" onClick={() => startRename(item)} disabled={deleting}>改</button>
                        <button
                          className={`doc-del ${confirmDeleteId === item.documentVersionId ? 'open' : ''}`}
                          title="删除这份文稿"
                          aria-label={`删除 ${item.displayName}`}
                          onClick={() => setConfirmDeleteId((current) => (current === item.documentVersionId ? null : item.documentVersionId))}
                          disabled={deleting}
                        >
                          ×
                        </button>
                      </div>
                    )}
                    {confirmDeleteId === item.documentVersionId ? (
                      <div className="doc-confirm">
                        <p>删除后，它的页面、讲解课、卡片和错题都会一起删掉，不能恢复。</p>
                        <div className="doc-confirm-actions">
                          <button className="danger" onClick={() => void deleteDocument(item)} disabled={deleting}>
                            {deleting ? '正在删除…' : '确认删除'}
                          </button>
                          <button className="ghost" onClick={() => setConfirmDeleteId(null)} disabled={deleting}>取消</button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
                {total > docs.length ? <p className="empty">还有 {total - docs.length} 份未显示。搜索可以更快找到。</p> : null}
              </div>
            </>
          ) : (
            <button className="panel-expand" title="展开文稿栏" onClick={() => setLibraryOpen(true)}>
              文稿<small>{docs.length}</small>
            </button>
          )}
        </aside>
        <section className="panel stage">
          <div className="body">
            {view === 'study' ? <StudyView notify={showNotice} documents={docs} selectedVersionId={selected} onImport={() => importFiles()} onOpenReview={() => setView('review')} onOpenSettings={() => void openAi()} aiConfigured={aiStatus?.configured ?? null} /> : null}
            {view === 'review' ? <ReviewView notify={showNotice} onExportCards={() => void exportCards()} onExportMisses={() => void exportMisses()} onBack={() => setView('study')} /> : null}
            {view === 'doc' ? (
              <>
            {!detail ? <PrerequisitesCard prereq={prereq} busy={busy} onChoose={() => void chooseOffice()} onRecheck={() => void recheckOffice()} /> : null}
            {detail ? (
              <article className="sheet">
                <header>
                  <div>
                    <h2>{detail.displayName}</h2>
                    <div className="meta">
                      <span className="chip">{FORMAT_LABEL[detail.format] ?? detail.format}</span>
                      <span className="chip">{STATE_LABEL[detail.status] ?? detail.status}</span>
                      <span>{detail.pageCount} 页</span>
                      <span>{detail.blockCount} 块</span>
                      <span>{Math.ceil(detail.sizeBytes / 1024)} KB</span>
                    </div>
                  </div>
                  <div className="row">
                    <button className="ghost" onClick={() => void importFiles()} disabled={busy}>导入新课件</button>
                    <button className="primary" onClick={() => setView('study')}>用它开始跟老师学</button>
                  </div>
                </header>
                {activeJob ? <JobLine job={activeJob} onCancel={() => void cancelJob(activeJob)} onRetry={() => void retryJob(activeJob)} /> : null}
                {detail.warnings.length ? (
                  <div className="warnings">
                    {detail.warnings.map((warning) => <p key={warning.id} className="warning">{warning.message}</p>)}
                  </div>
                ) : null}
                {page ? (
                  <>
                    <div className="page-tools">
                      <span className="auto-pill">AI 自动读懂</span>
                      <span className="quiet">
                        {autoProgress
                          ? `正在让 AI 读懂第 ${autoProgress.done + 1} / ${autoProgress.total} 页（第 ${autoProgress.ordinal} 页）…`
                          : pageAuto?.errors.length
                            ? `这一页有 ${pageAuto.errors.length} 处没读全：${pageAuto.errors[0]}`
                            : pageAuto
                              ? '这一页已自动读懂：AI 知识点、联网核对都完成了。'
                              : aiStatus?.configured
                                ? '准备让 AI 读懂这一页…'
                                : '还没有模型密钥，先用本机 OCR 兜底；填好后会自动让 AI 读懂。'}
                      </span>
                      {pageAuto?.errors.length && !autoProgress ? (
                        <button className="ghost" onClick={() => void retryAutoPage()}>重试这一页</button>
                      ) : null}
                      <span className="quiet">上传后不用点按钮；作者、机构、版权、页眉页脚等非知识信息会被忽略，只留知识点。</span>
                    </div>
                    {pageReadings.length ? (
                      <div className="readings">
                        {pageReadings.map((item) => (
                          <div key={item.kind} className="reading">
                            <h4>{item.kind === 'ocr' ? '本机 OCR（备用）' : 'AI 读懂'} <span className="chip">{item.engine}</span></h4>
                            <p><MathText text={item.text} /></p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {pageResearch ? (
                      <div className="reading research">
                        <h4>联网查证 <span className="chip">{pageResearch.engine}</span></h4>
                        <p>{pageResearch.answer}</p>
                        {pageResearch.sources.length ? (
                          <>
                            <h5>参考来源</h5>
                            <ol className="sources">
                              {pageResearch.sources.map((source) => (
                                <li key={source.url}>
                                  <span className="source-title">{source.title}</span>
                                  {source.siteName ? <span className="source-site">{source.siteName}</span> : null}
                                  <span className="source-url">{source.url}</span>
                                  <span className="source-snippet">{source.snippet}</span>
                                </li>
                              ))}
                            </ol>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="page-frame">
                      {page.previewResourceId ? <img alt={`第 ${page.ordinal} 页预览`} src={`app-resource://${page.previewResourceId}`} /> : <p className="empty">这一页没有预览图。</p>}
                      {focus?.bbox && focus.pageId === page.pageId ? (
                        <span className="bbox" style={{ left: `${focus.bbox[0] * 100}%`, top: `${focus.bbox[1] * 100}%`, width: `${focus.bbox[2] * 100}%`, height: `${focus.bbox[3] * 100}%` }} />
                      ) : null}
                    </div>
                    <div className="pager">
                      <button className="ghost" disabled={pageIndex <= 0} onClick={() => setPageIndex((index) => index - 1)}>上一页</button>
                      <span>第 {page.ordinal} / {pages.length} 页 · {page.status === 'needs_review' ? '需复核' : '页面已渲染'}</span>
                      <button className="ghost" disabled={pageIndex >= pages.length - 1} onClick={() => setPageIndex((index) => index + 1)}>下一页</button>
                    </div>
                    {pageBlocks.length ? (
                      <section className="page-text">
                        <header className="page-text-head">
                          <h3>本页文字</h3>
                          <span>选中一段可以高亮或摘录成卡</span>
                        </header>
                        {invalidHighlights.length ? (
                          <div className="highlight-warning">
                            <span>有 {invalidHighlights.length} 处高亮在当前版本里失效（原文或位置变了），不会显示。</span>
                            <button className="link-btn" onClick={() => void cleanupInvalidHighlights()}>清理失效高亮</button>
                          </div>
                        ) : null}
                        {pageBlocks.map((block) => (
                          <HighlightText
                            key={block.blockId}
                            block={block}
                            highlights={highlights}
                            focused={focus?.blockId === block.blockId}
                            onSelect={(selected) => setSelection(selected ? { ...selected, block } : null)}
                            onDeleteHighlight={(id) => void removeHighlight(id)}
                          />
                        ))}
                      </section>
                    ) : null}
                  </>
                ) : (
                  <div className="transcript">
                    {unpaged.length === 0 ? <p className="empty">这份文稿没有页面，也没有可显示的段落。</p> : null}
                    {unpaged.map((block) => (
                      <HighlightText
                        key={block.blockId}
                        block={block}
                        highlights={highlights}
                        focused={focus?.blockId === block.blockId}
                        onSelect={(selected) => setSelection(selected ? { ...selected, block } : null)}
                        onDeleteHighlight={(id) => void removeHighlight(id)}
                      />
                    ))}
                  </div>
                )}
                {page && unpaged.length ? (
                  <div>
                    <h3>未对应页面的锚点</h3>
                    <p className="quiet">这些锚点来自源文件结构。它们没有被自动安到某一渲染页上。</p>
                    <div className="transcript">
                      {unpaged.map((block) => (
                        <HighlightText
                          key={block.blockId}
                          block={block}
                          highlights={highlights}
                          focused={focus?.blockId === block.blockId}
                          onSelect={(selected) => setSelection(selected ? { ...selected, block } : null)}
                          onDeleteHighlight={(id) => void removeHighlight(id)}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                <p className="quiet">解析器 {detail.parserVersion} · SHA-256 {detail.sha256.slice(0, 16)}…</p>
              </article>
            ) : null}
              </>
            ) : null}
          </div>
        </section>
        {view === 'doc' ? (
        <aside className="panel locator">
          <header><h2>来源</h2></header>
          <div className="items">
            {!detail ? <p className="empty">打开一份文稿后，这里列出段落锚点、幻灯片或页面文字。</p> : null}
            {outline.map((block) => (
              <button key={block.blockId} className={`anchor ${focus?.blockId === block.blockId ? 'focus' : ''}`} onClick={() => void locate(block.locator)}>
                <b>{anchorLabel(block)} · {REVIEW_LABEL[block.reviewState] ?? block.reviewState}</b>
                <p>{block.text.slice(0, 80)}</p>
              </button>
            ))}
          </div>
        </aside>
        ) : null}
      </div>
      {aiOpen ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setAiOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>{FEATURE_LABELS.model}</h2>
              <button className="ghost" onClick={() => setAiOpen(false)}>关闭</button>
            </header>
            <p className="quiet">默认用 DeepSeek 的 deepseek-flash，已原生支持图片输入。也可以填任何 OpenAI 兼容的地址；密钥只留在这台电脑的 settings.json 里，不进日志，也不下发给界面。</p>
            <label>
              地址
              <input
                value={aiForm.baseUrl}
                onChange={(event) => {
                  setAiModels([])
                  setAiForm((current) => ({ ...current, baseUrl: event.target.value }))
                }}
                placeholder="https://api.deepseek.com/v1"
                spellCheck={false}
              />
            </label>
            <label>
              模型名
              <input
                value={aiForm.model}
                onChange={(event) => setAiForm((current) => ({ ...current, model: event.target.value }))}
                placeholder="deepseek-flash"
                spellCheck={false}
              />
            </label>
            <label>
              图像模型（可选，换第三方视觉服务时填）
              <input
                value={aiForm.visionModel}
                onChange={(event) => setAiForm((current) => ({ ...current, visionModel: event.target.value }))}
                placeholder="留空就用上面的模型；DeepSeek 的 deepseek-flash 可直接读图"
                spellCheck={false}
              />
            </label>
            <div className="row">
              <button className="ghost" disabled={modelsBusy} onClick={() => void fetchModels()}>
                {modelsBusy ? '正在拉取…' : '拉取模型'}
              </button>
              {aiModels.length ? <span className="quiet">拉到 {aiModels.length} 个，选一个</span> : null}
            </div>
            {aiModels.length ? (
              <label>
                可用模型
                <select
                  value={aiForm.model}
                  onChange={(event) => setAiForm((current) => ({ ...current, model: event.target.value }))}
                >
                  {aiModels.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              密钥{aiStatus?.hasKey ? '（留空则沿用已保存的）' : ''}
              <input
                type="password"
                value={aiForm.apiKey}
                onChange={(event) => setAiForm((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder="sk-…"
                spellCheck={false}
              />
            </label>
            <div className="row">
              <button className="primary" disabled={aiBusy} onClick={() => void saveAi(false)}>保存</button>
              <button className="ghost" disabled={aiBusy} onClick={() => void saveAi(true)}>保存并测试</button>
              {aiStatus?.configured ? <span className="chip ok">已配置</span> : <span className="chip">未配置</span>}
            </div>
            {aiMessage ? <p className={aiMessage.tone === 'bad' ? 'warning' : 'quiet'}>{aiMessage.text}</p> : null}
            <p className="quiet">模型只在这台机器上处理你点「模型拆讲」的那一页原文；不填密钥时「本地拆讲」照旧可用。</p>
            <section className="settings-block">
              <h3>复习计划</h3>
              <div className="goal-form">
                <label>
                  每天卡片
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={reviewForm.cardsPerDay}
                    onChange={(event) => setReviewForm((current) => ({ ...current, cardsPerDay: Number(event.target.value) }))}
                  />
                </label>
                <label>
                  每天错题
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={reviewForm.missesPerDay}
                    onChange={(event) => setReviewForm((current) => ({ ...current, missesPerDay: Number(event.target.value) }))}
                  />
                </label>
                <label className="goal-check">
                  <input
                    type="checkbox"
                    checked={reviewForm.remind}
                    onChange={(event) => setReviewForm((current) => ({ ...current, remind: event.target.checked }))}
                  />
                  到复习时间提醒我
                </label>
                <button className="ghost" disabled={dataBusy} onClick={() => void saveReviewGoal()}>保存目标</button>
              </div>
            </section>
            <section className="settings-block">
              <h3>本机占用</h3>
              {storage ? (
                <p className="quiet">
                  占用 {formatBytes(storage.totalBytes)}：库 {formatBytes(storage.databaseBytes)}、原文 {formatBytes(storage.originalsBytes)}、页面图 {formatBytes(storage.artifactsBytes)}
                </p>
              ) : null}
              {stats ? (
                <p className="quiet">
                  {stats.documents} 份文稿 · {stats.pages} 页 · {stats.lectures} 节课 · {stats.cards} 张卡 · {stats.misses} 道错题 · AI 调用 {stats.aiCalls} 次、输入 {formatNumber(stats.promptTokens + stats.cachedTokens)} tokens
                </p>
              ) : null}
            </section>
            <section className="settings-block">
              <h3>{FEATURE_LABELS.backup}（整个资料库）</h3>
              <p className="quiet">备份会把课程、课件、卡片、错题和本机设置复制到你选的文件夹；不是导出某一份课件。恢复会用备份覆盖当前资料库，所以会先给你看备份里有多少内容，再让你确认。</p>
              <div className="row">
                <button className="ghost" disabled={dataBusy} onClick={() => void backupLibrary()}>
                  {dataBusy ? '正在备份…' : '备份整个资料库'}
                </button>
                <span className="quiet">不含 API 密钥，也不含临时解析目录。</span>
              </div>
              {backup ? <p className="quiet">上次备份：{backup.path}（{backup.files} 个文件，{formatBytes(backup.bytes)}）</p> : null}
              {appSettings ? (
                <div className="settings-subblock">
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <label className="goal-check">
                      <input
                        type="checkbox"
                        checked={appSettings.backup.enabled}
                        onChange={(event) => {
                          const enabled = event.target.checked
                          setAppSettings((current) => (current ? { ...current, backup: { ...current.backup, enabled } } : current))
                          void saveDataSettings({ backup: { enabled } })
                        }}
                      />
                      每天自动备份整个资料库一次
                    </label>
                    <span className="quiet">保留
                      <input
                        className="inline-number"
                        type="number"
                        min={1}
                        max={30}
                        value={appSettings.backup.keep}
                        onChange={(event) => {
                          const keep = Math.max(1, Math.min(30, Number(event.target.value) || 1))
                          setAppSettings((current) => (current ? { ...current, backup: { ...current.backup, keep } } : current))
                          void saveDataSettings({ backup: { keep } })
                        }}
                      /> 份
                    </span>
                  </div>
                  <div className="row">
                    <button className="ghost" disabled={dataBusy} onClick={() => void chooseBackupDirectory()}>选择自动备份位置</button>
                    <span className="quiet">{appSettings.backup.directory || '还没选目录'} {appSettings.backup.lastAt ? `· 上次 ${new Date(appSettings.backup.lastAt).toLocaleString('zh-CN')}` : ''}</span>
                  </div>
                  <div className="row">
                    <button className="ghost" disabled={restoreBusy} onClick={() => void inspectRestore()}>
                      {restoreBusy ? '正在检查备份…' : '用备份恢复整个资料库'}
                    </button>
                    <span className="quiet">会先给你看备份里有多少东西，再让你确认。</span>
                  </div>
                  {restorePreview ? (
                    <div className="restore-card">
                      <p><b>备份版本 {restorePreview.version}</b> · {restorePreview.createdAt ? new Date(restorePreview.createdAt).toLocaleString('zh-CN') : '时间未知'}</p>
                      <p className={restorePreview.verification === 'sha256' ? 'quiet' : 'warning'}>
                        {restorePreview.verification === 'sha256'
                          ? `数据库校验：已核对 SHA-256（${restorePreview.databaseSha256?.slice(0, 12) ?? ''}…）`
                          : '这是旧版备份，没有数据库哈希；仍可恢复，但无法证明文件未被改动。'}
                      </p>
                      <p className="quiet">{restorePreview.counts.documents} 份文稿 · {restorePreview.counts.pages} 页 · {restorePreview.counts.cards + restorePreview.counts.manualCards} 张卡 · {restorePreview.counts.misses} 道错题 · {restorePreview.counts.highlights} 条高亮</p>
                      <p className="warning">恢复会用这个备份覆盖当前整库；旧库会改名留作回滚，应用随后自动重启。模型 API Key 保留本机的。</p>
                      <div className="row">
                        <button className="primary" disabled={restoreBusy} onClick={() => void applyRestore()}>{restoreBusy ? '正在恢复…' : '确认覆盖并重启'}</button>
                        <button className="ghost" onClick={() => setRestorePreview(null)}>取消</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
            <section className="settings-block">
              <h3>每月模型用量上限</h3>
              {appSettings ? (
                <>
                  <p className="quiet">按自然月累计「输入 + 输出」token。填 0 表示关闭；超过上限时默认直接拦住下一次模型调用。</p>
                  <div className="row" style={{ alignItems: 'center' }}>
                    <label>每月上限
                      <input
                        type="number"
                        min={0}
                        max={100000000}
                        step={10000}
                        value={appSettings.budget.monthlyTokens}
                        onChange={(event) => {
                          const monthlyTokens = Math.max(0, Math.min(100000000, Number(event.target.value) || 0))
                          setAppSettings((current) => (current ? { ...current, budget: { ...current.budget, monthlyTokens } } : current))
                        }}
                      />
                      tokens
                    </label>
                    <label className="goal-check">
                      <input
                        type="checkbox"
                        checked={appSettings.budget.hardStop}
                        onChange={(event) => {
                          const hardStop = event.target.checked
                          setAppSettings((current) => (current ? { ...current, budget: { ...current.budget, hardStop } } : current))
                        }}
                      />
                      到上限硬拦截
                    </label>
                    <button className="ghost" disabled={dataBusy} onClick={() => void saveDataSettings({ budget: appSettings.budget })}>保存护栏</button>
                  </div>
                  {appSettings.budgetStatus.limit > 0 ? (
                    <>
                      <div className={`budget-bar ${appSettings.budgetStatus.exceeded ? 'bad' : appSettings.budgetStatus.warned ? 'warn' : ''}`}>
                        <span style={{ width: `${Math.min(100, appSettings.budgetStatus.percent)}%` }} />
                      </div>
                      <p className="quiet">
                        本月已用 {formatNumber(appSettings.budgetStatus.used)} / {formatNumber(appSettings.budgetStatus.limit)} tokens（{appSettings.budgetStatus.percent}%），还剩 {formatNumber(appSettings.budgetStatus.remaining)}。
                        {appSettings.budgetStatus.exceeded ? ' 已到上限。' : ''}
                      </p>
                      {appSettings.budgetStatus.estimated ? (
                        <p className="warning">有 {appSettings.budgetStatus.estimatedCalls} 次模型调用没有返回用量，当前数字是估算；实际消耗可能更高。</p>
                      ) : null}
                    </>
                  ) : <p className="quiet">护栏已关闭。</p>}
                </>
              ) : <p className="quiet">正在读取本机设置…</p>}
            </section>
            <div className="app-update">
              <div className="row">
                <span className="quiet">灯下 {appInfo?.version ?? '…'}</span>
                <button className="ghost" disabled={updateBusy} onClick={() => void checkUpdate()}>
                  {updateBusy ? '正在检查…' : '检查更新'}
                </button>
              </div>
              {updateResult ? (
                <p className={`update-note ${updateResult.status === 'update-available' ? 'ok' : ''}`}>
                  {updateResult.message}
                  {updateResult.url ? <a href={updateResult.url} target="_blank" rel="noreferrer">前往下载</a> : null}
                </p>
              ) : null}
              {updateResult?.status === 'update-available' && updateResult.assetUrl ? (
                <div className="row">
                  <button className="primary" disabled={updateDownloading} onClick={() => void downloadUpdate()}>
                    {updateDownloading ? `下载中 ${updateProgress?.percent ?? 0}%` : '下载安装包'}
                  </button>
                  {updateFile ? <button className="ghost" onClick={() => void openDownloadedUpdate()}>打开安装包</button> : null}
                </div>
              ) : null}
              {updateProgress && updateDownloading ? (
                <div className="progress"><span style={{ width: `${updateProgress.percent}%` }} /></div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {helpOpen ? <HelpGuide onClose={closeHelp} /> : null}
      {selection ? (
        <div className="selection-toolbar" style={{ left: selection.x, top: selection.y }}>
          <span>已选 {selection.quote.length} 字</span>
          <button className="primary" onMouseDown={(event) => event.preventDefault()} onClick={() => void addHighlight()}>高亮</button>
          <button className="ghost" onMouseDown={(event) => event.preventDefault()} onClick={startExcerpt}>摘录成卡</button>
          <button className="link-btn" onClick={() => setSelection(null)}>取消</button>
        </div>
      ) : null}
      {excerpt ? (
        <div className="modal-overlay" onClick={() => setExcerpt(null)}>
          <div className="modal-card excerpt-card" onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>摘录成卡</h2>
              <button className="icon-btn" onClick={() => setExcerpt(null)}>×</button>
            </header>
            <p className="excerpt-source">{excerpt.quote}</p>
            <label>
              正面（问题）
              <input value={excerpt.front} maxLength={500} onChange={(event) => setExcerpt((current) => (current ? { ...current, front: event.target.value } : current))} />
            </label>
            <label>
              背面（答案，可留空）
              <textarea value={excerpt.back} maxLength={1000} rows={4} onChange={(event) => setExcerpt((current) => (current ? { ...current, back: event.target.value } : current))} />
            </label>
            <div className="row">
              <button className="primary" disabled={excerptBusy} onClick={() => void saveExcerpt()}>{excerptBusy ? '保存中…' : '保存卡片'}</button>
              <button className="ghost" onClick={() => setExcerpt(null)}>取消</button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
  )
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function anchorLabel(block: BlockView): string {  const locator = block.locator
  if (locator.paragraphAnchor) return locator.paragraphAnchor
  if (locator.slideNumber) return `幻灯片 ${locator.slideNumber}`
  if (locator.pageNumber) return `第 ${locator.pageNumber} 页`
  return `块 ${block.ordinal}`
}

function JobLine({ job, onCancel, onRetry }: { job: JobSnapshot; onCancel: () => void; onRetry: () => void }) {
  const active = job.state === 'queued' || job.state === 'running'
  const ratio = job.total && job.total > 0 ? Math.min(100, Math.round((job.completed / job.total) * 100)) : null
  return (
    <div>
      <div className="meta">
        <span className={`chip ${job.state === 'failed' ? 'bad' : job.state === 'partial' || job.state === 'interrupted' ? 'warn' : job.state === 'succeeded' ? 'ok' : ''}`}>{STATE_LABEL[job.state] ?? job.state}</span>
        <span>{job.stage}</span>
        {job.total ? <span>{job.completed}/{job.total}</span> : null}
      </div>
      {active ? <div className={`progress ${ratio === null ? 'indeterminate' : ''}`}><span style={ratio === null ? undefined : { width: `${ratio}%` }} /></div> : null}
      {job.error ? <p className="warning">{job.error.message}</p> : null}
      <div className="row">
        {active ? <button className="ghost" onClick={onCancel}>取消</button> : null}
        {job.state === 'succeeded' || job.state === 'failed' || job.state === 'partial' || job.state === 'interrupted' || job.state === 'cancelled' ? <button className="ghost" onClick={onRetry}>重试</button> : null}
      </div>
    </div>
  )
}

function PrerequisitesCard({
  prereq,
  busy,
  onChoose,
  onRecheck,
}: {
  prereq: Prerequisites | null
  busy: boolean
  onChoose: () => void
  onRecheck: () => void
}) {
  return (
    <article className="sheet prereq">
      <h3>本机准备</h3>
      <p>PDF、TXT、Markdown 和图片可以直接导入。PPTX 与 DOCX 只从文件结构提取文字。页面转换在隔离被实际验证之前不会运行。</p>
      {!prereq ? <p className="empty">正在检查本机文件…</p> : null}
      {prereq ? (
        <>
          <p>{prereq.libreOffice.fileFound ? `找到文件，但没有启动它。路径：${prereq.libreOffice.path}` : '未找到 LibreOffice 可执行文件。'}</p>
          <p>{prereq.libreOffice.message}</p>
          <p className="warning">{prereq.sandbox.note}</p>
          <p className="quiet">图片页可以点「识别这一页文字」（本机离线）或「让模型看懂这一页」；公式语义仍会标成需复核。选择 soffice 只记录路径，不会运行转换。</p>
          <div className="row">
            <button className="primary" disabled={busy} onClick={onChoose}>选择 soffice</button>
            <button className="ghost" disabled={busy} onClick={onRecheck}>重新检查</button>
          </div>
        </>
      ) : null}
    </article>
  )
}

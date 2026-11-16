import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BlockView, DocumentDetail, DocumentListItem, JobChangedEvent, JobSnapshot, Locator, PageView, Prerequisites, PreviewFocus } from '../shared/contract'
import { ReviewView } from './teaching/ReviewView'
import { StudyView } from './study/StudyView'
import type { AiConfigView } from '../shared/ai'
import { DEFAULT_AI } from '../shared/ai'
import type { ImageReading, AutoReadResult } from '../shared/images'
import type { PageResearch } from '../shared/research'

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
    if (requested === 'study' || requested === 'class') return 'study'
    return 'doc'
  })
  const showNotice = useCallback((tone: 'info' | 'bad', text: string) => setNotice({ tone, text }), [])
  const [aiOpen, setAiOpen] = useState(false)
  // 左侧文稿栏可收起：听课时把宽度让给讲稿。
  const [libraryOpen, setLibraryOpen] = useState(true)
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
    const result = await window.desk.documents.list({ offset: 0, limit: 50 })
    if (!result.ok) {
      setNotice({ tone: 'bad', text: result.error.message })
      return
    }
    setDocs(result.data.items)
    setTotal(result.data.total)
  }, [])

  const openVersion = useCallback(async (documentVersionId: string, preferredPage?: number) => {
    if (!window.desk) return
    const [got, loadedPages, loose, imageReadings, researchItems] = await Promise.all([
      window.desk.documents.get({ documentVersionId }),
      loadAllPages(documentVersionId),
      loadBlocks({ documentVersionId, scope: 'unpaged' }),
      window.desk.images.readings({ documentVersionId }),
      window.desk.research.list({ documentVersionId }),
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
    setAutoStatuses({})
    const nextIndex = preferredPage ? Math.max(0, loadedPages.findIndex((page) => page.ordinal === preferredPage)) : 0
    setPageIndex(nextIndex < 0 ? 0 : nextIndex)
    void autoReadVersion(documentVersionId)
  }, [])

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
          if (current) void openVersion(current)
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

  useEffect(() => {
    if (booting || view !== 'study' || selected || docs.length === 0) return
    const versionId = docs[0].documentVersionId
    if (studyAutoOpen.current === versionId) return
    studyAutoOpen.current = versionId
    void openVersion(versionId)
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

  async function importFiles() {
    if (!window.desk) return
    setBusy(true)
    const picked = await window.desk.documents.pick()
    if (!picked.ok) {
      setNotice({ tone: 'bad', text: picked.error.message })
      setBusy(false)
      return
    }
    if (picked.data.cancelled) {
      setNotice({ tone: 'info', text: '没有选择文件。' })
      setBusy(false)
      return
    }
    let last: string | null = null
    for (const file of picked.data.files) {
      const result = await window.desk.documents.import({ handle: file.handle, requestId: crypto.randomUUID() })
      if (!result.ok) setNotice({ tone: 'bad', text: `${file.name}：${result.error.message}` })
      else last = result.data.documentVersionId
    }
    await refreshList()
    if (last) await openVersion(last)
    setBusy(false)
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
  }

  async function checkUpdate() {
    if (!api || updateBusy) return
    setUpdateBusy(true)
    setUpdateResult(null)
    const result = await api.app.checkUpdate()
    if (result.ok) setUpdateResult(result.data)
    setUpdateBusy(false)
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
          showNotice('bad', `自动读懂完成，但有 ${errors.length} 处没成功：${errors[0]}`)
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

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <div className="brand-title">
            <svg className="brand-logo" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#1f9d80" d="M9 2.5h6v2h-2v4.1a6 6 0 0 1 4.2 5.7v2.2H6.8v-2.2a6 6 0 0 1 4.2-5.7V4.5H9v-2z" />
              <path fill="#ffb84d" d="M11 15.6h2v2.2h-2z" />
              <path fill="#173e3a" d="M10.2 18.6h3.6l-.5 2.2h-2.6z" />
            </svg>
            <strong>灯下</strong>
          </div>
          <span>本地文稿 · 完整读懂、按习惯拆课、逐句讲解与学习总结</span>
        </div>
        <div className="top-side">
          <div className="row">
            <nav className="tabs">
              <button className={`tab ${view === 'doc' ? 'active' : ''}`} onClick={() => setView('doc')}>文稿</button>
              <button className={`tab ${view === 'study' ? 'active' : ''}`} onClick={() => setView('study')}>AI 私教</button>
              <button className={`tab ${view === 'review' ? 'active' : ''}`} onClick={() => setView('review')}>复习</button>
            </nav>
            <button className="ghost" onClick={() => void openAi()}>模型{aiStatus?.configured ? ' · 已配置' : ''}</button>
          </div>
          <p className="quiet">没有账号，没有云同步；模型只用你自己填的那一个。</p>
        </div>
      </header>
      {notice ? <div className={`banner ${notice.tone === 'bad' ? 'bad' : 'info'}`} style={{ margin: '0 20px 12px' }}>{notice.text}</div> : null}
      <div className={`shell ${view === 'doc' ? '' : 'two'}${libraryOpen ? '' : ' library-collapsed'}`}>
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
              <div className="doc-list">
                {booting ? <p className="empty">正在读取本机文库…</p> : null}
                {!booting && docs.length === 0 ? <p className="empty">还没有文稿。可以选择 PPTX、DOCX、PDF、TXT、Markdown 或图片。文件只留在这台电脑上。</p> : null}
                {docs.map((item) => (
                  <button key={item.documentVersionId} className={`doc ${selected === item.documentVersionId ? 'active' : ''}`} onClick={() => void openVersion(item.documentVersionId)}>
                    <b>{item.displayName}</b>
                    <small>{FORMAT_LABEL[item.format] ?? item.format} · {STATE_LABEL[item.job?.state ?? item.status] ?? item.status}</small>
                  </button>
                ))}
                {total > docs.length ? <p className="empty">还有 {total - docs.length} 份未显示。当前列表读取前 50 份。</p> : null}
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
            {view === 'study' ? <StudyView notify={showNotice} documents={docs} selectedVersionId={selected} onOpenDocs={() => setView('doc')} /> : null}
            {view === 'review' ? <ReviewView notify={showNotice} /> : null}
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
                    <button className="primary" onClick={() => setView('study')}>用它开始 AI 私教</button>
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
                            <p>{item.text}</p>
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
                  </>
                ) : (
                  <div className="transcript">
                    {unpaged.length === 0 ? <p className="empty">这份文稿没有页面，也没有可显示的段落。</p> : null}
                    {unpaged.map((block) => (
                      <p key={block.blockId} id={`block-${block.blockId}`} className={`block ${block.kind} ${focus?.blockId === block.blockId ? 'focus' : ''}`}>{block.text}</p>
                    ))}
                  </div>
                )}
                {page && unpaged.length ? (
                  <div>
                    <h3>未对应页面的锚点</h3>
                    <p className="quiet">这些锚点来自源文件结构。它们没有被自动安到某一渲染页上。</p>
                    <div className="transcript">
                      {unpaged.map((block) => (
                        <p key={block.blockId} id={`block-${block.blockId}`} className={`block ${focus?.blockId === block.blockId ? 'focus' : ''}`}>{block.text}</p>
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
              <h2>模型</h2>
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
            </div>
          </div>
        </div>
      ) : null}
      </div>
  )
}

function anchorLabel(block: BlockView): string {
  const locator = block.locator
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

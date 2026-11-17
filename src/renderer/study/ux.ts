import type { DocumentListItem } from '../../shared/contract'

/**
 * 课程创建依赖已经落好的页与文本块；解析没完成时抢跑只会得到“没有可读内容”。
 * job 的终态优先于列表里的 status，避免旧列表把失败任务当成可建课。
 * partial 只表示还有待读图/待复核项，正文与页面已经落库；建课时会继续做视觉读图，
 * 不能把它当成“还在解析”而挡住自动建课。
 */
export function isDocumentReady(item: DocumentListItem): boolean {
  const job = item.job
  if (job) {
    if (job.state === 'queued' || job.state === 'running') return false
    if (job.state !== 'succeeded' && job.state !== 'partial') return false
  }
  return item.status === 'ready' || item.status === 'partial'
}

/** 首页等待态只说解析进度，不把“还没可读内容”当成建课失败。 */
export function documentWaitText(item: DocumentListItem): string {
  if (!item.job) return item.status === 'parsing' ? '正在解析这份课件；解析完会自动拆课。' : ''
  if (item.job.state === 'queued') return '这份课件在排队解析；解析完会自动拆课。'
  if (item.job.state === 'running') {
    const total = item.job.total
    const progress = total ? `${item.job.completed}/${total}` : String(item.job.completed)
    return `正在解析这份课件：${progress}；解析完会自动拆课。`
  }
  if (item.job.state === 'failed') return '这份课件解析没成功；重新导入或打开文稿再试。'
  return ''
}

/**
 * 课堂消息按讲分散渲染，DOM 里最后一条 `.ws-message` 往往是最后一讲的讲稿，
 * 不是刚插入当前讲的新回答。滚动必须按最新消息 id 定位；发送等待期优先 pending。
 */
export function scrollTargetSelector(latestMessageId: string | null, pending: boolean): string | null {
  if (pending) return '[data-pending-answer]'
  if (!latestMessageId) return null
  return `[data-message-id="${latestMessageId}"]`
}

import { describe, expect, it } from 'vitest'
import type { DocumentListItem } from '../src/shared/contract'
import { documentWaitText, isDocumentReady, scrollTargetSelector } from '../src/renderer/study/ux'

function doc(status: string, job: DocumentListItem['job'] = null): DocumentListItem {
  return {
    documentId: 'doc',
    documentVersionId: 'version',
    displayName: '线代.pdf',
    format: 'pdf',
    sizeBytes: 1,
    status,
    createdAt: '2026-11-17T00:00:00.000Z',
    sha256: 'a'.repeat(64),
    job,
    pinned: false,
  }
}

describe('课堂体验 helper', () => {
  it('文档还在解析时不认为可建课；job 结束后仍以 ready 为准', () => {
    expect(isDocumentReady(doc('parsing', {
      jobId: 'j', state: 'running', stage: 'parse', completed: 12, total: 147,
    }))).toBe(false)
    expect(isDocumentReady(doc('ready', {
      jobId: 'j', state: 'succeeded', stage: 'done', completed: 147, total: 147,
    }))).toBe(true)
    expect(isDocumentReady(doc('ready'))).toBe(true)
    expect(isDocumentReady(doc('parsing'))).toBe(false)
    expect(isDocumentReady(doc('ready', {
      jobId: 'j', state: 'failed', stage: 'parse', completed: 0, total: 147,
    }))).toBe(false)
  })

  it('等待解析时给出可读进度，不显示建课失败文案', () => {
    const text = documentWaitText(doc('parsing', {
      jobId: 'j', state: 'running', stage: 'parse', completed: 12, total: 147,
    }))
    expect(text).toContain('解析')
    expect(text).toContain('12/147')
    expect(documentWaitText(doc('ready'))).toBe('')
  })

  it('滚动目标优先 pending 回答，否则用最新消息 id，而不是最后一个 .ws-message', () => {
    expect(scrollTargetSelector('message-8', true)).toBe('[data-pending-answer]')
    expect(scrollTargetSelector('message-8', false)).toBe('[data-message-id="message-8"]')
    expect(scrollTargetSelector(null, false)).toBeNull()
    expect(scrollTargetSelector(null, true)).toBe('[data-pending-answer]')
  })
})

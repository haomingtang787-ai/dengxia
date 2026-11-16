import { MESSAGES } from '../../shared/constants'
import type { Limits } from '../../shared/constants'
import { clipText, looksLikeHtml, sanitizeDocumentText } from '../../shared/text'
import { AppError } from '../errors'
import type { ParsedBlock, ParsedIssue } from '../parseTypes'

export function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    throw new AppError('PARSE_FAILED', MESSAGES.utf8)
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    throw new AppError('PARSE_FAILED', MESSAGES.utf8)
  }
  let view = bytes
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    view = bytes.subarray(3)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(view)
  } catch {
    throw new AppError('PARSE_FAILED', MESSAGES.utf8)
  }
}

export function parsePlainText(
  bytes: Uint8Array,
  documentVersionId: string,
  limits: Limits,
): { blocks: ParsedBlock[]; issues: ParsedIssue[] } {
  if (bytes.byteLength > limits.maxTextFileBytes) {
    throw new AppError('LIMIT_EXCEEDED', '文本文件超过本阶段的大小上限。')
  }
  const raw = sanitizeDocumentText(decodeUtf8(bytes)).replace(/\n{3,}/g, '\n\n').trim()
  if (!raw) throw new AppError('PARSE_FAILED', '文件里没有可读取的文本。')
  const parts = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  return finishBlocks(parts.map((text) => ({ kind: 'paragraph' as const, text })), documentVersionId, 'txt-p', 'plain-text', limits)
}

export function parseMarkdown(
  bytes: Uint8Array,
  documentVersionId: string,
  limits: Limits,
): { blocks: ParsedBlock[]; issues: ParsedIssue[] } {
  if (bytes.byteLength > limits.maxTextFileBytes) {
    throw new AppError('LIMIT_EXCEEDED', 'Markdown 文件超过本阶段的大小上限。')
  }
  const raw = sanitizeDocumentText(decodeUtf8(bytes))
  if (!raw.trim()) throw new AppError('PARSE_FAILED', '文件里没有可读取的文本。')
  const lines = raw.replace(/\n+$/, '').split('\n')
  const pieces: Array<{ kind: 'paragraph' | 'heading' | 'code'; text: string }> = []
  let buffer: string[] = []
  let fence: string | null = null
  const flush = () => {
    const text = buffer.join('\n').trim()
    buffer = []
    if (text) pieces.push({ kind: 'paragraph', text })
  }
  for (const line of lines) {
    const fenceMatch = /^(```+|~~~+)/.exec(line.trim())
    if (fence) {
      buffer.push(line)
      if (fenceMatch && fenceMatch[1]?.startsWith(fence)) {
        pieces.push({ kind: 'code', text: buffer.join('\n').trim() })
        buffer = []
        fence = null
      }
      continue
    }
    if (fenceMatch && line.trim() === fenceMatch[1]) {
      flush()
      fence = fenceMatch[1][0] === '`' ? '```' : '~~~'
      buffer = [line]
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (/^#{1,6}\s+\S/.test(line) && buffer.length === 0) {
      pieces.push({ kind: 'heading', text: line.trim() })
      continue
    }
    buffer.push(line)
  }
  if (fence && buffer.length) pieces.push({ kind: 'code', text: buffer.join('\n').trim() })
  else flush()
  return finishBlocks(pieces, documentVersionId, 'md-b', 'markdown', limits)
}

function finishBlocks(
  pieces: Array<{ kind: 'paragraph' | 'heading' | 'code'; text: string }>,
  documentVersionId: string,
  prefix: string,
  extractionMethod: 'plain-text' | 'markdown',
  limits: Limits,
): { blocks: ParsedBlock[]; issues: ParsedIssue[] } {
  if (pieces.length > limits.maxBlocks) {
    throw new AppError('LIMIT_EXCEEDED', '文本块数量超过上限。')
  }
  const blocks: ParsedBlock[] = []
  const issues: ParsedIssue[] = []
  let htmlNoted = false
  pieces.forEach((piece, index) => {
    const clipped = clipText(piece.text, limits.maxBlockChars)
    const anchor = `${prefix}-${String(index + 1).padStart(4, '0')}`
    blocks.push({
      ordinal: index + 1,
      pageOrdinal: null,
      kind: piece.kind,
      text: clipped.text,
      locator: { documentVersionId, paragraphAnchor: anchor },
      extractionMethod,
      reviewState: clipped.clipped ? 'needs_review' : 'unverified',
    })
    if (clipped.clipped) {
      issues.push({
        pageOrdinal: null,
        blockOrdinal: index + 1,
        code: 'LIMIT_EXCEEDED',
        message: '有一块文本超过单块长度，已截断并标为需复核。',
        reviewState: 'needs_review',
      })
    }
    if (!htmlNoted && looksLikeHtml(clipped.text)) {
      htmlNoted = true
      issues.push({
        pageOrdinal: null,
        blockOrdinal: null,
        code: 'HTML_NOT_EXECUTED',
        message: MESSAGES.htmlText,
        reviewState: 'needs_review',
      })
    }
  })
  if (!blocks.length) throw new AppError('PARSE_FAILED', '文件里没有可读取的文本。')
  return { blocks, issues }
}

import { LIMITS } from './constants'

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g

export function sanitizeDocumentText(input: string): string {
  return input
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CONTROL, '')
    .replace(BIDI, '')
}

export function clipText(input: string, max = LIMITS.maxBlockChars): { text: string; clipped: boolean } {
  const clean = sanitizeDocumentText(input)
  if (clean.length <= max) return { text: clean, clipped: false }
  return { text: clean.slice(0, max), clipped: true }
}

export function looksLikeHtml(text: string): boolean {
  return /<[a-z!/][^>]{0,80}>/i.test(text)
}

export function safeDisplayName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? ''
  const cleaned = sanitizeDocumentText(base).replace(/^\.+/, '').trim().slice(0, 120)
  return cleaned || '未命名'
}

export function safeStoredName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? ''
  const cleaned = sanitizeDocumentText(base)
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80)
  return cleaned || 'file'
}

import { MESSAGES } from '../shared/constants'
import type { DocumentFormat } from '../shared/contract'
import { AppError } from './errors'

const EXT: Record<string, DocumentFormat | 'ppt' | 'doc'> = {
  pptx: 'pptx',
  docx: 'docx',
  pdf: 'pdf',
  txt: 'txt',
  md: 'markdown',
  markdown: 'markdown',
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  ppt: 'ppt',
  doc: 'doc',
}

function extensionOf(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

function startsWith(header: Uint8Array, bytes: number[]): boolean {
  if (header.length < bytes.length) return false
  return bytes.every((byte, index) => header[index] === byte)
}

function isOle(header: Uint8Array): boolean {
  return startsWith(header, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
}

function isZip(header: Uint8Array): boolean {
  return startsWith(header, [0x50, 0x4b, 0x03, 0x04]) || startsWith(header, [0x50, 0x4b, 0x05, 0x06]) || startsWith(header, [0x50, 0x4b, 0x07, 0x08])
}

function isPng(header: Uint8Array): boolean {
  return startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

function isJpeg(header: Uint8Array): boolean {
  return startsWith(header, [0xff, 0xd8, 0xff])
}

function isPdf(header: Uint8Array): boolean {
  return startsWith(header, [0x25, 0x50, 0x44, 0x46])
}

function isExecutableOrArchive(header: Uint8Array): boolean {
  return isZip(header) || isPdf(header) || isPng(header) || isJpeg(header) || isOle(header) || startsWith(header, [0x4d, 0x5a])
}

export function detectFormat(filename: string, header: Uint8Array): DocumentFormat {
  const ext = extensionOf(filename)
  if (ext === 'ppt' || ext === 'doc' || (isOle(header) && (ext === 'ppt' || ext === 'doc' || ext === 'pptx' || ext === 'docx'))) {
    throw new AppError('UNSUPPORTED_FORMAT', MESSAGES.legacyOffice)
  }
  const kind = EXT[ext]
  if (!kind || kind === 'ppt' || kind === 'doc') {
    throw new AppError('UNSUPPORTED_FORMAT', ext ? MESSAGES.unsupported : MESSAGES.unsupported)
  }
  if ((kind === 'docx' || kind === 'pptx') && isOle(header)) {
    throw new AppError('UNSUPPORTED_FORMAT', MESSAGES.legacyOffice)
  }
  if ((kind === 'docx' || kind === 'pptx') && !isZip(header)) {
    throw new AppError('PARSE_FAILED', '文件扩展名是 Office Open XML，但内容不是 ZIP 包。')
  }
  if (kind === 'pdf' && !isPdf(header)) {
    throw new AppError('PARSE_FAILED', '文件扩展名是 PDF，但开头不是 %PDF。')
  }
  if (kind === 'png' && !isPng(header)) {
    throw new AppError('PARSE_FAILED', '文件扩展名是 PNG，但文件头不匹配。')
  }
  if (kind === 'jpeg' && !isJpeg(header)) {
    throw new AppError('PARSE_FAILED', '文件扩展名是 JPEG，但文件头不匹配。')
  }
  if ((kind === 'txt' || kind === 'markdown') && (header.includes(0) || isExecutableOrArchive(header))) {
    throw new AppError('FILE_UNREADABLE', '这个文本文件的开头像是二进制内容，已拒绝按文本导入。')
  }
  return kind
}

import { Inflate } from 'fflate'
import { LIMITS, type Limits } from '../shared/constants'
import { AppError } from './errors'

export type ZipEntry = {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  encrypted: boolean
}

function findEocd(data: Uint8Array): { totalEntries: number; cdOffset: number } {
  const min = Math.max(0, data.length - 22 - 65535)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let i = data.length - 22; i >= min; i -= 1) {
    if (data[i] !== 0x50 || data[i + 1] !== 0x4b || data[i + 2] !== 0x05 || data[i + 3] !== 0x06) continue
    const commentLen = view.getUint16(i + 20, true)
    if (i + 22 + commentLen !== data.length) continue
    const totalEntries = view.getUint16(i + 10, true)
    const cdOffset = view.getUint32(i + 16, true)
    const cdSize = view.getUint32(i + 12, true)
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
      throw new AppError('RESOURCE_LIMIT', '不支持 ZIP64 或声明体积极大的压缩包。')
    }
    return { totalEntries, cdOffset }
  }
  throw new AppError('PARSE_FAILED', '不是有效的 ZIP 容器。')
}

export function safeZipName(name: string): string | null {
  if (!name || name.includes('\0')) return null
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  return normalized
}

export function listZipEntries(data: Uint8Array, limits: Limits = LIMITS): ZipEntry[] {
  const eocd = findEocd(data)
  if (eocd.totalEntries > limits.maxZipEntries) {
    throw new AppError('RESOURCE_LIMIT', '压缩包条目过多，已拒绝解压。')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = eocd.cdOffset
  const entries: ZipEntry[] = []
  let declaredTotal = 0
  for (let index = 0; index < eocd.totalEntries; index += 1) {
    if (offset + 46 > data.length) throw new AppError('PARSE_FAILED', '压缩包目录被截断。')
    const signature = view.getUint32(offset, true)
    if (signature !== 0x02014b50) throw new AppError('PARSE_FAILED', '压缩包目录签名错误。')
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new AppError('RESOURCE_LIMIT', '不支持 ZIP64 条目。')
    }
    const nameStart = offset + 46
    const nameEnd = nameStart + nameLen
    if (nameEnd > data.length) throw new AppError('PARSE_FAILED', '压缩包文件名被截断。')
    const name = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(nameStart, nameEnd))
    if (!name.endsWith('/')) {
      const safe = safeZipName(name)
      if (!safe) throw new AppError('PARSE_FAILED', '压缩包包含不安全路径，已拒绝解压。')
      if (uncompressedSize > limits.maxUncompressedEntryBytes) {
        throw new AppError('RESOURCE_LIMIT', '单个压缩条目声明的体积超过上限。')
      }
      const ratio = compressedSize === 0 ? uncompressedSize : uncompressedSize / compressedSize
      if (uncompressedSize > 4096 && ratio > limits.maxCompressionRatio) {
        throw new AppError('RESOURCE_LIMIT', '压缩比异常，已拒绝解压。')
      }
      declaredTotal += uncompressedSize
      if (declaredTotal > limits.maxTotalUncompressedBytes) {
        throw new AppError('RESOURCE_LIMIT', '解压后的总体积超过上限。')
      }
      entries.push({
        name: safe,
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
        encrypted: (flags & 0x1) === 0x1,
      })
    } else if (safeZipName(name.slice(0, -1)) === null && name !== '/') {
      throw new AppError('PARSE_FAILED', '压缩包包含不安全路径，已拒绝解压。')
    }
    offset = nameEnd + extraLen + commentLen
  }
  return entries
}

function inflateCapped(data: Uint8Array, cap: number): Uint8Array {
  const inflator = new Inflate()
  const chunks: Uint8Array[] = []
  let size = 0
  let failed = false
  inflator.ondata = (chunk) => {
    if (failed) return
    size += chunk.length
    if (size > cap) {
      failed = true
      return
    }
    chunks.push(chunk)
  }
  try {
    inflator.push(data, true)
  } catch {
    throw new AppError('RESOURCE_LIMIT', '解压输出超过上限或数据损坏。')
  }
  if (failed) {
    throw new AppError('RESOURCE_LIMIT', '解压输出超过上限或数据损坏。')
  }
  const out = new Uint8Array(size)
  let cursor = 0
  for (const chunk of chunks) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}

export function readZipEntry(data: Uint8Array, entry: ZipEntry, limits: Limits = LIMITS): Uint8Array {
  if (entry.encrypted) throw new AppError('PARSE_FAILED', '不支持加密的 Office 压缩包。')
  if (entry.method !== 0 && entry.method !== 8) {
    throw new AppError('PARSE_FAILED', '压缩包使用了不受支持的压缩方法。')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (entry.localOffset + 30 > data.length) throw new AppError('PARSE_FAILED', '压缩包本地头损坏。')
  const signature = view.getUint32(entry.localOffset, true)
  if (signature !== 0x04034b50) throw new AppError('PARSE_FAILED', '压缩包本地头签名错误。')
  const nameLen = view.getUint16(entry.localOffset + 26, true)
  const extraLen = view.getUint16(entry.localOffset + 28, true)
  const start = entry.localOffset + 30 + nameLen + extraLen
  const end = start + entry.compressedSize
  if (end > data.length) throw new AppError('PARSE_FAILED', '压缩包数据被截断。')
  const compressed = data.subarray(start, end)
  const bytes = entry.method === 0 ? new Uint8Array(compressed) : inflateCapped(compressed, limits.maxUncompressedEntryBytes)
  if (bytes.length > limits.maxUncompressedEntryBytes) {
    throw new AppError('RESOURCE_LIMIT', '解压后的条目超过上限。')
  }
  if (entry.uncompressedSize > 0 && bytes.length > entry.uncompressedSize + 64) {
    throw new AppError('RESOURCE_LIMIT', '解压长度大于声明长度。')
  }
  return bytes
}

export function readZipFiles(data: Uint8Array, wanted: Set<string>, limits: Limits = LIMITS): Map<string, Uint8Array> {
  const entries = listZipEntries(data, limits)
  const found = new Map<string, Uint8Array>()
  for (const entry of entries) {
    if (!wanted.has(entry.name)) continue
    found.set(entry.name, readZipEntry(data, entry, limits))
  }
  return found
}

import { createCanvas, loadImage } from '@napi-rs/canvas'
import fs from 'node:fs'
import path from 'node:path'
import { MESSAGES, type Limits } from '../../shared/constants'
import { AppError } from '../errors'
import type { ParsedBlock, ParsedIssue, ParsedPage } from '../parseTypes'

export function rasterSize(bytes: Uint8Array, format: 'png' | 'jpeg'): { width: number; height: number } {
  const size = format === 'png' ? pngSize(bytes) : jpegSize(bytes)
  if (!size || size.width < 1 || size.height < 1) {
    throw new AppError('PARSE_FAILED', '无法从图片文件头读取宽高。')
  }
  return size
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return null
  const type = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0)
  if (type !== 'IHDR') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] ?? 0
    if (marker === 0x00 || marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    if (offset + 4 > bytes.length) return null
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)
    if (length < 2 || offset + 2 + length > bytes.length) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (offset + 9 >= bytes.length) return null
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0)
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0)
      return { width, height }
    }
    offset += 2 + length
  }
  return null
}

export async function parseRasterImage(input: {
  bytes: Uint8Array
  format: 'png' | 'jpeg'
  documentVersionId: string
  workDir: string
  limits: Limits
}): Promise<{ pages: ParsedPage[]; blocks: ParsedBlock[]; issues: ParsedIssue[] }> {
  const declared = rasterSize(input.bytes, input.format)
  assertPixels(declared.width, declared.height, input.limits)
  let decoded: { width: number; height: number; png: Buffer }
  try {
    const image = await loadImage(Buffer.from(input.bytes))
    assertPixels(image.width, image.height, input.limits)
    const canvas = createCanvas(image.width, image.height)
    const context = canvas.getContext('2d') as unknown as { drawImage: (source: unknown, x: number, y: number) => void }
    context.drawImage(image, 0, 0)
    decoded = { width: image.width, height: image.height, png: canvas.toBuffer('image/png') }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('PARSE_FAILED', '图片无法安全解码，因此没有生成预览。原件已保留，但内容没有被读取。')
  }
  const imagePath = path.join(input.workDir, 'page-0001.png')
  fs.writeFileSync(imagePath, decoded.png)
  const issues: ParsedIssue[] = [
    {
      pageOrdinal: 1,
      blockOrdinal: 1,
      code: 'NO_OCR',
      message: MESSAGES.noOcr,
      reviewState: 'needs_review',
    },
  ]
  return {
    pages: [
      {
        ordinal: 1,
        sourceKind: 'image',
        sourceNumber: 1,
        width: decoded.width,
        height: decoded.height,
        status: 'needs_review',
        imagePath,
      },
    ],
    blocks: [
      {
        ordinal: 1,
        pageOrdinal: 1,
        kind: 'image_region',
        text: MESSAGES.noOcr,
        locator: {
          documentVersionId: input.documentVersionId,
          pageNumber: 1,
          bbox: [0, 0, 1, 1],
        },
        extractionMethod: 'none',
        reviewState: 'needs_review',
      },
    ],
    issues,
  }
}

function assertPixels(width: number, height: number, limits: Limits): void {
  if (width > limits.maxImageEdge || height > limits.maxImageEdge || width * height > limits.maxImagePixels) {
    throw new AppError('LIMIT_EXCEEDED', '图片像素尺寸超过上限，已拒绝解码。')
  }
}

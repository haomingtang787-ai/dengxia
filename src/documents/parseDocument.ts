import fs from 'node:fs'
import path from 'node:path'
import { MESSAGES } from '../shared/constants'
import { realpathInside, resolveInside } from '../storage/paths'
import { AppError, isAppError } from './errors'
import type { ParseDeps, ParseResult, ParseTask, ParsedPage } from './parseTypes'
import { parseRasterImage } from './parsers/image'
import { parsePdfFile } from './parsers/pdf'
import { parseDocxXml } from './parsers/docx'
import { parsePptxXml } from './parsers/pptx'
import { renderPptxSlides } from './parsers/pptxRender'
import { parseMarkdown, parsePlainText } from './parsers/text'
import { windowsOfficeIsolation } from '../providers/isolation'
import { convertWithLibreOffice } from '../providers/libreoffice'

export async function parseDocument(task: ParseTask, deps: ParseDeps = {}): Promise<ParseResult> {
  await Promise.resolve()
  try {
    if (deps.signal?.aborted) throw new AppError('PARSE_FAILED', '处理已取消。')
    const abs = resolveInside(task.dataRoot, task.originalRelpath)
    const real = abs ? realpathInside(task.dataRoot, abs) : null
    if (!real) throw new AppError('FILE_UNREADABLE', '原文不在本机资料目录内。')
    const bytes = fs.readFileSync(real)
    if (bytes.byteLength > task.limits.maxFileBytes) {
      throw new AppError('LIMIT_EXCEEDED', '文件超过本阶段的大小上限。')
    }
    fs.mkdirSync(task.workDir, { recursive: true })
    if (task.format === 'txt') {
      const parsed = parsePlainText(bytes, task.documentVersionId, task.limits)
      return finish(parsed.blocks, [], parsed.issues, null)
    }
    if (task.format === 'markdown') {
      const parsed = parseMarkdown(bytes, task.documentVersionId, task.limits)
      return finish(parsed.blocks, [], parsed.issues, null)
    }
    if (task.format === 'png' || task.format === 'jpeg') {
      const parsed = await parseRasterImage({
        bytes,
        format: task.format,
        documentVersionId: task.documentVersionId,
        workDir: task.workDir,
        limits: task.limits,
      })
      return finish(parsed.blocks, parsed.pages, parsed.issues, null)
    }
    if (task.format === 'pdf') {
      const parsed = await parsePdfFile({
        filePath: real,
        documentVersionId: task.documentVersionId,
        workDir: task.workDir,
        limits: task.limits,
        sourceKind: 'pdf',
        signal: deps.signal,
        onProgress: deps.onProgress,
      })
      return finish(parsed.blocks, parsed.pages, parsed.issues, parsed.sourceMetadata)
    }
    const structured = task.format === 'docx'
      ? parseDocxXml(bytes, task.documentVersionId, task.limits, task.workDir)
      : parsePptxXml(bytes, task.documentVersionId, task.limits)
    const structuredPages: ParsedPage[] = 'pages' in structured ? (structured.pages as ParsedPage[]) : []
    let fallbackPages: ParsedPage[] = structuredPages
    const issues = [...structured.issues]
    let pptxRenderAttempted = false
    const ensurePptxRender = async (): Promise<void> => {
      if (task.format !== 'pptx' || structuredPages.length === 0 || pptxRenderAttempted) return
      pptxRenderAttempted = true
      try {
        const rendered = await renderPptxSlides({
          bytes,
          pages: structuredPages,
          workDir: task.workDir,
          limits: task.limits,
          onProgress: deps.onProgress,
        })
        fallbackPages = rendered.pages
        issues.push(...rendered.issues)
      } catch (error) {
        issues.push({
          pageOrdinal: null,
          blockOrdinal: null,
          code: 'PPTX_RENDER_FAILED',
          message: `幻灯片逐页渲染没有完成：${error instanceof Error ? error.message.slice(0, 160) : '未知错误'}`,
          reviewState: 'needs_review',
        })
      }
    }
    if (structuredPages.length === 0) {
      issues.push({
        pageOrdinal: null,
        blockOrdinal: null,
        code: task.format === 'docx' ? 'ANCHOR_NOT_ON_PAGE' : 'SLIDE_NOT_ON_PAGE',
        message: task.format === 'docx' ? MESSAGES.paragraphPages : MESSAGES.slidePages,
        reviewState: 'unverified',
      })
    }
    const isolation = windowsOfficeIsolation()
    if (!isolation.verified) {
      issues.push({
        pageOrdinal: null,
        blockOrdinal: null,
        code: task.office.mode === 'skip' ? task.office.code : 'CONVERSION_FAILED',
        message: task.office.mode === 'skip' ? task.office.message : isolation.reason,
        reviewState: 'needs_review',
      })
      await ensurePptxRender()
      return finish(structured.blocks, fallbackPages, issues, structured.sourceMetadata)
    }
    if (task.office.mode === 'skip') {
      issues.push({
        pageOrdinal: null,
        blockOrdinal: null,
        code: task.office.code,
        message: task.office.message,
        reviewState: 'needs_review',
      })
      await ensurePptxRender()
      return finish(structured.blocks, fallbackPages, issues, structured.sourceMetadata)
    }
    const convert = deps.convertOfficeToPdf ?? convertWithLibreOffice
    const outDir = path.join(task.workDir, 'office-pdf')
    fs.mkdirSync(outDir, { recursive: true })
    const signal = deps.signal ?? new AbortController().signal
    const converted = await convert(task.office.executable, real, outDir, signal)
    if (!converted.ok) {
      issues.push({
        pageOrdinal: null,
        blockOrdinal: null,
        code: 'CONVERSION_FAILED',
        message: `${MESSAGES.conversionFailed} ${converted.message}`,
        reviewState: 'needs_review',
      })
      await ensurePptxRender()
      return finish(structured.blocks, fallbackPages, issues, structured.sourceMetadata)
    }
    deps.onProgress?.({ stage: 'render', completed: 0, total: null })
    const rendered = await parsePdfFile({
      filePath: converted.pdfPath,
      documentVersionId: task.documentVersionId,
      workDir: task.workDir,
      limits: task.limits,
      sourceKind: task.format === 'pptx' ? 'slide' : 'libreoffice-pdf',
      signal: deps.signal,
      onProgress: deps.onProgress,
    })
    const slidePage = new Map<number, number>()
    for (const page of rendered.pages) {
      if (page.sourceNumber !== null) slidePage.set(page.sourceNumber, page.ordinal)
    }
    const structuredBlocks = structured.blocks.map((block) => {
      if (task.format !== 'pptx' || block.locator.slideNumber === undefined) return block
      const ordinal = slidePage.get(block.locator.slideNumber)
      return ordinal === undefined
        ? { ...block, pageOrdinal: null }
        : { ...block, pageOrdinal: ordinal, locator: { ...block.locator, pageNumber: ordinal } }
    })
    // The structured PPTX text already carries every slide's words. The PDF
    // rendering exists for the per-slide image, not for a second copy of the
    // same text.
    const renderedBlocks = task.format === 'pptx' && structured.blocks.length > 0 ? [] : rendered.blocks
    const blocks = [
      ...structuredBlocks,
      ...renderedBlocks.map((block, index) => ({ ...block, ordinal: structured.blocks.length + index + 1 })),
    ]
    return finish(blocks, rendered.pages, [...issues, ...rendered.issues], structured.sourceMetadata ?? rendered.sourceMetadata)
  } catch (error) {
    if (isAppError(error)) {
      return {
        pages: [],
        blocks: [],
        issues: [
          {
            pageOrdinal: null,
            blockOrdinal: null,
            code: error.code,
            message: error.message,
            reviewState: 'needs_review',
          },
        ],
        sourceMetadata: null,
        outcome: 'failed',
        error: { code: error.code, message: error.message },
      }
    }
    return {
      pages: [],
      blocks: [],
      issues: [],
      sourceMetadata: null,
      outcome: 'failed',
      error: { code: 'PARSE_FAILED', message: '解析时出现未预期的错误。' },
    }
  }
}

function finish(
  blocks: ParseResult['blocks'],
  pages: ParseResult['pages'],
  issues: ParseResult['issues'],
  sourceMetadata: ParseResult['sourceMetadata'],
): ParseResult {
  const needsReview = issues.some((issue) => issue.reviewState === 'needs_review') || blocks.some((block) => block.reviewState === 'needs_review') || pages.some((page) => page.status === 'needs_review')
  if (!blocks.length && !pages.length) {
    return {
      pages,
      blocks,
      issues,
      sourceMetadata,
      outcome: 'failed',
      error: { code: 'PARSE_FAILED', message: '没有得到可预览的内容。' },
    }
  }
  return {
    pages,
    blocks,
    issues,
    sourceMetadata,
    outcome: needsReview ? 'partial' : 'succeeded',
  }
}

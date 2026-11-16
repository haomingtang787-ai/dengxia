import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { parsePptxXml } from '../src/documents/parsers/pptx'
import { renderPptxSlides } from '../src/documents/parsers/pptxRender'

describe('80-page PPTX render smoke', () => {
  it('turns all 80 slides into readable page images', async () => {
    const file = path.join(os.tmpdir(), 'desk-80-pages.pptx')
    expect(fs.existsSync(file)).toBe(true)
    const bytes = fs.readFileSync(file)
    const parsed = parsePptxXml(bytes, '11111111-1111-4111-8111-111111111111', LIMITS)
    expect(parsed.pages).toHaveLength(80)
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-80-render-'))
    const rendered = await renderPptxSlides({ bytes, pages: parsed.pages, workDir: work, limits: LIMITS })
    expect(rendered.pages).toHaveLength(80)
    expect(rendered.pages.every((page) => page.imagePath && fs.existsSync(page.imagePath))).toBe(true)
    expect(rendered.pages[0]?.width).toBe(1280)
    expect(rendered.pages[0]?.height).toBe(720)
    fs.copyFileSync(rendered.pages[0]!.imagePath!, path.join(os.tmpdir(), 'desk-80-preview.png'))
    fs.rmSync(work, { recursive: true, force: true })
  })
})

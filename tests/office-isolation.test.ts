import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocument } from '../src/documents/parseDocument'
import { LIMITS } from '../src/shared/constants'
import { IPC_INVOKE_CHANNELS } from '../src/shared/ipc'
import { convertWithLibreOffice, libreOfficeVersion, probeLibreOffice } from '../src/providers/libreoffice'
import { windowsOfficeIsolation } from '../src/providers/isolation'
import { LocalOfficeGateway } from '../src/providers/officeGateway'
import { SettingsStore } from '../src/providers/settings'
import { makeDocx, makePdf, SAMPLE_MD, SAMPLE_TXT } from './helpers/builders'
import { createHarness, writeTemp } from './helpers/app'

function sentinelOffice(dir: string): { exe: string; marker: string } {
  const marker = path.join(dir, 'soffice-launched')
  const exe = path.join(dir, 'soffice')
  fs.writeFileSync(exe, `#!/bin/sh\nprintf launched > '${marker}'\n`, { mode: 0o755 })
  return { exe, marker }
}

describe('office isolation fail closed', () => {
  it('does not launch soffice for version, probe, or conversion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-sentinel-'))
    const { exe, marker } = sentinelOffice(dir)
    const version = await libreOfficeVersion(exe)
    const probe = await probeLibreOffice(exe)
    const converted = await convertWithLibreOffice(exe, path.join(dir, 'in.docx'), path.join(dir, 'out'), new AbortController().signal)
    expect(version.ok).toBe(false)
    expect(probe.ok).toBe(false)
    expect(converted.ok).toBe(false)
    if (!version.ok) expect(version.message).toContain('没有启动')
    if (!converted.ok) expect(converted.message).toContain('没有启动')
    expect(fs.existsSync(marker)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('ignores forged settings, environment, and a convert-mode task', async () => {
    const previous = process.env.DESK_ALLOW_UNSANDBOXED_OFFICE
    process.env.DESK_ALLOW_UNSANDBOXED_OFFICE = '1'
    process.env.ALLOW_UNSANDBOXED_OFFICE_CONVERSION = '1'
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-forged-'))
    try {
      expect(windowsOfficeIsolation().verified).toBe(false)
      const { exe, marker } = sentinelOffice(dir)
      const store = new SettingsStore(path.join(dir, 'settings.json'))
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({
          libreOfficePath: exe,
          allowUnsandboxedOfficeConversion: true,
          probe: { ok: true, executable: exe, version: 'LibreOffice 99', message: 'forged', probedAt: '2026-01-01T00:00:00.000Z' },
        }),
      )
      expect(store.load()).toEqual({ libreOfficePath: exe, ai: null })
      store.save(store.load())
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>
      expect(saved.allowUnsandboxedOfficeConversion).toBeUndefined()
      expect(saved.probe).toBeUndefined()

      let convertCalls = 0
      const app = await createHarness({
        office: new LocalOfficeGateway(),
        deps: {
          async convertOfficeToPdf() {
            convertCalls += 1
            fs.writeFileSync(marker, 'converter')
            return { ok: false, message: 'must not run' }
          },
        },
      })
      fs.copyFileSync(path.join(dir, 'settings.json'), path.join(app.root, 'settings.json'))
      const requestId = randomUUID()
      const imported = await app.importFile(writeTemp('lesson.docx', makeDocx()), requestId, 'window-a')
      expect(imported.ok).toBe(true)
      if (!imported.ok) return
      const forged = await app.service.import('window-a', {
        handle: '11111111-1111-4111-8111-111111111111',
        requestId,
        allowUnsandboxedOfficeConversion: true,
        office: { mode: 'convert', executable: exe },
      })
      expect(forged.ok).toBe(true)
      if (forged.ok) expect(forged.data.jobId).toBe(imported.data.jobId)
      await app.service.settle()
      const detail = app.service.get({ documentVersionId: imported.data.documentVersionId })
      expect(detail.ok).toBe(true)
      if (detail.ok) {
        expect(detail.data.warnings.some((warning) => warning.code === 'CONVERSION_FAILED')).toBe(true)
        expect(detail.data.warnings.some((warning) => warning.code === 'CONVERTER_MISSING')).toBe(false)
        expect(detail.data.warnings.some((warning) => warning.message.includes('没有启动'))).toBe(true)
      }
      const pages = app.service.pages({ documentVersionId: imported.data.documentVersionId })
      expect(pages.ok && pages.data.total).toBe(0)
      expect(convertCalls).toBe(0)
      expect(fs.existsSync(marker)).toBe(false)
      const status = await app.service.prerequisites()
      expect(status.ok && status.data.libreOffice.launched).toBe(false)
      expect(status.ok && status.data.libreOffice.version).toBeNull()
      expect(status.ok && status.data.sandbox.officeConversionWillRun).toBe(false)
      expect(status.ok && status.data.sandbox.windowsSandboxVerified).toBe(false)

      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-task-'))
      const workDir = path.join(dataRoot, 'work')
      fs.mkdirSync(workDir, { recursive: true })
      const original = path.join(dataRoot, 'originals', 'lesson.docx')
      fs.mkdirSync(path.dirname(original), { recursive: true })
      fs.writeFileSync(original, makeDocx())
      const parsed = await parseDocument(
        {
          jobId: 'job',
          documentVersionId: '11111111-1111-4111-8111-111111111111',
          format: 'docx',
          dataRoot,
          originalRelpath: 'originals/lesson.docx',
          workDir,
          limits: LIMITS,
          office: { mode: 'convert', executable: exe },
        },
        {
          async convertOfficeToPdf() {
            convertCalls += 1
            fs.writeFileSync(marker, 'direct')
            return { ok: false, message: 'must not run' }
          },
        },
      )
      expect(parsed.outcome).not.toBe('succeeded')
      expect(parsed.pages).toHaveLength(0)
      expect(parsed.issues.some((issue) => issue.message.includes('没有启动'))).toBe(true)
      expect(convertCalls).toBe(0)
      expect(fs.existsSync(marker)).toBe(false)
      await app.cleanup()
      fs.rmSync(dataRoot, { recursive: true, force: true })
    } finally {
      if (previous === undefined) delete process.env.DESK_ALLOW_UNSANDBOXED_OFFICE
      else process.env.DESK_ALLOW_UNSANDBOXED_OFFICE = previous
      delete process.env.ALLOW_UNSANDBOXED_OFFICE_CONVERSION
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the IPC whitelist free of an unsandboxed-conversion channel', () => {
    expect(IPC_INVOKE_CHANNELS).not.toContain('prerequisites.setUnsandboxed')
    expect(IPC_INVOKE_CHANNELS).toContain('prerequisites.recheck')
  })

  it('leaves PDF, images, text, and markdown independent of the Office gate', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const app = await createHarness()
    const text = await app.importFile(writeTemp('note.txt', SAMPLE_TXT))
    const markdown = await app.importFile(writeTemp('outline.md', SAMPLE_MD))
    const pdf = await app.importFile(writeTemp('hello.pdf', makePdf(['BT /F1 24 Tf 72 720 Td (Hello PDF) Tj ET'])))
    const image = await app.importFile(writeTemp('dot.png', png))
    expect(text.ok && markdown.ok && pdf.ok && image.ok).toBe(true)
    if (!text.ok || !markdown.ok || !pdf.ok || !image.ok) return
    await app.service.settle()
    const textJob = app.service.job({ jobId: text.data.jobId })
    const markdownJob = app.service.job({ jobId: markdown.data.jobId })
    expect(textJob.ok && textJob.data.state).toBe('succeeded')
    expect(markdownJob.ok && markdownJob.data.state).toBe('partial')
    const pdfPages = app.service.pages({ documentVersionId: pdf.data.documentVersionId })
    expect(pdfPages.ok && pdfPages.data.total).toBe(1)
    const imageDetail = app.service.get({ documentVersionId: image.data.documentVersionId })
    expect(imageDetail.ok && imageDetail.data.warnings.some((warning) => warning.code === 'NO_OCR')).toBe(true)
    for (const versionId of [text.data.documentVersionId, markdown.data.documentVersionId, pdf.data.documentVersionId, image.data.documentVersionId]) {
      const detail = app.service.get({ documentVersionId: versionId })
      expect(detail.ok && detail.data.warnings.some((warning) => warning.code === 'CONVERSION_FAILED' || warning.code === 'CONVERTER_MISSING')).toBe(false)
    }
    await app.cleanup()
  })
})

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SAMPLE_TXT } from './helpers/builders'
import { createHarness, writeTemp } from './helpers/app'

describe('handles', () => {
  it('returns an empty list when the picker is cancelled', async () => {
    const app = await createHarness()
    const picked = await app.service.pick('window-a')
    expect(picked.ok && picked.data).toEqual({ cancelled: true, files: [] })
    await app.cleanup()
  })

  it('is single-use and window-scoped, and ignores a submitted path', async () => {
    const app = await createHarness()
    const file = writeTemp('note.txt', SAMPLE_TXT)
    app.prepare(file)
    const picked = await app.service.pick('window-a')
    expect(picked.ok && picked.data.cancelled).toBe(false)
    if (!picked.ok || picked.data.cancelled) return
    const handle = picked.data.files[0]?.handle ?? ''
    const first = await app.service.import('window-a', { handle, requestId: randomUUID() })
    expect(first.ok).toBe(true)
    const again = await app.service.import('window-a', { handle, requestId: randomUUID() })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error.code).toBe('CONFLICT')
    app.prepare(file)
    const otherWindow = await app.service.pick('window-b')
    expect(otherWindow.ok && otherWindow.data.cancelled).toBe(false)
    if (otherWindow.ok && !otherWindow.data.cancelled) {
      const stolen = await app.service.import('window-a', {
        handle: otherWindow.data.files[0]?.handle,
        requestId: randomUUID(),
      })
      expect(stolen.ok).toBe(false)
      if (!stolen.ok) expect(stolen.error.code).toBe('NOT_FOUND')
    }
    const pathAttempt = await app.service.import('window-a', { handle: file, requestId: randomUUID() })
    expect(pathAttempt.ok).toBe(false)
    if (!pathAttempt.ok) expect(pathAttempt.error.code).toBe('INVALID_ARGUMENT')
    await app.service.settle()
    await app.cleanup()
  })

  it('drops handles when the window closes', async () => {
    const app = await createHarness()
    const file = writeTemp('note.txt', SAMPLE_TXT)
    app.prepare(file)
    const picked = await app.service.pick('window-a')
    expect(picked.ok && picked.data.cancelled).toBe(false)
    if (!picked.ok || picked.data.cancelled) return
    const handle = picked.data.files[0]?.handle ?? ''
    app.service.dropWindow('window-a')
    const late = await app.service.import('window-a', { handle, requestId: randomUUID() })
    expect(late.ok).toBe(false)
    if (!late.ok) expect(late.error.code).toBe('NOT_FOUND')
    await app.cleanup()
  })
})

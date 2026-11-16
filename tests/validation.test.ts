import { describe, expect, it } from 'vitest'
import { parseBlocksQuery, parseImportBody, parsePagination } from '../src/domain/validation'
import { createHarness } from './helpers/app'

describe('validation', () => {
  it('rejects bad pagination and accepts the default page', () => {
    expect(parsePagination({})).toEqual({ offset: 0, limit: 50 })
    expect(() => parsePagination({ limit: 201 })).toThrow(/limit/)
    expect(() => parsePagination({ offset: -1 })).toThrow(/offset/)
    expect(() => parsePagination({ limit: 1.5 })).toThrow(/整数/)
  })

  it('requires an explicit unpaged scope for text without pages', () => {
    expect(() => parseBlocksQuery({ offset: 0, limit: 10 })).toThrow(/unpaged|pageId/)
    const parsed = parseBlocksQuery({
      documentVersionId: '11111111-1111-4111-8111-111111111111',
      scope: 'unpaged',
    })
    expect(parsed.kind).toBe('unpaged')
  })

  it('rejects a filesystem path submitted as a handle', () => {
    expect(() => parseImportBody({ handle: '/tmp/secret.docx', requestId: '11111111-1111-4111-8111-111111111111' })).toThrow(/handle/)
  })

  it('returns INVALID_ARGUMENT from the service for a bad list request', async () => {
    const app = await createHarness()
    const result = app.service.list({ limit: 500 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT')
    await app.cleanup()
  })
})

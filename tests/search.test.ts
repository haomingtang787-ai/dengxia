import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './helpers/app'
import { Store } from '../src/storage/store'
import { buildFtsQuery, snippetText } from '../src/shared/search'

const apps: Harness[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.cleanup()
})

describe('全文搜索与跳页定位', () => {
  it('把正文块索引成可按页跳转的结果，并在删除文稿时清掉索引', async () => {
    const app = await createHarness()
    apps.push(app)
    const store = new Store(app.db)
    const docId = randomUUID()
    const versionId = randomUUID()
    const pageId = randomUUID()
    const blockId = randomUUID()
    store.insertDocument({ id: docId, display_name: '线性代数讲义.pdf', created_at: '2026-11-16T10:00:00.000Z' })
    store.insertVersion({
      id: versionId,
      document_id: docId,
      sha256: 'b'.repeat(64),
      format: 'pdf',
      size_bytes: 2048,
      original_relpath: `originals/${versionId}.pdf`,
      status: 'ready',
      parser_version: '9',
      created_at: '2026-11-16T10:00:00.000Z',
    })
    store.insertPage({
      id: pageId,
      document_version_id: versionId,
      ordinal: 12,
      source_kind: 'pdf',
      source_number: 12,
      image_relpath: null,
      width: null,
      height: null,
      status: 'ready',
    })
    store.insertBlock({
      id: blockId,
      document_version_id: versionId,
      page_id: pageId,
      ordinal: 1,
      kind: 'paragraph',
      text: '矩阵的特征值之和等于迹，特征值之积等于行列式。',
      locator_json: '{"kind":"pdf","pageNumber":12}',
      extraction_method: 'pdf-text',
      review_state: 'unverified',
    })
    store.reindexVersion(versionId)

    const hit = app.service.search({ query: '特征值 迹' })
    expect(hit.ok).toBe(true)
    if (!hit.ok) return
    expect(hit.data.total).toBe(1)
    expect(hit.data.items[0].documentVersionId).toBe(versionId)
    expect(hit.data.items[0].pageNumber).toBe(12)
    expect(hit.data.items[0].pageId).toBe(pageId)
    expect(hit.data.items[0].blockId).toBe(blockId)
    expect(hit.data.items[0].snippet).toContain('特征值')

    const empty = app.service.search({ query: '   ' })
    expect(empty.ok && empty.data.total).toBe(0)
    const special = app.service.search({ query: '"矩阵" OR *' })
    expect(special.ok).toBe(true)
    if (special.ok) expect(special.data.total).toBe(0)

    store.deleteDocument(docId)
    const afterDelete = app.service.search({ query: '特征值' })
    expect(afterDelete.ok && afterDelete.data.total).toBe(0)
  })

  it('搜索词按字面 token 处理，片段保留命中位置', () => {
    expect(buildFtsQuery('矩阵 特征值')).toBe('"矩" AND "矩阵" AND "阵" AND "特" AND "特征" AND "征" AND "征值" AND "值"')
    expect(buildFtsQuery('a"b')).toBe('"a" AND "b"')
    expect(buildFtsQuery('   ')).toBe('')
    expect(snippetText('前文'.repeat(40) + '矩阵特征值' + '后文'.repeat(40), '矩阵')).toContain('矩阵特征值')
    expect(snippetText('普通正文', '没有')).toBe('普通正文')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/providers/settings'

const dirs: string[] = []
function tempDir(): string {
  const dir = path.join(os.tmpdir(), `desk-settings-${randomUUID()}`)
  fs.mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('设置里的模型名', () => {
  it('把已退役的 deepseek-chat / deepseek-reasoner 迁到 deepseek-flash', () => {
    for (const legacy of ['deepseek-chat', 'deepseek-reasoner']) {
      const store = new SettingsStore(path.join(tempDir(), 'settings.json'))
      store.save({
        libreOfficePath: null,
        ai: { baseUrl: 'https://api.deepseek.com/v1', model: legacy, apiKey: 'k' },
        review: { cardsPerDay: 10, missesPerDay: 5, remind: true },
        pinnedDocumentIds: [],
      })
      expect(store.load().ai?.model).toBe('deepseek-flash')
    }
  })

  it('老设置没有复习/置顶字段时给默认值，新值超范围会被钳制', () => {
    const file = path.join(tempDir(), 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ libreOfficePath: null, ai: null }))
    const store = new SettingsStore(file)
    expect(store.load()).toMatchObject({
      pinnedDocumentIds: [],
      review: { cardsPerDay: 10, missesPerDay: 5, remind: true },
    })

    store.save({
      libreOfficePath: null,
      ai: null,
      review: { cardsPerDay: 999, missesPerDay: -3, remind: 'yes' as unknown as boolean },
      pinnedDocumentIds: ['doc-a', 'doc-a', 'doc-b'],
    })
    const loaded = store.load()
    expect(loaded.review).toEqual({ cardsPerDay: 200, missesPerDay: 0, remind: true })
    expect(loaded.pinnedDocumentIds).toEqual(['doc-a', 'doc-b'])
  })
})

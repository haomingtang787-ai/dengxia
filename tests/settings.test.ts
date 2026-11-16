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
      })
      expect(store.load().ai?.model).toBe('deepseek-flash')
    }
  })
})

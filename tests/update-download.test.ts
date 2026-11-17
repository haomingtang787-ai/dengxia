import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({ root: '' }))
const openPath = vi.hoisted(() => vi.fn(async () => ''))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.5.6', getPath: () => state.root },
  shell: { openPath },
}))

import { AppInfoService } from '../src/app/info'

const assetUrl = 'https://github.com/haomingtang787-ai/dengxia/releases/download/v0.5.6/DengXia-setup-0.5.6.exe'
const apiAssetUrl = 'https://api.github.com/repos/haomingtang787-ai/dengxia/releases/assets/123456'
const assetName = 'DengXia-setup-0.5.6.exe'
const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

describe('应用内更新下载', () => {
  beforeEach(() => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'dengxia-update-'))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    fs.rmSync(state.root, { recursive: true, force: true })
  })

  it('把 release 安装包下载到 updates 并回报 100%', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    })))
    const events: Array<{ received: number; total: number; percent: number }> = []
    const result = await new AppInfoService().downloadUpdate(
      { assetUrl, assetName, assetSize: bytes.byteLength },
      (_channel, progress) => events.push(progress),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.size).toBe(bytes.byteLength)
    expect(fs.readFileSync(result.data.filePath)).toEqual(Buffer.from(bytes))
    expect(events.at(-1)?.percent).toBe(100)
  })

  it('接受 API asset 地址并发送二进制 Accept', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const events: Array<{ received: number; total: number; percent: number }> = []
    const result = await new AppInfoService().downloadUpdate(
      { assetUrl: apiAssetUrl, assetName, assetSize: bytes.byteLength },
      (_channel, progress) => events.push(progress),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(fetchMock).toHaveBeenCalledWith(apiAssetUrl, expect.objectContaining({
      headers: expect.objectContaining({ accept: 'application/octet-stream' }),
    }))
    expect(fs.readFileSync(result.data.filePath)).toEqual(Buffer.from(bytes))
    expect(events.at(-1)?.percent).toBe(100)
  })

  it('拒绝非 GitHub release 地址与错误大小，并删掉半截文件', async () => {
    const service = new AppInfoService()
    const rejected = await service.downloadUpdate(
      { assetUrl: 'https://example.com/DengXia-setup-0.5.6.exe', assetName, assetSize: null },
      () => undefined,
    )
    expect(rejected.ok).toBe(false)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })))
    const mismatch = await service.downloadUpdate({ assetUrl, assetName, assetSize: 99 }, () => undefined)
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error.code).toBe('NETWORK_ERROR')
    expect(fs.existsSync(path.join(state.root, 'updates', assetName))).toBe(false)
  })

  it('只允许打开 updates 目录里的 exe', async () => {
    const service = new AppInfoService()
    const updates = path.join(state.root, 'updates')
    fs.mkdirSync(updates, { recursive: true })
    const inside = path.join(updates, assetName)
    fs.writeFileSync(inside, 'x')
    await expect(service.openUpdate({ filePath: inside })).resolves.toMatchObject({ ok: true, data: { opened: true } })

    const outside = path.join(state.root, assetName)
    fs.writeFileSync(outside, 'x')
    await expect(service.openUpdate({ filePath: outside })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
  })
})

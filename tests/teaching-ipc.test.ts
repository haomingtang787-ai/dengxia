import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
}))

import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { AiService } from '../src/ai/service'
import type { DocumentService } from '../src/documents/service'
import type { ImageService } from '../src/images/service'
import type { StudyService } from '../src/study/service'
import type { TeachingService } from '../src/teaching/service'
import type { AppInfoService } from '../src/app/info'
import { registerIpc } from '../src/main/ipc'
import { IPC_INVOKE_CHANNELS, IpcChannel } from '../src/shared/ipc'

function fakeIpc(): { ipc: IpcMain; handlers: Map<string, (event: unknown, body: unknown) => unknown> } {
  const handlers = new Map<string, (event: unknown, body: unknown) => unknown>()
  const ipc = {
    handle(channel: string, fn: (event: unknown, body: unknown) => unknown) {
      handlers.set(channel, fn)
    },
  }
  return { ipc: ipc as unknown as IpcMain, handlers }
}

describe('IPC 装配', () => {
  it('每个声明的 invoke 通道都真的绑了处理函数', () => {
    const { ipc, handlers } = fakeIpc()
    const returned = registerIpc(ipc, {} as DocumentService, {} as TeachingService, {} as AiService, {} as ImageService, {} as StudyService, {} as AppInfoService)
    expect(returned).toEqual([...IPC_INVOKE_CHANNELS])
    for (const channel of IPC_INVOKE_CHANNELS) {
      expect(typeof handlers.get(channel), channel).toBe('function')
    }
  })

  it('授课通道会把请求交给 TeachingService 并原样返回 Result', async () => {
    const { ipc, handlers } = fakeIpc()
    const list = vi.fn(() => ({ ok: true as const, requestId: 'r', data: { items: [] } }))
    const teaching = { list } as unknown as TeachingService
    registerIpc(ipc, {} as DocumentService, teaching, {} as AiService, {} as ImageService, {} as StudyService, {} as AppInfoService)
    const handler = handlers.get(IpcChannel.teachingLecturesList)
    expect(handler).toBeDefined()
    const result = await handler?.({} as IpcMainInvokeEvent, {})
    expect(list).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, data: { items: [] } })
  })

  it('模型通道交给 AiService，密钥不出主进程', async () => {
    const { ipc, handlers } = fakeIpc()
    const status = vi.fn(() => ({ ok: true as const, requestId: 'r', data: { configured: false, baseUrl: '', model: '', hasKey: false } }))
    const ai = { status } as unknown as AiService
    registerIpc(ipc, {} as DocumentService, {} as TeachingService, ai, {} as ImageService, {} as StudyService, {} as AppInfoService)
    const result = await handlers.get(IpcChannel.aiStatus)?.({} as IpcMainInvokeEvent, {})
    expect(status).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, data: { hasKey: false } })
  })
})

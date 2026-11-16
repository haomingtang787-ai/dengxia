import { app, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ok, fail, type Result } from '../shared/contract'
import type { AppInfo, UpdateCheckResult, UpdateDownloadProgress, UpdateDownloadResult, ReleaseAsset } from '../shared/app'
import { compareVersions, pickSetupAsset } from '../shared/app'
import { IpcChannel } from '../shared/ipc'

type ReleaseAssetItem = ReleaseAsset

/**
 * 应用信息 + 更新检查/下载。
 *
 * 「检查更新」从 GitHub 网页端拉取最新 release（仓库已公开，无需鉴权）。
 * 仓库默认是 haomingtang787-ai/dengxia，也可用环境变量 DENGXIA_UPDATE_REPO=owner/repo 覆盖。
 *
 * ⚠️ 数据保留约定（每次更新都必须遵守）：
 *  - 更新只替换应用文件（安装目录里的 exe/asar 等），绝不动用户数据目录；
 *  - 用户数据在 app.getPath('userData') 下（Windows 默认 %APPDATA%/desk-teacher-agent），
 *    里面是 library.sqlite（文稿、课程、对话、用量）和 originals/artifacts；
 *  - 不要把 userData 目录当成临时目录删除或清空；迁移只做加法（schema 版本递增）。
 */
export class AppInfoService {
  info(): Result<AppInfo> {
    return ok(randomUUID(), { version: app.getVersion(), name: '灯下' })
  }

  async checkUpdate(): Promise<Result<UpdateCheckResult>> {
    const current = app.getVersion()
    const repo = (process.env.DENGXIA_UPDATE_REPO ?? 'haomingtang787-ai/dengxia').trim()

    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { 'user-agent': 'dengxia-app', accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) {
        return ok(randomUUID(), {
          status: 'error',
          current,
          latest: null,
          url: null,
          message: `检查更新失败：GitHub 返回 ${response.status}。`,
          ...emptyAsset(),
        })
      }
      const body = (await response.json()) as { tag_name?: string; html_url?: string; assets?: ReleaseAssetItem[] }
      const latest = (body.tag_name ?? '').replace(/^v/, '')
      const url = body.html_url ?? null
      const asset = pickSetupAsset(body.assets)
      if (!latest) {
        return ok(randomUUID(), {
          status: 'up-to-date',
          current,
          latest: null,
          url: null,
          message: '仓库里还没有 release。',
          ...emptyAsset(),
        })
      }
      const newer = compareVersions(latest, current) > 0
      return ok(randomUUID(), newer
        ? {
            status: 'update-available',
            current,
            latest,
            url,
            message: `有新版 ${latest}（当前 ${current}）。下载后覆盖安装即可，课程数据不会丢。`,
            ...asset,
          }
        : {
            status: 'up-to-date',
            current,
            latest,
            url,
            message: `已是最新版 ${current}。`,
            ...asset,
          })
    } catch (error) {
      return ok(randomUUID(), {
        status: 'error',
        current,
        latest: null,
        url: null,
        message: `检查更新失败：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}`,
        ...emptyAsset(),
      })
    }
  }

  /** 把 release 里的 setup 下载到 userData/updates，进度通过 IPC 回给界面。 */
  async downloadUpdate(
    body: unknown,
    send: (channel: string, payload: UpdateDownloadProgress) => void,
  ): Promise<Result<UpdateDownloadResult>> {
    const requestId = randomUUID()
    try {
      const input = parseDownloadBody(body)
      const dir = path.join(app.getPath('userData'), 'updates')
      await fs.promises.mkdir(dir, { recursive: true })
      const destination = path.join(dir, input.assetName)
      await fs.promises.rm(destination, { force: true })

      const response = await fetch(input.assetUrl, {
        headers: { 'user-agent': 'dengxia-app' },
        signal: AbortSignal.timeout(600_000),
        redirect: 'follow',
      })
      if (!response.ok || !response.body) {
        return fail(requestId, 'NETWORK_ERROR', `下载失败：GitHub 返回 ${response.status}。`)
      }
      const total = Number(response.headers.get('content-length') ?? input.assetSize ?? 0)
      let received = 0
      let lastSent = 0
      const handle = await fs.promises.open(destination, 'w')
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const buffer = Buffer.from(value)
          received += buffer.byteLength
          await handle.write(buffer)
          const now = Date.now()
          if (now - lastSent > 200) {
            lastSent = now
            send(IpcChannel.appUpdateProgress, {
              received,
              total,
              percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
            })
          }
        }
      } finally {
        reader.releaseLock()
        await handle.close()
      }
      const size = (await fs.promises.stat(destination)).size
      if (input.assetSize && size !== input.assetSize) {
        await fs.promises.rm(destination, { force: true })
        return fail(requestId, 'NETWORK_ERROR', `安装包大小不对（应为 ${input.assetSize} 字节，实际 ${size}）。`)
      }
      send(IpcChannel.appUpdateProgress, {
        received: size,
        total: input.assetSize || total || size,
        percent: 100,
      })
      return ok(requestId, { filePath: destination, size })
    } catch (error) {
      return fail(requestId, 'NETWORK_ERROR', error instanceof Error ? `下载失败：${error.message.slice(0, 120)}` : '下载失败。')
    }
  }

  /** 只允许打开 updates 目录下的 exe，避免被别的路径带偏。 */
  async openUpdate(body: unknown): Promise<Result<{ opened: boolean }>> {
    const requestId = randomUUID()
    try {
      const filePath = typeof body === 'object' && body && typeof (body as { filePath?: unknown }).filePath === 'string'
        ? (body as { filePath: string }).filePath
        : ''
      const dir = path.join(app.getPath('userData'), 'updates')
      const resolved = path.resolve(filePath)
      if (!resolved || path.dirname(resolved) !== path.resolve(dir) || !resolved.toLowerCase().endsWith('.exe')) {
        return fail(requestId, 'INVALID_ARGUMENT', '安装包路径不对。')
      }
      if (!fs.existsSync(resolved)) return fail(requestId, 'NOT_FOUND', '安装包已经不在了，请重新下载。')
      const opened = await shell.openPath(resolved)
      if (opened) return fail(requestId, 'STORAGE_ERROR', `打开安装包失败：${opened}`)
      return ok(requestId, { opened: true })
    } catch (error) {
      return fail(requestId, 'STORAGE_ERROR', error instanceof Error ? error.message : '打开安装包失败。')
    }
  }
}

function emptyAsset(): Pick<UpdateCheckResult, 'assetUrl' | 'assetName' | 'assetSize'> {
  return { assetUrl: null, assetName: null, assetSize: null }
}

function parseDownloadBody(body: unknown): { assetUrl: string; assetName: string; assetSize: number | null } {
  if (!body || typeof body !== 'object') throw new Error('下载参数缺失')
  const raw = body as Record<string, unknown>
  const assetUrl = typeof raw.assetUrl === 'string' ? raw.assetUrl : ''
  const assetName = typeof raw.assetName === 'string' ? raw.assetName : ''
  if (!/^https:\/\/github\.com\//.test(assetUrl) || !/\/releases\/download\//.test(assetUrl)) {
    throw new Error('下载地址不是 GitHub release。')
  }
  if (!/^DengXia-setup-.*\.exe$/i.test(assetName)) throw new Error('安装包名字不对。')
  const assetSize = typeof raw.assetSize === 'number' && Number.isFinite(raw.assetSize) ? raw.assetSize : null
  return { assetUrl, assetName, assetSize }
}

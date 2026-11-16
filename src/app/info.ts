import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { ok, type Result } from '../shared/contract'
import type { AppInfo, UpdateCheckResult } from '../shared/app'

/**
 * 应用信息 + 更新检查。
 *
 * 「检查更新」从 GitHub 网页端拉取最新 release（仓库已公开，无需鉴权）。
 * 仓库默认是 haomingtang787-ai/dengxia，也可用环境变量 DENGXIA_UPDATE_REPO=owner/repo 覆盖。
 * 想换成自有服务器 / 对象存储，改 checkUpdate() 里的地址与解析即可。
 *
 * ⚠️ 数据保留约定（每次更新都必须遵守）：
 *  - 更新只替换应用文件（安装目录里的 exe/asar 等），绝不动用户数据目录；
 *  - 用户数据在 app.getPath('userData') 下（Windows 默认 %APPDATA%/灯下），
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
        })
      }
      const body = (await response.json()) as { tag_name?: string; html_url?: string }
      const latest = (body.tag_name ?? '').replace(/^v/, '')
      const url = body.html_url ?? null
      if (!latest) {
        return ok(randomUUID(), { status: 'up-to-date', current, latest: null, url: null, message: '仓库里还没有 release。' })
      }
      const newer = compareVersions(latest, current) > 0
      return ok(randomUUID(), newer
        ? { status: 'update-available', current, latest, url, message: `有新版 ${latest}（当前 ${current}）。下载后覆盖安装即可，课程数据不会丢。` }
        : { status: 'up-to-date', current, latest, url, message: `已是最新版 ${current}。` })
    } catch (error) {
      return ok(randomUUID(), {
        status: 'error',
        current,
        latest: null,
        url: null,
        message: `检查更新失败：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}`,
      })
    }
  }
}

/** 语义化版本号比较：返回 1 表示 a 比 b 新。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

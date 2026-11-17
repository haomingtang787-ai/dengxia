export type AppInfo = {
  version: string
  name: string
}

export type UpdateCheckStatus = 'unconfigured' | 'checking' | 'up-to-date' | 'update-available' | 'error'

export type UpdateCheckResult = {
  status: UpdateCheckStatus
  current: string
  latest: string | null
  url: string | null
  message: string
  /** GitHub release 里挂的安装包；没挂或名字不对时为 null。 */
  assetUrl: string | null
  assetName: string | null
  assetSize: number | null
}

export type UpdateDownloadProgress = { received: number; total: number; percent: number }

export type UpdateDownloadResult = { filePath: string; size: number }

export type ReleaseAsset = {
  name?: unknown
  size?: unknown
  /** GitHub API 的 asset endpoint；当前网络下比 browser_download_url 更可靠。 */
  url?: unknown
  browser_download_url?: unknown
}

/** 只认 `DengXia-setup-x.y.z.exe`，避免把 blockmap 或别的文件当安装包。 */
export function pickSetupAsset(
  assets: ReleaseAsset[] | undefined,
): Pick<UpdateCheckResult, 'assetUrl' | 'assetName' | 'assetSize'> {
  const found = (assets ?? []).find((asset) => {
    const name = typeof asset.name === 'string' ? asset.name : ''
    return /^DengXia-setup-.*\.exe$/i.test(name)
      && (typeof asset.url === 'string' || typeof asset.browser_download_url === 'string')
  })
  if (!found || typeof found.name !== 'string') {
    return { assetUrl: null, assetName: null, assetSize: null }
  }
  const assetUrl = typeof found.url === 'string'
    ? found.url
    : typeof found.browser_download_url === 'string' ? found.browser_download_url : ''
  if (!assetUrl) return { assetUrl: null, assetName: null, assetSize: null }
  return {
    assetUrl,
    assetName: found.name,
    assetSize: typeof found.size === 'number' && Number.isFinite(found.size) ? found.size : null,
  }
}

/** 语义化版本号比较：返回 1 表示 a 比 b 新。 */
export function compareVersions(a: string, b: string): number {
  const clean = (value: string): string => value.trim().replace(/^v/i, '')
  const pa = clean(a).split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = clean(b).split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

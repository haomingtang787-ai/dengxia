import { describe, expect, it } from 'vitest'
import { compareVersions, pickSetupAsset } from '../src/shared/app'

describe('更新检查', () => {
  it('版本号比较按数字段走，不按字符串', () => {
    expect(compareVersions('0.5.10', '0.5.6')).toBe(1)
    expect(compareVersions('0.5.6', '0.5.10')).toBe(-1)
    expect(compareVersions('0.5.6', '0.5.6')).toBe(0)
    expect(compareVersions('v1.0', '0.9.9')).toBe(1)
  })

  it('只挑 setup exe，跳过 blockmap', () => {
    const picked = pickSetupAsset([
      { name: 'DengXia-setup-0.5.6.exe.blockmap', size: 100, browser_download_url: 'https://github.com/x/blockmap' },
      { name: 'DengXia-setup-0.5.6.exe', size: 139_000_000, browser_download_url: 'https://github.com/x/setup.exe' },
    ])
    expect(picked.assetName).toBe('DengXia-setup-0.5.6.exe')
    expect(picked.assetUrl).toBe('https://github.com/x/setup.exe')
    expect(picked.assetSize).toBe(139_000_000)
    expect(pickSetupAsset([])).toEqual({ assetUrl: null, assetName: null, assetSize: null })
  })
})

import fs from 'node:fs'
import path from 'node:path'

export type AiConfigFile = { baseUrl: string; model: string; visionModel?: string; apiKey: string }

export type SavedSettings = {
  libreOfficePath: string | null
  /** 只在这台机器上保存；密钥不会进日志，也不会下发给渲染层。 */
  ai: AiConfigFile | null
}

const EMPTY: SavedSettings = {
  libreOfficePath: null,
  ai: null,
}

export class SettingsStore {
  constructor(private readonly file: string) {}

  load(): SavedSettings {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as {
        libreOfficePath?: unknown
        ai?: unknown
      }
      return {
        libreOfficePath: typeof parsed.libreOfficePath === 'string' ? parsed.libreOfficePath : null,
        ai: readAi(parsed.ai),
      }
    } catch {
      return { ...EMPTY }
    }
  }

  save(settings: SavedSettings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    fs.writeFileSync(
      temp,
      JSON.stringify({ libreOfficePath: settings.libreOfficePath, ai: settings.ai }, null, 2),
    )
    fs.renameSync(temp, this.file)
  }
}

function readAi(value: unknown): AiConfigFile | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.baseUrl !== 'string' || typeof raw.model !== 'string' || typeof raw.apiKey !== 'string') {
    return null
  }
  if (!raw.baseUrl || !raw.model || !raw.apiKey) return null
  const retired = new Set(['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])
  const model = raw.baseUrl.includes('api.deepseek.com') && retired.has(raw.model)
    ? 'deepseek-flash'
    : raw.model
  return {
    baseUrl: raw.baseUrl,
    model,
    visionModel: typeof raw.visionModel === 'string' && raw.visionModel.trim() ? raw.visionModel.trim() : undefined,
    apiKey: raw.apiKey,
  }
}

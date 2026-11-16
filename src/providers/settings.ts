import fs from 'node:fs'
import path from 'node:path'

export type AiConfigFile = { baseUrl: string; model: string; visionModel?: string; apiKey: string }

/** 复习目标：每天想评几张卡、看几道错题，以及要不要在本机弹提醒。 */
export type ReviewSettings = {
  cardsPerDay: number
  missesPerDay: number
  remind: boolean
}

export const DEFAULT_REVIEW: ReviewSettings = {
  cardsPerDay: 10,
  missesPerDay: 5,
  remind: true,
}

export type SavedSettings = {
  libreOfficePath: string | null
  /** 只在这台机器上保存；密钥不会进日志，也不会下发给渲染层。 */
  ai: AiConfigFile | null
  /** 文稿置顶：存文档 id，不动数据库结构。 */
  pinnedDocumentIds: string[]
  review: ReviewSettings
}

const EMPTY: SavedSettings = {
  libreOfficePath: null,
  ai: null,
  pinnedDocumentIds: [],
  review: { ...DEFAULT_REVIEW },
}

export class SettingsStore {
  constructor(private readonly file: string) {}

  load(): SavedSettings {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as {
        libreOfficePath?: unknown
        ai?: unknown
        pinnedDocumentIds?: unknown
        review?: unknown
      }
      return {
        libreOfficePath: typeof parsed.libreOfficePath === 'string' ? parsed.libreOfficePath : null,
        ai: readAi(parsed.ai),
        pinnedDocumentIds: readPinned(parsed.pinnedDocumentIds),
        review: readReview(parsed.review),
      }
    } catch {
      return { ...EMPTY, review: { ...DEFAULT_REVIEW } }
    }
  }

  save(settings: Omit<SavedSettings, 'review' | 'pinnedDocumentIds'> & {
    review?: ReviewSettings
    pinnedDocumentIds?: string[]
  }): void {
    const review = readReview(settings.review)
    const pinnedDocumentIds = readPinned(settings.pinnedDocumentIds ?? [])
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    fs.writeFileSync(
      temp,
      JSON.stringify(
        {
          libreOfficePath: settings.libreOfficePath,
          ai: settings.ai,
          pinnedDocumentIds,
          review,
        },
        null,
        2,
      ),
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

function readPinned(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && item.length <= 64) seen.add(item)
  }
  return [...seen].slice(0, 200)
}

function readReview(value: unknown): ReviewSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_REVIEW }
  const raw = value as Record<string, unknown>
  return {
    cardsPerDay: clampInt(raw.cardsPerDay, 1, 200, DEFAULT_REVIEW.cardsPerDay),
    missesPerDay: clampInt(raw.missesPerDay, 0, 100, DEFAULT_REVIEW.missesPerDay),
    remind: typeof raw.remind === 'boolean' ? raw.remind : DEFAULT_REVIEW.remind,
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

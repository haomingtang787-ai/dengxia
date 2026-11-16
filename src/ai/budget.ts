import { AiError } from './client'
import type { AppDatabase } from '../storage/database'
import type { SettingsStore } from '../providers/settings'
import type { BudgetSettings, BudgetStatus } from '../shared/data'

/** 自然月 token 护栏；0 = 关闭。每次模型调用前只读本机库，不联网。 */
export class BudgetService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: SettingsStore,
  ) {}

  settingsView(): BudgetSettings {
    return this.settings.load().budget
  }

  status(): BudgetStatus {
    const budget = this.settingsView()
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const used = this.tokensSince(monthStart.toISOString())
    const estimatedCalls = this.estimatedCallsSince(monthStart.toISOString())
    const limit = budget.monthlyTokens
    const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0
    return {
      limit,
      used,
      remaining: limit > 0 ? Math.max(0, limit - used) : 0,
      percent,
      monthStart: monthStart.toISOString(),
      monthEnd: monthEnd.toISOString(),
      hardStop: budget.hardStop,
      exceeded: limit > 0 && used >= limit,
      warned: limit > 0 && used / limit >= 0.8,
      estimatedCalls,
      estimated: estimatedCalls > 0,
    }
  }

  /** AiClient 在每次真正发请求前调用。 */
  beforeCall(): void {
    const budget = this.settingsView()
    if (budget.monthlyTokens <= 0) return
    const used = this.tokensSince(new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString())
    if (used < budget.monthlyTokens) return
    if (budget.hardStop) {
      throw new AiError('LIMIT_EXCEEDED', `本月 AI 用量已达 ${budget.monthlyTokens} tokens 上限，已在设置里开启硬拦截。下个月自动重置。`)
    }
  }

  private tokensSince(iso: string): number {
    const row = this.db.get<{ total: number }>(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total FROM ai_usage WHERE created_at >= ?`,
      iso,
    )
    return Number(row?.total ?? 0)
  }

  /** 供应商没返回 usage 时记录为 0/0；这些调用要明确标成“估算”，不能静默算成真实零消耗。 */
  private estimatedCallsSince(iso: string): number {
    const row = this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ai_usage
       WHERE created_at >= ? AND prompt_tokens = 0 AND cached_tokens = 0 AND completion_tokens = 0`,
      iso,
    )
    return Number(row?.total ?? 0)
  }
}

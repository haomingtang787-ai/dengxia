export type BackupSettings = {
  enabled: boolean
  directory: string
  keep: number
  lastAt: string | null
}

export type BudgetSettings = {
  /** 0 表示关闭预算。单位是 token，不是人民币。 */
  monthlyTokens: number
  /** true：到上限就拦住下一次 AI 调用；false：只显示提醒。 */
  hardStop: boolean
}

export type BudgetStatus = {
  limit: number
  used: number
  remaining: number
  percent: number
  monthStart: string
  monthEnd: string
  hardStop: boolean
  exceeded: boolean
  warned: boolean
  /** 没有返回 usage 的调用数；这些调用按 0 记，状态里明确标“估算”。 */
  estimatedCalls: number
  estimated: boolean
}

export type AppSettingsView = {
  backup: BackupSettings
  budget: BudgetSettings
  budgetStatus: BudgetStatus
}

export type SaveAppSettingsBody = {
  backup?: Partial<BackupSettings>
  budget?: Partial<BudgetSettings>
}

export type RestorePreview = {
  token: string
  sourcePath: string
  version: string
  createdAt: string
  schemaVersion: number
  /** sha256：新备份已校验；legacy：0.6.0 及更早备份没有哈希，仍允许恢复但明确提示。 */
  verification: 'sha256' | 'legacy'
  databaseSha256: string | null
  counts: {
    documents: number
    pages: number
    cards: number
    misses: number
    highlights: number
    manualCards: number
  }
}

export type RestoreApplied = {
  restored: boolean
  sourcePath: string
  previousPath: string
  counts: RestorePreview['counts']
}

export type AutoBackupResult = {
  skipped: boolean
  path: string | null
  pruned: number
  reason?: string
}

export type PickBackupDirResult = { path: string | null }

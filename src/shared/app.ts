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
}

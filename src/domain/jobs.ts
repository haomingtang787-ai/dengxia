import type { JobState } from '../shared/contract'

const TERMINAL = new Set<JobState>(['succeeded', 'partial', 'failed', 'cancelled', 'interrupted'])

export function isTerminalJob(state: JobState): boolean {
  return TERMINAL.has(state)
}

export function canRetryJob(state: JobState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'partial' || state === 'interrupted' || state === 'cancelled'
}

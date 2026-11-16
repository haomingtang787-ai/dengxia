import { parseDocument } from '../documents/parseDocument'
import type { ParseDeps, ParseResult, ParseTask, ProgressReport } from '../documents/parseTypes'

export type WorkerHandle = {
  done: Promise<ParseResult>
  exited: Promise<void>
  kill: () => void
}

export interface WorkerHost {
  start(task: ParseTask, onProgress: (progress: ProgressReport) => void): WorkerHandle
}

export class InProcessWorker implements WorkerHost {
  constructor(private readonly deps: ParseDeps = {}) {}

  start(task: ParseTask, onProgress: (progress: ProgressReport) => void): WorkerHandle {
    const controller = new AbortController()
    let resolveExit: () => void = () => undefined
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const done = parseDocument(task, {
      ...this.deps,
      signal: controller.signal,
      onProgress,
    }).finally(() => resolveExit())
    return {
      done,
      exited,
      kill: () => controller.abort(),
    }
  }
}

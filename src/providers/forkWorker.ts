import { fork, type ChildProcess } from 'node:child_process'
import type { ParseResult, ParseTask, ProgressReport } from '../documents/parseTypes'
import { buildWorkerEnv } from './workerEnv'
import type { WorkerHandle, WorkerHost } from './workerHost'

type WorkerMessage =
  | { type: 'progress'; stage: string; completed: number; total: number | null }
  | { type: 'result'; result: ParseResult }
  | { type: 'error'; code: string; message: string }

export class ForkWorker implements WorkerHost {
  constructor(private readonly entry: string) {}

  start(task: ParseTask, onProgress: (progress: ProgressReport) => void): WorkerHandle {
    const child: ChildProcess = fork(this.entry, [], {
      execArgv: ['--max-old-space-size=512'],
      env: buildWorkerEnv(process.env, task.workDir),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let settled = false
    let resolveDone: (result: ParseResult) => void = () => undefined
    let rejectDone: (error: Error) => void = () => undefined
    let resolveExit: () => void = () => undefined
    const done = new Promise<ParseResult>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    child.on('message', (message: WorkerMessage) => {
      if (message?.type === 'progress') onProgress(message)
      if (message?.type === 'result') finish(() => resolveDone(message.result))
      if (message?.type === 'error') finish(() => rejectDone(new Error(message.message)))
    })
    child.once('exit', () => {
      resolveExit()
      finish(() => rejectDone(new Error('worker exited')))
    })
    child.once('error', (error) => {
      resolveExit()
      finish(() => rejectDone(error))
    })
    child.send({ type: 'start', task })
    return {
      done,
      exited,
      kill: () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
        child.once('exit', () => clearTimeout(timer))
      },
    }
  }
}

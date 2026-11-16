import { parseDocument } from '../src/documents/parseDocument'
import type { ParseTask } from '../src/documents/parseTypes'
import { killActiveOffice } from '../src/providers/libreoffice'

type StartMessage = { type: 'start'; task: ParseTask }

let stopping = false

function stop(): void {
  if (stopping) return
  stopping = true
  killActiveOffice()
  process.exit(0)
}

process.on('SIGTERM', stop)
process.on('disconnect', stop)

process.on('message', (message: StartMessage) => {
  if (!message || message.type !== 'start') return
  void parseDocument(message.task, {
    onProgress: (progress) => {
      process.send?.({ type: 'progress', ...progress })
    },
  })
    .then((result) => {
      process.send?.({ type: 'result', result })
      process.exit(0)
    })
    .catch(() => {
      process.send?.({ type: 'error', code: 'PARSE_FAILED', message: '工作进程失败。' })
      process.exit(1)
    })
})

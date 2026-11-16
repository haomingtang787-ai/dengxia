import type { ErrorCode } from '../shared/contract'
import { RETRYABLE } from '../shared/contract'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.retryable = RETRYABLE[code]
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}

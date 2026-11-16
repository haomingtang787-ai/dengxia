import type { DeskApi } from '../preload'

declare global {
  interface Window {
    desk?: DeskApi
  }
}

export {}

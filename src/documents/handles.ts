export type HeldFile = {
  handle: string
  windowId: string
  filePath: string
  name: string
  sizeBytes: number
  state: 'open' | 'used'
}

export class HandleTable {
  private readonly records = new Map<string, HeldFile>()

  put(record: Omit<HeldFile, 'state'>): void {
    this.records.set(record.handle, { ...record, state: 'open' })
  }

  dropWindow(windowId: string): void {
    for (const [id, record] of this.records) {
      if (record.windowId === windowId) this.records.delete(id)
    }
  }

  consume(windowId: string, handle: string): HeldFile | 'missing' | 'used' | 'wrong-window' {
    const record = this.records.get(handle)
    if (!record) return 'missing'
    if (record.windowId !== windowId) return 'wrong-window'
    if (record.state !== 'open') return 'used'
    record.state = 'used'
    return record
  }
}

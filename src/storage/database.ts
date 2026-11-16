import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

export class AppDatabase {
  private constructor(private readonly db: DatabaseSync) {}

  static open(file: string): AppDatabase {
    const db = new DatabaseSync(file, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    })
    db.exec('PRAGMA foreign_keys = ON')
    if (file !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL')
    }
    db.exec('PRAGMA busy_timeout = 5000')
    return new AppDatabase(db)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    const stmt = this.db.prepare(sql)
    try {
      return stmt.get(...params) as T | undefined
    } finally {
      ;(stmt as { close?: () => void }).close?.()
    }
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    const stmt = this.db.prepare(sql)
    try {
      return stmt.all(...params) as T[]
    } finally {
      ;(stmt as { close?: () => void }).close?.()
    }
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    const stmt = this.db.prepare(sql)
    try {
      stmt.run(...params)
    } finally {
      ;(stmt as { close?: () => void }).close?.()
    }
  }

  pragmaForeignKeys(): number {
    const row = this.get<{ foreign_keys: number }>('PRAGMA foreign_keys')
    return Number(row?.foreign_keys ?? 0)
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* the original error is the one to surface */
      }
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}

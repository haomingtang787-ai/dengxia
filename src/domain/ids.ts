const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function canonicalUuid(value: string): string {
  return value.toLowerCase()
}

const ANCHOR_RE = /^[A-Za-z0-9._:-]{1,80}$/

export function isParagraphAnchor(value: unknown): value is string {
  return typeof value === 'string' && ANCHOR_RE.test(value)
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function isUtcIso(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  return !Number.isNaN(Date.parse(value))
}

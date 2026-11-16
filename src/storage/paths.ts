import fs from 'node:fs'
import path from 'node:path'

export function resolveInside(root: string, relpath: string): string | null {
  if (typeof relpath !== 'string' || relpath.length === 0 || relpath.length > 1024) return null
  if (relpath.includes('\0') || relpath.includes('\\')) return null
  if (relpath.startsWith('/') || /^[a-zA-Z]:/.test(relpath)) return null
  const normalized = path.posix.normalize(relpath)
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null
  const rootResolved = path.resolve(root)
  const full = path.resolve(rootResolved, ...normalized.split('/'))
  if (!isInsideRoot(rootResolved, full)) return null
  return full
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root)
  const full = path.resolve(candidate)
  const rel = path.relative(rootResolved, full)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function realpathInside(root: string, absPath: string): string | null {
  if (!isInsideRoot(root, absPath)) return null
  let real: string
  try {
    real = fs.realpathSync(absPath)
  } catch {
    return null
  }
  if (!isInsideRoot(root, real)) return null
  return real
}

export function toRelPath(root: string, absPath: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(absPath))
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('path escapes the application data directory')
  }
  return rel.split(path.sep).join('/')
}

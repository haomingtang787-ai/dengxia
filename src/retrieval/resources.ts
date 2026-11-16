import fs from 'node:fs'
import { isUuid } from '../domain/ids'
import { sha256Bytes } from '../documents/hash'
import type { Store } from '../storage/store'
import { realpathInside, resolveInside } from '../storage/paths'

const PNG = [0x89, 0x50, 0x4e, 0x47]
const JPEG = [0xff, 0xd8, 0xff]

export function resourceIdFromUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'app-resource:') return null
  if (url.username || url.password || url.port || url.search || url.hash) return null
  const pathName = url.pathname.replace(/^\/+|\/+$/g, '')
  if (url.hostname && pathName) return null
  const id = url.hostname || pathName
  if (!isUuid(id)) return null
  return id.toLowerCase()
}

export function readManagedPreview(store: Store, root: string, id: string): { status: number; body?: Buffer; mime?: string } {
  if (!isUuid(id)) return { status: 400 }
  const artifact = store.getArtifact(id)
  if (!artifact || artifact.kind !== 'page-image') return { status: 404 }
  if (artifact.mime !== 'image/png' && artifact.mime !== 'image/jpeg') return { status: 415 }
  if (!artifact.relpath.startsWith('artifacts/')) return { status: 403 }
  const abs = resolveInside(root, artifact.relpath)
  if (!abs) return { status: 403 }
  const real = realpathInside(root, abs)
  if (!real) return { status: 403 }
  const body = fs.readFileSync(real)
  const signature = artifact.mime === 'image/png' ? PNG : JPEG
  if (!signature.every((byte, index) => body[index] === byte)) return { status: 415 }
  if (sha256Bytes(body) !== artifact.sha256) return { status: 409 }
  return { status: 200, body, mime: artifact.mime }
}

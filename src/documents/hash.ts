import { createHash } from 'node:crypto'
import fs from 'node:fs'

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function hashFile(file: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash('sha256')
  let size = 0
  const stream = fs.createReadStream(file)
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buf.length
    hash.update(buf)
  }
  return { sha256: hash.digest('hex'), sizeBytes: size }
}

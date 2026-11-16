import { readManagedPreview, resourceIdFromUrl } from '../retrieval/resources'
import type { Store } from '../storage/store'

export function handleAppResource(store: Store, root: string, request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('方法不被允许', { status: 405 })
  }
  const id = resourceIdFromUrl(request.url)
  if (!id) return new Response('资源地址无效', { status: 400 })
  const found = readManagedPreview(store, root, id)
  if (!found.body || !found.mime) return new Response(null, { status: found.status })
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(found.body), {
    status: 200,
    headers: {
      'Content-Type': found.mime,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

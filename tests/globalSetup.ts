import { build } from 'esbuild'
import { resolve } from 'node:path'

export default async function globalSetup(): Promise<void> {
  await build({
    entryPoints: [resolve('workers/documentWorker.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: resolve('out/worker/documentWorker.mjs'),
    packages: 'external',
    sourcemap: true,
    logLevel: 'warning',
  })
}

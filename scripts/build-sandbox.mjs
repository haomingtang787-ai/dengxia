// Compiles the Windows sandbox host with the .NET Framework compiler that ships
// with Windows. On other platforms it is a no-op: the helper only exists to
// create an AppContainer, and there is no AppContainer to create.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'workers', 'office-sandbox', 'DeskOfficeSandbox.cs')
const target = path.join(root, 'resources', 'office-sandbox', 'DeskOfficeSandbox.exe')

if (process.platform !== 'win32') {
  console.log('[build:sandbox] 非 Windows，跳过 AppContainer 宿主。')
  process.exit(0)
}

const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!fs.existsSync(csc)) {
  console.error(`[build:sandbox] 找不到 csc.exe：${csc}`)
  process.exit(1)
}

fs.mkdirSync(path.dirname(target), { recursive: true })
execFileSync(
  csc,
  ['/nologo', '/target:exe', '/platform:x64', '/optimize+', `/out:${target}`, source],
  { stdio: 'inherit' },
)
const stat = fs.statSync(target)
if (stat.size === 0) {
  console.error('[build:sandbox] 编译产物为空。')
  process.exit(1)
}
console.log(`[build:sandbox] ${path.relative(root, target)} ${stat.size} 字节`)

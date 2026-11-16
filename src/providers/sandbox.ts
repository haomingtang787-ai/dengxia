import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The Windows execution layer. A process is only ever started inside an
 * AppContainer with no capabilities (so no internetClient and no
 * privateNetworkClientServer), inside a job object with bounded memory and a
 * bounded process count, and with only the directories we grant explicitly.
 *
 * Nothing in this module trusts configuration, environment variables or IPC.
 * Evidence exists only after the helper actually ran the probe and reported
 * what happened.
 */

export type SandboxDenials = {
  fileReadDenied: boolean
  networkBlocked: boolean
  memoryLimitHit: boolean
  treeKilled: boolean
  grantedWriteAllowed: boolean
}

export type SandboxEvidence =
  | { ok: true; containerSid: string; denials: SandboxDenials; testedAt: string }
  | { ok: false; reason: string }

export type ConversionEvidence =
  | { ok: true; version: string; pdfBytes: number; testedAt: string }
  | { ok: false; reason: string }

export type SandboxedRun = { ok: true; exitCode: number } | { ok: false; reason: string }

const HELPER_DIR = 'office-sandbox'
const HELPER_FILE = 'DeskOfficeSandbox.exe'

export function sandboxHelperPath(roots?: string[]): string | null {
  if (process.platform !== 'win32') return null
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath
  const candidates = roots ?? [resources ?? '', path.join(process.cwd(), 'resources')]
  for (const root of candidates) {
    if (!root) continue
    const candidate = path.join(root, HELPER_DIR, HELPER_FILE)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function line(text: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escaped}=(.+)$`, 'm')
  const match = pattern.exec(text)
  return match ? match[1].trim() : null
}

/**
 * Turns the helper's real stdout into evidence. Every denial has to be
 * observed; a missing or unreadable line counts as a failure, never as a pass.
 */
export function parseSandboxReport(text: string): SandboxEvidence {
  if (!text.trim()) return { ok: false, reason: '沙箱宿主没有输出任何结果。' }

  const launch = line(text, 'launch')
  if (launch !== 'ok') {
    const detail = line(text, 'launchDetail')
    return { ok: false, reason: `沙箱宿主没有启动受限进程${detail ? `（${detail}）` : ''}。` }
  }

  const containerSid = line(text, 'container')
  if (!containerSid || !containerSid.startsWith('S-1-15-2-')) {
    return { ok: false, reason: '没有创建 AppContainer，进程不在容器里。' }
  }

  if (line(text, 'job') !== 'created') {
    return { ok: false, reason: '没有建立资源上限：Job Object 创建失败。' }
  }

  const read = line(text, 'probe.read')
  if (read !== 'denied') {
    return { ok: false, reason: `越权读文件没有被拒绝（${read ?? '未测'}）。` }
  }

  const tcp = line(text, 'probe.tcp')
  if (!tcp || !tcp.startsWith('blocked')) {
    return { ok: false, reason: `联网没有被阻断（${tcp ?? '未测'}）。` }
  }

  const write = line(text, 'probe.write')
  if (write !== 'allowed') {
    return { ok: false, reason: `授予目录不可写入（${write ?? '未测'}），探针失败可能是权限配置错误而非沙箱生效。` }
  }

  const alloc = line(text, 'probe.alloc')
  if (alloc !== 'limited') {
    return { ok: false, reason: `内存上限没有生效（${alloc ?? '未测'}）。` }
  }

  const tree = line(text, 'treeKilled')
  if (tree !== 'yes') {
    return { ok: false, reason: '进程树在终止后仍然存活。' }
  }
  // A grandchild that already exited on its own makes "it stopped" meaningless,
  // so the report has to show it was alive and writing before the kill.
  const aliveBefore = Number(line(text, 'treeHeartbeatBefore') ?? '0')
  const aliveRunning = Number(line(text, 'treeHeartbeatRunning') ?? '0')
  if (!(aliveBefore > 0 && aliveRunning > aliveBefore)) {
    return { ok: false, reason: '进程树证据不成立：孙进程没有在终止前持续存活。' }
  }

  if (line(text, 'probe.spawn') !== 'started' || line(text, 'probe.heartbeat') !== 'allowed') {
    return { ok: false, reason: '探针没有完整执行，进程树证据不成立。' }
  }

  return {
    ok: true,
    containerSid,
    denials: {
      fileReadDenied: true,
      networkBlocked: true,
      memoryLimitHit: true,
      treeKilled: true,
      grantedWriteAllowed: true,
    },
    testedAt: new Date().toISOString(),
  }
}

/**
 * The helper only ever sees this allowlist, and the container process inherits
 * it. Anything the app holds - API keys, proxies, NODE_OPTIONS - stays outside.
 * TEMP and the home directory point at the granted work directory so the child
 * has somewhere it is actually allowed to write.
 */
export function sandboxEnv(workDir: string): NodeJS.ProcessEnv {
  const allow = [
    'SystemRoot',
    'SystemDrive',
    'windir',
    'ComSpec',
    'PATHEXT',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'CommonProgramFiles',
    'LOCALAPPDATA',
    'APPDATA',
    'LANG',
    'LC_ALL',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of allow) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  env.PATH = [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), process.env.SystemRoot ?? 'C:\\Windows'].join(';')
  env.TEMP = workDir
  env.TMP = workDir
  env.HOME = workDir
  env.USERPROFILE = workDir
  return env
}

function runHelper(
  helperPath: string,
  args: string[],
  timeoutMs: number,
  workDir: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(helperPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sandboxEnv(workDir),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const stop = () => {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
    }
    const onAbort = () => stop()
    const timer = setTimeout(stop, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => finish(() => reject(error)))
    child.once('exit', (code) => {
      finish(() => {
        if (code !== 0 && !stdout.includes('launch=')) {
          reject(new Error(`沙箱宿主退出码 ${code ?? '未知'}。${stderr.trim().slice(0, 200)}`))
          return
        }
        resolve(stdout)
      })
    })
  })
}

export async function runSandboxSelfTest(
  helperPath: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<SandboxEvidence> {
  if (process.platform !== 'win32') {
    return { ok: false, reason: '当前不是 Windows，没有 AppContainer 可以验证。' }
  }
  if (!fs.existsSync(helperPath)) {
    return { ok: false, reason: '沙箱宿主没有随安装包提供。' }
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-sandbox-'))
  try {
    const output = await runHelper(helperPath, ['selftest', '--work', work], options?.timeoutMs ?? 60000, work, options?.signal)
    return parseSandboxReport(output)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '沙箱宿主没有正常结束。' }
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true })
    } catch {
      // A leftover temp directory is not evidence and not a security failure.
    }
  }
}

/**
 * Runs an arbitrary executable inside the container. Used for the LibreOffice
 * probe and for real conversions; the caller's own process never sees the
 * child's file system beyond what it granted.
 */
export async function runSandboxed(
  helperPath: string,
  options: {
    executable: string
    args: string[]
    workDir: string
    timeoutMs: number
    signal?: AbortSignal
  },
): Promise<SandboxedRun> {
  if (process.platform !== 'win32') return { ok: false, reason: '当前不是 Windows，没有 AppContainer 可用。' }
  if (!fs.existsSync(helperPath)) return { ok: false, reason: '沙箱宿主没有随安装包提供。' }
  fs.mkdirSync(options.workDir, { recursive: true })
  const argsFile = path.join(options.workDir, 'office-args.txt')
  fs.writeFileSync(argsFile, options.args.join('\n'), 'utf8')
  try {
    const output = await runHelper(
      helperPath,
      [
        'run',
        '--exe',
        options.executable,
        '--work',
        options.workDir,
        '--args-file',
        argsFile,
        '--timeout-ms',
        String(options.timeoutMs),
      ],
      options.timeoutMs + 5000,
      options.workDir,
      options.signal,
    )
    const launch = line(output, 'launch')
    if (launch !== 'ok') {
      return { ok: false, reason: `沙箱没有启动 ${path.basename(options.executable)}（${line(output, 'launchDetail') ?? '未知'}）。` }
    }
    if (line(output, 'timedOut') === 'yes') {
      return { ok: false, reason: '任务在沙箱内超时，进程树已被终止。' }
    }
    const code = line(output, 'exit')
    return { ok: true, exitCode: code === null ? -1 : Number(code) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : '沙箱宿主没有正常结束。' }
  }
}

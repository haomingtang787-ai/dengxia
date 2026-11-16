import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { LIMITS } from '../shared/constants'
import type { ConvertResult } from '../documents/parseTypes'
import { officeIsolationStatus, recordConversionEvidence, windowsOfficeIsolation } from './isolation'
import { runSandboxed, sandboxHelperPath } from './sandbox'

const active = new Set<ChildProcess>()

export function isolatedProfileXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
  <prop oor:name="DisableMacrosExecution" oor:op="fuse" oor:finalized="true"><value>true</value></prop>
  <prop oor:name="DisableActiveContent" oor:op="fuse" oor:finalized="true"><value>true</value></prop>
  <prop oor:name="MacroSecurityLevel" oor:op="fuse" oor:finalized="true"><value>3</value></prop>
 </item>
 <item oor:path="/org.openoffice.Office.Writer/Content/Update">
  <prop oor:name="Link" oor:op="fuse" oor:finalized="true"><value>2</value></prop>
 </item>
 <item oor:path="/org.openoffice.Office.Calc/Content/Update">
  <prop oor:name="Link" oor:op="fuse" oor:finalized="true"><value>1</value></prop>
 </item>
</oor:items>
`
}

export function writeIsolatedProfile(profileDir: string): void {
  const userDir = path.join(profileDir, 'user')
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(userDir, 'registrymodifications.xcu'), isolatedProfileXml(), { mode: 0o600 })
}

export function libreOfficeArgs(profileDir: string, outDir: string, inputPath: string): string[] {
  return [
    '--headless',
    '--norestore',
    '--nolockcheck',
    '--nologo',
    '--nofirststartwizard',
    '--nodefault',
    '--nocrashreport',
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--convert-to',
    'pdf',
    '--outdir',
    outDir,
    inputPath,
  ]
}

export const OFFICE_SPAWN = { shell: false as const, windowsHide: true as const }

/**
 * `soffice.exe` starts the GUI launcher and returns before the version line is
 * written, so `--version` captures nothing. The console shim beside it,
 * `soffice.com`, prints the version synchronously. Version probing must use
 * the shim even when the user selected the .exe; actual conversions keep the
 * selected executable.
 */
export function consoleVersionExecutable(executable: string): string {
  if (process.platform !== 'win32' || !/\.exe$/i.test(executable)) return executable
  const com = executable.replace(/\.exe$/i, '.com')
  try {
    if (fs.existsSync(com)) return com
  } catch {
    /* fall back to the selected executable */
  }
  return executable
}


export function killActiveOffice(): void {
  for (const child of active) killProcess(child)
  active.clear()
}

function killProcess(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function officeEnv(): NodeJS.ProcessEnv {
  const allow = ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'TMPDIR', 'TEMP', 'TMP', 'LD_LIBRARY_PATH']
  const env: NodeJS.ProcessEnv = {}
  for (const key of allow) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

/**
 * Only used for `--version`, which reads no document at all. Real conversions
 * never take this path: they go through the AppContainer below.
 */
function runVersionProbe(
  executable: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: officeEnv(),
    })
    active.add(child)
    let stdout = ''
    let stderr = ''
    const take = (into: string, chunk: Buffer) => (into.length < 4000 ? into + chunk.toString('utf8') : into)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = take(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = take(stderr, chunk)
    })
    const stop = () => killProcess(child)
    const timer = setTimeout(stop, timeoutMs)
    const onAbort = () => stop()
    signal.addEventListener('abort', onAbort, { once: true })
    const finish = (fn: () => void) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      active.delete(child)
      fn()
    }
    child.once('error', (error) => finish(() => reject(error)))
    child.once('exit', (code) => finish(() => resolve({ code, stdout, stderr })))
  })
}

export async function libreOfficeVersion(
  executable: string,
  timeoutMs = LIMITS.versionTimeoutMs,
): Promise<{ ok: true; version: string } | { ok: false; message: string }> {
  const status = officeIsolationStatus()
  if (!status.sandboxVerified) return { ok: false, message: status.reason }
  try {
    const result = await runVersionProbe(consoleVersionExecutable(executable), ['--version'], new AbortController().signal, timeoutMs)
    const line = result.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? ''
    if (result.code !== 0 || !/LibreOffice/i.test(line)) {
      return { ok: false, message: line || result.stderr || '无法读取 LibreOffice 版本。' }
    }
    return { ok: true, version: line.slice(0, 160) }
  } catch {
    return { ok: false, message: '无法启动所选的 LibreOffice 可执行文件。' }
  }
}

export function minimalProbeDocx(): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>probe</w:t></w:r></w:p></w:body>
</w:document>`
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  return zipSync({
    '[Content_Types].xml': strToU8(types),
    '_rels/.rels': strToU8(rels),
    'word/document.xml': strToU8(document),
  })
}

/**
 * Converts one document inside the verified container.
 *
 * The container never sees the library path: the input is copied into a run
 * directory that is the only writable place, the profile lives beside it, and
 * only the resulting PDF is copied back out.
 */
async function convertInSandbox(
  helperPath: string,
  executable: string,
  inputPath: string,
  outDir: string,
  signal: AbortSignal,
): Promise<ConvertResult> {
  const runRoot = fs.mkdtempSync(path.join(path.dirname(outDir), 'office-run-'))
  const profile = path.join(runRoot, 'profile')
  const output = path.join(runRoot, 'out')
  const inputDir = path.join(runRoot, 'input')
  fs.mkdirSync(output, { recursive: true })
  fs.mkdirSync(inputDir, { recursive: true })
  writeIsolatedProfile(profile)
  const inputCopy = path.join(inputDir, path.basename(inputPath))
  fs.copyFileSync(inputPath, inputCopy)
  try {
    const result = await runSandboxed(helperPath, {
      executable,
      args: libreOfficeArgs(profile, output, inputCopy),
      workDir: runRoot,
      timeoutMs: LIMITS.officeTimeoutMs,
      signal,
    })
    if (!result.ok) return { ok: false, message: result.reason }
    if (result.exitCode !== 0) return { ok: false, message: `LibreOffice 退出码 ${result.exitCode}。` }
    const pdfName = fs.readdirSync(output).find((name) => name.toLowerCase().endsWith('.pdf'))
    if (!pdfName) return { ok: false, message: 'LibreOffice 没有写出 PDF。' }
    const produced = path.join(output, pdfName)
    const header = fs.readFileSync(produced).subarray(0, 5).toString('utf8')
    if (!header.startsWith('%PDF')) return { ok: false, message: 'LibreOffice 的输出不是 PDF。' }
    fs.mkdirSync(outDir, { recursive: true })
    const finalPath = path.join(outDir, pdfName)
    fs.copyFileSync(produced, finalPath)
    return { ok: true, pdfPath: finalPath }
  } finally {
    try {
      fs.rmSync(runRoot, { recursive: true, force: true })
    } catch {
      // Leftover run directories live under the job work directory and are
      // removed with it; cleanup failure is not a security failure.
    }
  }
}

export async function convertWithLibreOffice(
  executable: string,
  inputPath: string,
  outDir: string,
  signal: AbortSignal,
  helperPath: string | null = sandboxHelperPath(),
): Promise<ConvertResult> {
  const isolation = windowsOfficeIsolation()
  if (!isolation.verified) return { ok: false, message: isolation.reason }
  if (!helperPath) return { ok: false, message: 'Office 沙箱宿主没有随安装包提供，转换不运行。' }
  return convertInSandbox(helperPath, executable, inputPath, outDir, signal)
}

/**
 * The second piece of evidence: one real DOCX through LibreOffice inside the
 * same container. This is the only way user documents ever become convertible,
 * and it needs the first piece (a passed sandbox self-test) to be allowed at
 * all.
 */
export async function probeLibreOffice(
  executable: string,
  helperPath: string | null = sandboxHelperPath(),
): Promise<{ ok: boolean; version: string | null; message: string }> {
  const status = officeIsolationStatus()
  if (!status.sandboxVerified) return { ok: false, version: null, message: status.reason }
  const version = await libreOfficeVersion(executable)
  if (!version.ok) return { ok: false, version: null, message: version.message }
  if (!helperPath) {
    recordConversionEvidence({ ok: false, reason: '沙箱宿主缺失。' })
    return { ok: false, version: version.version, message: '沙箱宿主没有随安装包提供，转换证据无法取得。' }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-probe-'))
  try {
    const input = path.join(dir, 'probe.docx')
    const outDir = path.join(dir, 'out')
    fs.mkdirSync(outDir)
    fs.writeFileSync(input, minimalProbeDocx())
    const converted = await convertInSandbox(helperPath, executable, input, outDir, new AbortController().signal)
    if (!converted.ok) {
      recordConversionEvidence({ ok: false, reason: converted.message })
      return { ok: false, version: version.version, message: converted.message }
    }
    recordConversionEvidence({
      ok: true,
      version: version.version,
      pdfBytes: fs.statSync(converted.pdfPath).size,
      testedAt: new Date().toISOString(),
    })
    return { ok: true, version: version.version, message: '已用一份最小 DOCX 在沙箱内转成 PDF。' }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function defaultLibreOfficeCandidates(): string[] {
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(
      (value): value is string => Boolean(value),
    )
    return roots.map((root) => path.join(root, 'LibreOffice', 'program', 'soffice.exe'))
  }
  return ['/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/snap/bin/libreoffice']
}

export function findExistingCandidate(): string | null {
  for (const candidate of defaultLibreOfficeCandidates()) {
    try {
      const stat = fs.lstatSync(candidate)
      if (stat.isFile() || stat.isSymbolicLink()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

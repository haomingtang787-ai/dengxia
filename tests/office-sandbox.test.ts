import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearOfficeEvidence,
  officeIsolationStatus,
  recordConversionEvidence,
  recordSandboxEvidence,
  windowsOfficeIsolation,
} from '../src/providers/isolation'
import { parseSandboxReport, runSandboxed, runSandboxSelfTest, sandboxHelperPath } from '../src/providers/sandbox'
import { createHarness } from './helpers/app'

const PASSING_REPORT = [
  'containerMode=reused',
  'container=S-1-15-2-2263601745-3528854297-2714044486-2573611039-3076946093-159133856-1535869698',
  'job=created',
  'launch=ok',
  'probeReport=read',
  'treeHeartbeatBefore=5',
  'treeHeartbeatRunning=10',
  'treeHeartbeatAfterKill=10',
  'treeHeartbeatSettled=10',
  'treeKilled=yes',
  'probe.probe=ran',
  'probe.read=denied',
  'probe.tcp=blocked-TimedOut',
  'probe.write=allowed',
  'probe.alloc=limited',
  'probe.heartbeat=allowed',
  'probe.spawn=started',
].join('\r\n')

function evidenceFrom(report: string) {
  return parseSandboxReport(report)
}

describe('sandbox self-test report', () => {
  it('accepts a report where the escape read, the network and the process tree were all held', () => {
    const evidence = evidenceFrom(PASSING_REPORT)
    expect(evidence.ok).toBe(true)
    if (!evidence.ok) return
    expect(evidence.denials.fileReadDenied).toBe(true)
    expect(evidence.denials.networkBlocked).toBe(true)
    expect(evidence.denials.memoryLimitHit).toBe(true)
    expect(evidence.denials.treeKilled).toBe(true)
    expect(evidence.denials.grantedWriteAllowed).toBe(true)
    expect(evidence.containerSid).toMatch(/^S-1-15-2-/)
  })

  it('rejects a report where the read outside the grant succeeded', () => {
    const evidence = evidenceFrom(PASSING_REPORT.replace('probe.read=denied', 'probe.read=readable'))
    expect(evidence.ok).toBe(false)
    if (evidence.ok) return
    expect(evidence.reason).toContain('越权')
  })

  it('rejects a report where the network connection was made', () => {
    const evidence = evidenceFrom(PASSING_REPORT.replace('probe.tcp=blocked-TimedOut', 'probe.tcp=connected'))
    expect(evidence.ok).toBe(false)
    if (evidence.ok) return
    expect(evidence.reason).toContain('联网')
  })

  it('rejects a report where the process tree survived the job kill', () => {
    const evidence = evidenceFrom(PASSING_REPORT.replace('treeKilled=yes', 'treeKilled=no'))
    expect(evidence.ok).toBe(false)
    if (evidence.ok) return
    expect(evidence.reason).toContain('进程树')
  })

  it('rejects a vacuous tree proof where the grandchild had already exited', () => {
    const report = PASSING_REPORT.replace('treeHeartbeatBefore=5', 'treeHeartbeatBefore=0').replace('treeHeartbeatRunning=10', 'treeHeartbeatRunning=0')
    const evidence = evidenceFrom(report)
    expect(evidence.ok).toBe(false)
    if (evidence.ok) return
    expect(evidence.reason).toContain('持续存活')
  })

  it('rejects a report where the job object was not created', () => {
    const evidence = evidenceFrom(PASSING_REPORT.replace('job=created', 'job=failed'))
    expect(evidence.ok).toBe(false)
    if (evidence.ok) return
    expect(evidence.reason).toContain('资源上限')
  })

  it('rejects a report where the process never launched', () => {
    const evidence = evidenceFrom(PASSING_REPORT.replace('launch=ok', 'launch=create-failed'))
    expect(evidence.ok).toBe(false)
    if (evidence.ok) return
    expect(evidence.reason).toContain('启动')
  })

  it('rejects a report where the granted directory was not writable', () => {
    const evidence = evidenceFrom(PASSING_REPORT.replace('probe.write=allowed', 'probe.write=denied'))
    expect(evidence.ok).toBe(false)
    if (evidence.ok) return
    expect(evidence.reason).toContain('写入')
  })

  it('rejects an empty report', () => {
    const evidence = evidenceFrom('')
    expect(evidence.ok).toBe(false)
  })
})

describe('office isolation gate', () => {
  afterEach(() => {
    clearOfficeEvidence()
  })

  it('does not verify anything without evidence', () => {
    const isolation = windowsOfficeIsolation()
    expect(isolation.verified).toBe(false)
    if (isolation.verified) return
    expect(isolation.reason).toContain('没有启动')
    const status = officeIsolationStatus()
    expect(status.sandboxVerified).toBe(false)
    expect(status.conversionVerified).toBe(false)
  })

  it('keeps conversion closed when only the sandbox self-test passed', () => {
    recordSandboxEvidence(evidenceFrom(PASSING_REPORT))
    const isolation = windowsOfficeIsolation()
    expect(isolation.verified).toBe(false)
    if (isolation.verified) return
    expect(isolation.reason).toContain('DOCX')
    const status = officeIsolationStatus()
    expect(status.sandboxVerified).toBe(true)
    expect(status.conversionVerified).toBe(false)
  })

  it('keeps conversion closed when only a conversion was recorded', () => {
    recordConversionEvidence({ ok: true, version: 'LibreOffice 7', pdfBytes: 1200, testedAt: '2026-11-15T00:00:00.000Z' })
    const isolation = windowsOfficeIsolation()
    expect(isolation.verified).toBe(false)
    const status = officeIsolationStatus()
    expect(status.sandboxVerified).toBe(false)
  })

  it('opens the gate only when the self-test and a conversion both passed', () => {
    recordSandboxEvidence(evidenceFrom(PASSING_REPORT))
    recordConversionEvidence({ ok: true, version: 'LibreOffice 7', pdfBytes: 1200, testedAt: '2026-11-15T00:00:00.000Z' })
    const isolation = windowsOfficeIsolation()
    expect(isolation.verified).toBe(true)
    if (!isolation.verified) return
    expect(isolation.restrictedPermissions).toBe(true)
    expect(isolation.networkBlocked).toBe(true)
    expect(isolation.boundedResources).toBe(true)
    expect(isolation.windowsProcessTreeValidated).toBe(true)
    expect(isolation.evidence).toContain('S-1-15-2-')
  })

  it('drops back to closed when the evidence is cleared for a recheck', () => {
    recordSandboxEvidence(evidenceFrom(PASSING_REPORT))
    recordConversionEvidence({ ok: true, version: 'LibreOffice 7', pdfBytes: 1200, testedAt: '2026-11-15T00:00:00.000Z' })
    clearOfficeEvidence()
    expect(windowsOfficeIsolation().verified).toBe(false)
  })

  it('ignores a failed conversion record', () => {
    recordSandboxEvidence(evidenceFrom(PASSING_REPORT))
    recordConversionEvidence({ ok: false, reason: 'LibreOffice 没有写出 PDF。' })
    expect(windowsOfficeIsolation().verified).toBe(false)
  })

  it('surfaces the two proofs through the prerequisites contract', async () => {
    recordSandboxEvidence(evidenceFrom(PASSING_REPORT))
    recordConversionEvidence({ ok: true, version: 'LibreOffice 7', pdfBytes: 1200, testedAt: '2026-11-15T00:00:00.000Z' })
    const app = await createHarness()
    try {
      const status = await app.service.prerequisites()
      expect(status.ok).toBe(true)
      if (!status.ok) return
      expect(status.data.sandbox.windowsSandboxVerified).toBe(true)
      expect(status.data.sandbox.conversionVerified).toBe(true)
      expect(status.data.sandbox.boundedResourcesVerified).toBe(true)
      expect(status.data.sandbox.note).toContain('S-1-15-2-')
    } finally {
      await app.cleanup()
    }
  }, 20000)
})

const helper = sandboxHelperPath()
const canRunHelper = process.platform === 'win32' && helper !== null && fs.existsSync(helper)

describe('sandbox self-test on this machine', () => {
  it.runIf(canRunHelper)('runs the helper and holds both escapes', async () => {
    const evidence = await runSandboxSelfTest(canRunHelper ? (helper as string) : '', { timeoutMs: 60000 })
    expect(evidence.ok).toBe(true)
    if (!evidence.ok) return
    expect(evidence.denials.fileReadDenied).toBe(true)
    expect(evidence.denials.networkBlocked).toBe(true)
    expect(evidence.denials.treeKilled).toBe(true)
  }, 120000)

  it.runIf(canRunHelper)('runs a target inside the container without leaking the parent environment', async () => {
    const helperExe = helper as string
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-run-'))
    const previous = process.env.DESK_TEST_SECRET
    process.env.DESK_TEST_SECRET = 'leak-me'
    try {
      const copied = path.join(work, 'target.exe')
      fs.copyFileSync(helperExe, copied)
      const output = path.join(work, 'env.txt')
      const result = await runSandboxed(helperExe, {
        executable: copied,
        args: ['probe', '--out', output, '--dump-env'],
        workDir: work,
        timeoutMs: 40000,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.exitCode).toBe(0)
      const dumped = fs.readFileSync(output, 'utf8')
      expect(dumped).toContain('env.count=')
      expect(dumped).toContain('SystemRoot=')
      expect(dumped).not.toContain('DESK_TEST_SECRET')
    } finally {
      if (previous === undefined) delete process.env.DESK_TEST_SECRET
      else process.env.DESK_TEST_SECRET = previous
      fs.rmSync(work, { recursive: true, force: true })
    }
  }, 120000)
})

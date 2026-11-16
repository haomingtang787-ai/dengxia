import { MESSAGES } from '../shared/constants'
import type { ConversionEvidence, SandboxEvidence } from './sandbox'

/**
 * Office conversion may run only when this returns verified isolation.
 *
 * Two separate proofs are required, and neither can be produced by
 * configuration, IPC or the environment:
 *
 *  1. the AppContainer self-test denied an out-of-grant read and network
 *     egress, held the memory and process-tree limits, and let the probe write
 *     only where it was granted;
 *  2. one real DOCX went through LibreOffice inside that container and came
 *     back as a PDF.
 *
 * Proof 2 depends on proof 1 (the probe runs inside the sandbox), so the
 * evidence lives in memory for the life of the process and starts empty on
 * every launch.
 */
export type OfficeIsolation =
  | {
      verified: true
      restrictedPermissions: true
      networkBlocked: true
      boundedResources: true
      windowsProcessTreeValidated: true
      evidence: string
    }
  | {
      verified: false
      restrictedPermissions: false
      networkBlocked: false
      boundedResources: false
      windowsProcessTreeValidated: false
      reason: string
    }

export type IsolationStatus = {
  sandboxTested: boolean
  sandboxVerified: boolean
  conversionVerified: boolean
  containerSid: string | null
  evidence: string | null
  detail: string
  reason: string
}

let sandbox: SandboxEvidence | null = null
let conversion: ConversionEvidence | null = null

export function recordSandboxEvidence(evidence: SandboxEvidence | null): void {
  sandbox = evidence
  if (!evidence || !evidence.ok) conversion = null
}

export function recordConversionEvidence(evidence: ConversionEvidence | null): void {
  conversion = evidence
}

/** Used by the "重新检查" path: every proof has to be earned again. */
export function clearOfficeEvidence(): void {
  sandbox = null
  conversion = null
}

/** Proof 1 alone. Enough to run a version check or our own probe document. */
export function officeSandboxReady(): boolean {
  return sandbox?.ok === true
}

export function officeIsolationStatus(): IsolationStatus {
  const sandboxVerified = sandbox?.ok === true
  const conversionVerified = sandboxVerified && conversion?.ok === true
  const containerSid = sandbox?.ok === true ? sandbox.containerSid : null
  const evidence = conversionVerified && sandbox?.ok === true && conversion?.ok === true
    ? `Windows 沙箱自检通过（容器 ${sandbox.containerSid}）：越权读文件被拒、联网被阻断、内存上限生效、进程树被终止；并在同一沙箱内完成了一次真实的 DOCX→PDF 转换（${conversion.version}，${conversion.pdfBytes} 字节）。`
    : null
  let detail: string
  if (sandbox === null) detail = MESSAGES.sandboxUntested
  else if (!sandbox.ok) detail = `${MESSAGES.sandboxDenied}${sandbox.reason}`
  else if (conversion === null) detail = MESSAGES.conversionUntested
  else if (!conversion.ok) detail = `${MESSAGES.conversionUntested}${conversion.reason}`
  else detail = ''
  return {
    sandboxTested: sandbox !== null,
    sandboxVerified,
    conversionVerified,
    containerSid,
    evidence,
    detail,
    reason: `${MESSAGES.isolationUnavailable}${detail}`,
  }
}

export function windowsOfficeIsolation(): OfficeIsolation {
  const status = officeIsolationStatus()
  if (status.sandboxVerified && status.conversionVerified && status.evidence) {
    return {
      verified: true,
      restrictedPermissions: true,
      networkBlocked: true,
      boundedResources: true,
      windowsProcessTreeValidated: true,
      evidence: status.evidence,
    }
  }
  return {
    verified: false,
    restrictedPermissions: false,
    networkBlocked: false,
    boundedResources: false,
    windowsProcessTreeValidated: false,
    reason: status.reason,
  }
}

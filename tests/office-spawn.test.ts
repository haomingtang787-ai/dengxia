import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { consoleVersionExecutable, isolatedProfileXml, libreOfficeArgs, OFFICE_SPAWN, writeIsolatedProfile } from '../src/providers/libreoffice'
import { buildWorkerEnv } from '../src/providers/workerEnv'
import { planOfficeConversion } from '../src/providers/officeGateway'

describe('office spawn gate', () => {
  it('builds a shell-free conversion command and an isolated macro-disabled profile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-profile-'))
    writeIsolatedProfile(dir)
    const xml = fs.readFileSync(path.join(dir, 'user', 'registrymodifications.xcu'), 'utf8')
    expect(xml).toContain('DisableMacrosExecution')
    expect(xml).toContain('<value>true</value>')
    expect(xml).toContain('/org.openoffice.Office.Writer/Content/Update')
    expect(isolatedProfileXml()).toContain('<prop oor:name="Link" oor:op="fuse" oor:finalized="true"><value>2</value></prop>')
    expect(isolatedProfileXml()).toContain('<prop oor:name="Link" oor:op="fuse" oor:finalized="true"><value>1</value></prop>')
    const args = libreOfficeArgs(dir, path.join(dir, 'out'), path.join(dir, 'in.docx'))
    expect(OFFICE_SPAWN.shell).toBe(false)
    expect(args).toContain('--headless')
    expect(args.some((arg) => arg.startsWith('-env:UserInstallation=file:'))).toBe(true)
    expect(args).not.toContain('sh')
    expect(args).not.toContain('cmd.exe')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('uses the console launcher next to soffice.exe for version probing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-soffice-'))
    const exe = path.join(dir, 'soffice.exe')
    const com = path.join(dir, 'soffice.com')
    fs.writeFileSync(exe, '')
    fs.writeFileSync(com, '')
    expect(consoleVersionExecutable(exe)).toBe(com)
    expect(consoleVersionExecutable(com)).toBe(com)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not plan conversion while isolation is unverified', () => {
    const missing = planOfficeConversion({ path: null, fileFound: false })
    expect(missing.mode).toBe('skip')
    if (missing.mode === 'skip') expect(missing.code).toBe('CONVERTER_MISSING')
    const present = planOfficeConversion({ path: '/usr/bin/soffice', fileFound: true })
    expect(present.mode).toBe('skip')
    if (present.mode === 'skip') {
      expect(present.code).toBe('CONVERSION_FAILED')
      expect(present.message).toContain('没有启动')
    }
  })

  it('does not pass secrets or claim a network block in the worker environment', () => {
    const env = buildWorkerEnv({ PATH: '/usr/bin', SUPER_SECRET: 'nope', HTTP_PROXY: 'http://proxy', NODE_OPTIONS: '--require evil' }, '/tmp/desk-work')
    expect(env.SUPER_SECRET).toBeUndefined()
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

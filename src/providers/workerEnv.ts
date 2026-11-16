export function buildWorkerEnv(source: NodeJS.ProcessEnv, tempDir: string): NodeJS.ProcessEnv {
  const allow = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'SYSTEMROOT',
    'WINDIR',
    'PATHEXT',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'COMMONPROGRAMFILES',
    'APPDATA',
    'LOCALAPPDATA',
    'LD_LIBRARY_PATH',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of allow) {
    const value = source[key]
    if (value) env[key] = value
  }
  env.ELECTRON_RUN_AS_NODE = '1'
  env.TMPDIR = tempDir
  env.TEMP = tempDir
  env.TMP = tempDir
  return env
}

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export class OcrError extends Error {}

/** Windows OCR 会在汉字之间插空格；这里只合并中文之间的空格，英文单词间距保留。 */
export function normalizeOcrText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => {
      let text = line.replace(/\s+/g, ' ').trim()
      text = text.replace(/(?<=[\u3400-\u9fff]) (?=[\u3400-\u9fff])/g, '')
      text = text.replace(/(?<=[\u3400-\u9fff]) (?=[，。、；：！？）》」』])/g, '')
      text = text.replace(/(?<=[（《「『]) (?=[\u3400-\u9fff])/g, '')
      return text
    })
    .filter(Boolean)
    .join('\n')
}

const OCR_SCRIPT = [
  "param(",
  "  [Parameter(Mandatory = $true)][string]$Path,",
  "  [string]$Language = 'zh-Hans-CN'",
  ")",
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]',
  '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]',
  '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]',
  '$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]',
  '',
  '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
  "  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'",
  '})[0]',
  '',
  'function Await($WinRtTask, $ResultType) {',
  '  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)',
  '  $netTask = $asTask.Invoke($null, @($WinRtTask))',
  '  $netTask.Wait(-1) | Out-Null',
  '  $netTask.Result',
  '}',
  '',
  '$full = [IO.Path]::GetFullPath($Path)',
  'if (!(Test-Path -LiteralPath $full -PathType Leaf)) {',
  '  throw "image not found: $full"',
  '}',
  '',
  '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])',
  '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '',
  '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language -ArgumentList $Language))',
  'if ($null -eq $engine) {',
  '  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
  '}',
  'if ($null -eq $engine) {',
  '  throw "no OCR engine available"',
  '}',
  '',
  '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  '$lines = @($result.Lines | ForEach-Object { $_.Text })',
  '$payload = @{',
  '  text = ($lines -join "`n")',
  '  lines = $lines',
  '  language = $engine.RecognizerLanguage.LanguageTag',
  '}',
  '[Console]::Out.Write((ConvertTo-Json -Compress -Depth 4 $payload))',
].join('\n')

type OcrOptions = { timeoutMs?: number; tmpDir?: string }

function powershellPath(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return fs.existsSync(candidate) ? candidate : 'powershell.exe'
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(new OcrError(`本机 OCR 失败：${String(stderr || error.message).trim().slice(0, 300)}`))
          return
        }
        resolve(String(stdout))
      },
    )
  })
}

/** 调 Windows 自带 OCR（Windows.Media.Ocr），不联网、不装第三方模型。 */
export async function ocrImage(filePath: string, options: OcrOptions = {}): Promise<{ text: string; language: string }> {
  const scriptPath = path.join(options.tmpDir ?? os.tmpdir(), `desk-ocr-${randomUUID()}.ps1`)
  fs.writeFileSync(scriptPath, `\ufeff${OCR_SCRIPT}`, 'utf8')
  try {
    const stdout = await run(
      powershellPath(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Path', filePath],
      options.timeoutMs ?? 30_000,
    )
    let parsed: { text?: unknown; language?: unknown }
    try {
      parsed = JSON.parse(stdout.trim()) as { text?: unknown; language?: unknown }
    } catch {
      throw new OcrError('本机 OCR 没有返回可解析的结果。')
    }
    const text = normalizeOcrText(typeof parsed.text === 'string' ? parsed.text : '')
    if (!text) throw new OcrError('这一页本机 OCR 没有识别到文字。可以换一张更清晰的图，或让 AI 读图。')
    return { text, language: typeof parsed.language === 'string' ? parsed.language : '' }
  } finally {
    fs.rmSync(scriptPath, { force: true })
  }
}

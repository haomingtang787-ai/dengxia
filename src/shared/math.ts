export type MathSegment = { kind: 'text'; text: string } | { kind: 'math'; value: string; display: boolean }

const PATTERN = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$(?:\\.|[^$\\])+\$|\\\([\s\S]*?\\\))/g

/** 只认 $...$、$$...$$、\(...\)、\[...\]；空串、超长或没闭合的保留原文。 */
export function splitMath(input: string, limit = 500): MathSegment[] {
  const segments: MathSegment[] = []
  const pushText = (text: string) => {
    if (!text) return
    const tail = segments[segments.length - 1]
    if (tail && tail.kind === 'text') tail.text += text
    else segments.push({ kind: 'text', text })
  }
  let last = 0
  for (const match of input.matchAll(PATTERN)) {
    const raw = match[0]
    const index = match.index ?? 0
    if (index > last) pushText(input.slice(last, index))
    let value = raw
    let display = false
    if (raw.startsWith('$$')) {
      value = raw.slice(2, -2)
      display = true
    } else if (raw.startsWith('\\[')) {
      value = raw.slice(2, -2)
      display = true
    } else if (raw.startsWith('$')) {
      value = raw.slice(1, -1)
    } else {
      value = raw.slice(2, -2)
    }
    value = value.trim()
    if (!value || value.length > limit) {
      pushText(raw)
    } else {
      segments.push({ kind: 'math', value, display })
    }
    last = index + raw.length
  }
  if (last < input.length) pushText(input.slice(last))
  return segments
}

import type { StudyUnit } from '../shared/study'

const normalize = (text: string) => text.replace(/\s+/g, '')

/**
 * 模型写讲稿时会顺手把两句原文合成一句，或者漏字。这里把每个引用收回到
 * 课件里真能逐字找到的最长前缀；一句都对不上的保留原样并计数，交给界面提示，
 * 不假装它一定是原文。
 */
export function groundUnits(units: StudyUnit[], material: string): { units: StudyUnit[]; ungrounded: number } {
  const haystack = normalize(material)
  if (!haystack) return { units, ungrounded: 0 }
  let ungrounded = 0
  const next = units.map((unit) => ({
    ...unit,
    segments: unit.segments.map((segment) => {
      const source = segment.source.trim()
      if (!source) return segment
      if (haystack.includes(normalize(source))) return segment
      const trimmed = longestVerbatimPrefix(source, haystack)
      if (trimmed) return { ...segment, source: trimmed }
      ungrounded += 1
      return segment
    }),
  }))
  return { units: next, ungrounded }
}

function longestVerbatimPrefix(source: string, haystack: string): string | null {
  const cuts: number[] = []
  for (let index = 0; index < source.length; index += 1) {
    if ('。！？；!?;'.includes(source[index]!)) cuts.push(index + 1)
  }
  cuts.push(source.length)
  let best = ''
  for (const cut of cuts) {
    const candidate = source.slice(0, cut).trim()
    if (normalize(candidate).length < 8) continue
    if (haystack.includes(normalize(candidate))) best = candidate
    else break
  }
  return best || null
}

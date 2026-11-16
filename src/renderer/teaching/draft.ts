import type { CreateLectureBody } from '../../shared/teaching'

export type DraftBlock = { kind: string; text: string }

export type LocalDraft = Omit<CreateLectureBody, 'requestId' | 'documentVersionId' | 'habitStamp'>

const MAX_UNIT_CHARS = 420
const MAX_UNIT_BLOCKS = 6
const MIN_MINUTES = 2
const MAX_MINUTES = 12
const CHARS_PER_MINUTE = 200

function firstSentence(text: string): string {
  const sentence = /^[^。！？!?；;]{1,40}/.exec(text)?.[0] ?? text
  return sentence.trim().slice(0, 40)
}

function estimateMinutes(chars: number): number {
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.ceil(chars / CHARS_PER_MINUTE)))
}

/**
 * 没有接模型时的本地拆讲：按标题分段，没有标题就按长度切。
 * 讲解正文就是原文，不冒充老师的话；接上模型后同一结构由模型填写 teaching。
 */
export function buildLocalDraft(input: {
  title: string
  sourceName: string
  blocks: DraftBlock[]
  pageLabel?: string
}): LocalDraft | null {
  const blocks = input.blocks
    .map((block) => ({ kind: block.kind, text: block.text.trim() }))
    .filter((block) => block.text.length > 0)
  if (blocks.length === 0) return null

  const groups: Array<{ title: string; texts: string[]; chars: number }> = []
  let current: { title: string; texts: string[]; chars: number } | null = null

  for (const block of blocks) {
    const heading = block.kind === 'heading'
    if (heading && current) {
      groups.push(current)
      current = null
    }
    if (!current) {
      current = { title: heading ? block.text.slice(0, 40) : firstSentence(block.text), texts: [], chars: 0 }
    }
    current.texts.push(block.text)
    current.chars += block.text.length
    if (!heading && (current.chars >= MAX_UNIT_CHARS || current.texts.length >= MAX_UNIT_BLOCKS)) {
      groups.push(current)
      current = null
    }
  }
  if (current) groups.push(current)

  const units = groups.map((group, index) => ({
    title: group.title || `第 ${index + 1} 讲`,
    minutes: estimateMinutes(group.chars),
    source: input.pageLabel ? `${input.pageLabel} · 第 ${index + 1} 段` : `第 ${index + 1} 段`,
    teaching: group.texts.join('\n\n'),
    pause: '',
    terms: [],
    pitfall: '',
    weight: 'core' as const,
    example: '',
  }))

  return {
    title: input.title,
    subject: '',
    sourceName: input.sourceName,
    greeting: '',
    thesis: '',
    tonight: '',
    nextSitting: '',
    rawText: blocks.map((block) => block.text).join('\n'),
    units,
    summary: {
      outline: units.map((unit) => unit.title),
      mustKnow: [],
      pitfalls: [],
      mnemonic: '',
      recital: '',
    },
    cards: [],
    quizzes: [],
  }
}

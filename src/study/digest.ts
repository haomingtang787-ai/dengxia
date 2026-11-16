import type { AiClient } from '../ai/client'
import { ArgumentError } from '../domain/validation'
import { parseDigest } from './parse'

/** 一次直接拆课能安全送进模型的字数。超过它就必须分段理解，否则会撞上下文上限。 */
export const DIRECT_PLAN_CHARS = 60_000
/** 材料硬上限。再长就只处理前 60 万字，并明确告诉用户被截断。 */
export const MAX_MATERIAL_CHARS = 600_000
export const MAX_CHUNKS = 12
const MIN_CHUNK_CHARS = 16_000

export type MaterialChunk = {
  index: number
  range: string
  text: string
}

export type MaterialDigest = {
  index: number
  range: string
  topics: string[]
  keyPoints: string[]
  quotes: string[]
  formulas: string[]
  examples: string[]
  pitfalls: string[]
}

const DIGEST_SYSTEM = [
  '你是课件阅读器。你只做一件事：把这一段课件读懂，提取后面设计课程需要的结构。',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要解释。',
  '字段：range, topics[], keyPoints[], quotes[], formulas[], examples[], pitfalls[]。',
  'range 写这一段覆盖的页码范围，必须用原文里的页码标注，例如「第 3–8 页」。',
  'topics 写这一段在讲的 2 到 6 个主题，按原文顺序。',
  'keyPoints 写必须掌握的知识点，每条一句，保留定义、条件、因果和关键数字；6 到 14 条。',
  'quotes 逐字摘抄这一段里最能代表知识点的原句，4 到 12 条；必须一字不改地复制原文，不要改写、不要合并句子、不要加解释。后面讲稿要拿这些原句当逐字讲解的底稿。',
  'formulas 写原文出现的公式或符号，按原样抄，不要改写；没有就给空数组。',
  'examples 写原文给的例题、实验、案例，2 到 6 条；没有就给空数组。',
  'pitfalls 写这一段里容易混淆、容易错的地方，1 到 6 条；没有就给空数组。',
  '不要编造原文没有的内容；不要写作者、机构、版权、页眉页脚、页码、致谢、参考文献。',
].join('\n')

export function buildDigestPrompt(chunk: MaterialChunk, repairNote?: string): string {
  // 重试说明放在末尾：前缀与上一次完全一致，服务端前缀缓存能整段命中，重试只花增量。
  return [
    `这是整份课件的第 ${chunk.index + 1} 段，页码范围：${chunk.range}。`,
    '下面是这一段的原文，请读懂后输出结构化理解。',
    chunk.text,
    repairNote ? `上一次输出不合格：${repairNote}。请重新输出完整 JSON。` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function pageLabels(text: string): string[] {
  return [...text.matchAll(/【([^】]{1,60})】/g)].map((match) => match[1]!.trim())
}

function rangeOf(text: string, fallbackIndex: number): string {
  const labels = pageLabels(text)
  if (labels.length === 0) return `第 ${fallbackIndex + 1} 段`
  const first = labels[0]!
  const last = labels[labels.length - 1]!
  return first === last ? first : `${first} — ${last}`
}

/**
 * 按页边界切块。切点优先落在「【第 X 页】」之间，实在没有页标记才按字数硬切，
 * 这样每一段仍然能对应回原文位置。
 */
export function splitMaterial(text: string, maxChars = DIRECT_PLAN_CHARS): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const parts = trimmed.split(/\n{2,}(?=【)/).filter(Boolean)
  const chunks: string[] = []
  let current = ''
  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }
  for (const part of parts) {
    if (part.length > maxChars) {
      flush()
      for (let offset = 0; offset < part.length; offset += maxChars) {
        chunks.push(part.slice(offset, offset + maxChars))
      }
      continue
    }
    const next = current ? `${current}\n\n${part}` : part
    if (next.length > maxChars) {
      flush()
      current = part
    } else {
      current = next
    }
  }
  flush()
  return chunks
}

export function toChunks(text: string): MaterialChunk[] {
  const size = Math.max(MIN_CHUNK_CHARS, Math.ceil(text.length / MAX_CHUNKS))
  return splitMaterial(text, size).map((chunk, index) => ({
    index,
    range: rangeOf(chunk, index),
    text: chunk,
  }))
}

export function renderDigests(digests: MaterialDigest[]): string {
  return digests
    .map((digest) => {
      const section = (title: string, items: string[]) =>
        items.length ? `${title}：${items.join('；')}` : ''
      return [
        `【第 ${digest.index + 1} 段 · ${digest.range}】`,
        section('主题', digest.topics),
        section('知识点', digest.keyPoints),
        digest.quotes.length ? `原文摘录（逐字，讲稿的 source 只能从这里选）：\n${digest.quotes.map((quote) => `- ${quote}`).join('\n')}` : '',
        section('公式与符号', digest.formulas),
        section('例题与案例', digest.examples),
        section('易错', digest.pitfalls),
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}

export type DigestOutcome = {
  digests: MaterialDigest[]
  warnings: string[]
}

/**
 * 逐段理解。单段失败会重试一次；仍失败就把原文前 3000 字当降级结果，
 * 并把「这一段模型没读懂」写进警告，不用一份假摘要盖过去。
 */
export async function digestMaterial(
  client: Pick<AiClient, 'complete'>,
  text: string,
  options: { onProgress?: (done: number, total: number) => void; concurrency?: number } = {},
): Promise<DigestOutcome> {
  const chunks = toChunks(text)
  if (chunks.length === 0) throw new ArgumentError('材料是空的，没有可理解的内容。')
  const digests: MaterialDigest[] = new Array(chunks.length)
  const warnings: string[] = []
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, chunks.length))
  let done = 0
  // 80 页课件以前串行读，十几分钟没有反馈；这里三路并行，顺序与警告按原顺序落回。
  let cursor = 0
  const worker = async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= chunks.length) return
      const chunk = chunks[index]!
      let digest: MaterialDigest | null = null
      let lastError = ''
      for (let attempt = 0; attempt < 2 && !digest; attempt += 1) {
        try {
          const raw = await client.complete(DIGEST_SYSTEM, buildDigestPrompt(chunk, attempt ? lastError : undefined), 4000, 'disabled', 'digest')
          const parsed = parseDigest(raw)
          digest = { ...parsed, index: chunk.index, range: parsed.range || chunk.range }
        } catch (error) {
          lastError = error instanceof Error ? error.message : '输出不合格'
        }
      }
      if (!digest) {
        digest = {
          index: chunk.index,
          range: chunk.range,
          topics: [],
          keyPoints: [chunk.text.slice(0, 3000)],
          quotes: chunk.text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length >= 8 && !line.startsWith('【'))
            .slice(0, 8),
          formulas: [],
          examples: [],
          pitfalls: [],
        }
        warnings[index] = `第 ${chunk.index + 1} 段（${chunk.range}）模型没有读懂，只按原文前 3000 字进入课程。原因：${lastError}`
      }
      digests[index] = digest
      done += 1
      options.onProgress?.(done, chunks.length)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return { digests, warnings: warnings.filter(Boolean) }
}

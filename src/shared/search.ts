export type SearchHit = {
  documentId: string
  documentVersionId: string
  displayName: string
  format: string
  pageNumber: number | null
  pageId: string | null
  blockId: string
  kind: string
  snippet: string
}

export type SearchList = { items: SearchHit[]; total: number; query: string }

export type SearchBody = { query: string; limit?: number }

/** 用户输入按空白切成字面 token，再用 FTS5 的 AND 串起来；不把 + - : * 当操作符。 */
export function buildFtsQuery(input: string): string {
  const tokens = searchQueryTokens(input)
  if (tokens.length === 0) return ''
  return tokens
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' AND ')
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const WORD_RE = /[\p{L}\p{N}]+/gu
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu

/**
 * FTS5 的 unicode61 会把一整段中文当成一个词，所以入库/查询前都切成
 * 单字 + 相邻双字。这样「矩阵」「特征值」和更长中文词都能命中。
 */
export function searchIndexText(input: string): string {
  const tokens: string[] = []
  for (const run of input.match(CJK_RUN_RE) ?? []) {
    for (let index = 0; index < run.length; index += 1) {
      tokens.push(run[index])
      if (index + 2 <= run.length) tokens.push(run.slice(index, index + 2))
    }
  }
  for (const word of input.normalize('NFKC').match(WORD_RE) ?? []) {
    const lower = word.toLocaleLowerCase()
    if (!CJK_RE.test(lower)) tokens.push(lower.slice(0, 64))
  }
  return tokens.join(' ')
}

export function searchQueryTokens(input: string): string[] {
  const groups = input.trim().split(/\s+/).filter(Boolean).slice(0, 8)
  const tokens = new Set<string>()
  for (const group of groups) {
    for (const token of searchIndexText(group).split(' ')) {
      if (token) tokens.add(token)
    }
  }
  return [...tokens].slice(0, 48)
}

/** 给搜索结果做纯文本片段，避免把 FTS 返回的 HTML 直接交给界面。 */
export function snippetText(text: string, query: string, radius = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  let hit = -1
  let hitLength = 0
  for (const token of tokens) {
    const index = clean.toLocaleLowerCase().indexOf(token.toLocaleLowerCase())
    if (index >= 0 && (hit < 0 || index < hit)) {
      hit = index
      hitLength = token.length
    }
  }
  if (hit < 0) return clean.length > radius * 2 ? `${clean.slice(0, radius * 2)}…` : clean
  const start = Math.max(0, hit - radius)
  const end = Math.min(clean.length, hit + hitLength + radius)
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`
}

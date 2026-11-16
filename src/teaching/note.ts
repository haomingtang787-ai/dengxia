import type { LectureDetail, MissItem } from '../shared/teaching'

function dateOf(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 课后笔记只写已经发生的事：听懂几讲、哪些还没懂、错题本、几张卡片到点。
 * 不补没讲过的内容，没听懂就照实写。
 */
export function buildNote(input: {
  detail: LectureDetail
  misses: MissItem[]
  dueCount: number
  now: Date
}): string {
  const { detail, misses, dueCount, now } = input
  const unknown = detail.units.filter((unit) => !detail.known.includes(unit.id)).map((unit) => unit.title)
  const outline = detail.summary.outline.length ? detail.summary.outline : detail.units.map((unit) => unit.title)
  const lines: string[] = [
    `# ${detail.title} · 课后笔记`,
    '',
    dateOf(now),
    '',
    '## 这一页讲了什么',
    ...outline.map((line) => `- ${line}`),
    '',
    '## 必考',
  ]
  if (detail.summary.mustKnow.length) {
    lines.push(...detail.summary.mustKnow.map((line) => `- ${line}`))
  } else {
    lines.push('- 这一页还没有标出必考点。')
  }
  lines.push('', '## 你的进度', `听懂 ${detail.knownCount}/${detail.unitCount} 讲。`)
  lines.push(unknown.length ? `还没懂：${unknown.join('、')}。` : '这一页的小讲都点过听懂了。')
  if (detail.summary.pitfalls.length) {
    lines.push('', '## 容易记反', ...detail.summary.pitfalls.map((line) => `- ${line}`))
  }
  lines.push('', '## 错题')
  if (misses.length) {
    lines.push(...misses.map((miss) => `- ${miss.prompt}${miss.explain ? ` — ${miss.explain}` : ''}`))
  } else {
    lines.push('- 还没有错题。')
  }
  lines.push('', '## 下一坐')
  if (dueCount > 0) {
    lines.push(`${dueCount} 张卡片到点，先复习再来下一讲。`)
  } else {
    lines.push('现在没有到点的卡片；下一坐接着上还没听懂的小讲。')
  }
  return `${lines.join('\n')}\n`
}

import type { Habits } from '../teaching/habits'
import { habitBrief } from '../teaching/habits'

export type PromptBlock = { kind: string; text: string }

const MAX_MATERIAL_CHARS = 12000

const SYSTEM = [
  '你是「灯下」里的老师，用中文把这页材料拆成可以一小讲一小讲上的课。',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要解释。',
  '字段：title, subject, greeting, thesis, tonight, nextSitting,',
  'units[{title, minutes, source, teaching, pause, terms[{word, meaning}], pitfall, weight, example}],',
  'summary{outline, mustKnow, pitfalls, mnemonic, recital},',
  'cards[{front, back}], quizzes[{prompt, choices, answer, explain}]。',
  'units 一页 1 到 8 讲，按原文顺序；minutes 是 2 到 12 的整数；teaching 90 到 240 字，用口语，把这一句讲完；',
  'pause 是讲到这里先停一下、让学生自己想的问题，没有就空字符串；weight 只能是 core 或 support。',
  'cards 4 到 12 张，正面是一个能问出口的问题，背面是答案；quizzes 3 到 8 道，choices 2 到 4 个，answer 是正确选项从 0 开始的下标。',
  '不要编造原文里没有的事实；不够讲的地方就少讲一讲，不要凑。',
  '忽略作者、编者、机构、出版社、版权页、页眉页脚、页码、日期、致谢和参考文献列表等非知识信息，只围绕原文里的学科知识点拆讲。',
].join('\n')

export function buildLecturePrompt(input: {
  title: string
  subject: string
  blocks: PromptBlock[]
  habits: Habits
  pageLabel?: string
}): { system: string; user: string } {
  const material = input.blocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_MATERIAL_CHARS)
  const heading = [
    `材料：${input.title}`,
    input.subject ? `科目：${input.subject}` : '',
    input.pageLabel ? `位置：${input.pageLabel}` : '',
  ]
    .filter(Boolean)
    .join('；')
  const user = [
    habitBrief(input.habits),
    heading,
    '原文：',
    material,
    '请按上面的习惯和原文拆讲，只讲原文支持的內容。',
  ].join('\n')
  return { system: SYSTEM, user }
}

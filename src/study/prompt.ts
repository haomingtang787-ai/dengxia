import type { Habits } from '../teaching/habits'
import { habitBrief } from '../teaching/habits'
import type { StudyCheck, StudyMessage, StudySummary, StudyUnit } from '../shared/study'
import type { TeacherPromptContext } from '../shared/teacher'

const PLAN_SYSTEM = [
  '你是「灯下」的课程设计师，也是一位会当面讲课的私教。',
  '你的任务不是摘要，而是先把整份材料读懂，再按学生习惯拆成能一节一节上的课。',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要解释。',
  '字段：title, subject, overview, opening, units[{title, source, minutes, keyPoints, segments[{source, explain, check}]}]。',
  'overview 要说明整份材料在讲什么、知识之间怎么连起来，150 到 300 字。',
  'units 按原文顺序拆成 1 到 24 讲；一份 80 页的课件可以拆成 10 到 24 讲，讲少会漏知识点。minutes 是 3 到 15 的整数。',
  '每个 unit 的 segments 是逐句讲稿：source 必须引用原文里真实出现的一句或一个公式，不能改写；',
  '每个 unit 至少 2 个 segments、最多 8 个；必须覆盖这一讲涉及的原文句子所表达的知识；',
  '如果这一讲只有一句话，也要把这句话拆成至少两个讲解层次：同一句可以重复 source，但 explain 必须分别讲不同的难点，不能复制同一段解释；',
  'explain 用老师当面讲的口吻把这一句讲透，先接住这句话，再讲条件、因果和容易误解的地方，80 到 220 字；',
  'check 是讲完这句后问学生的一个小问题，没有就空字符串。',
  'keyPoints 是本讲必须掌握的点，2 到 6 条。',
  'opening 是老师第一次开口，说明会怎么带学生学，80 到 160 字。',
  '必须覆盖整份材料的主要知识点；不要编造原文没有的事实；不要凑讲。',
  '忽略作者、编者、机构、出版社、版权页、页眉页脚、页码、日期、致谢和参考文献列表等非知识信息。',
].join('\n')

const CHAT_SYSTEM = [
  '你是学生的私教，正在基于给定课件上课。',
  '你必须贴着课件原文讲，先回答学生此刻的问题，再把它接回本讲和整门课的知识结构。',
  '像老师当面说话：短句、具体、有停顿；不要把回答写成教科书目录。',
  '学生没听懂时换一个比方或换一种说法，不要重复同一段话。',
  '不要编造课件没有的事实；如果课件不足以回答，明确说出来，并告诉学生缺什么。',
  '每一次回答都要尽量指出对应的原文句子或公式，让学生知道依据在哪里。',
  '忽略作者、编者、机构、出版社、版权页、页眉页脚、页码、日期、致谢和参考文献列表等非知识信息。',
].join('\n')

const SUMMARY_SYSTEM = [
  '你是学习分析师。根据整门课的设计和这次学习对话，为学生写一份可执行的学习分析总结。',
  '只依据给定材料与对话，不要编造学生没有表现出来的掌握情况。',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要解释。',
  '字段：overview, mastered[], weak[], pitfalls[], next[]。',
  'overview 用 120 到 220 字说明这次学到哪里、整体状态如何。',
  'mastered 写已经能复述或答对的内容；weak 写仍然含糊、需要再讲的内容；pitfalls 写容易混淆或做错的地方；next 写下一步具体做什么。',
  '每个数组 2 到 6 条，每条一句话，不要空泛。',
].join('\n')

const NOTE_SYSTEM = [
  '你是学生的老师。下课时，你要写一份只属于这次课堂的老师手记，留给下一次的自己看。',
  '只依据本次课堂的讲解、学生作答和对话，不要编造学生没有表现出来的掌握情况。',
  '只输出一个 JSON 对象，不要 markdown 代码块，不要解释。',
  '字段：summary, worked[], stuck[], next[]。',
  'summary 用 80 到 160 字说明这次课到底学到了哪里。',
  'worked 写这次真正讲通、学生能复述的内容；stuck 写仍然卡住、含糊或答错的地方；next 写下一次课最该先做什么。',
  '每个数组 1 到 5 条，每条一句话，具体到知识点或动作。',
].join('\n')

/** 老师人格与档案的简短注入，控制在 400 字以内。 */
export function teacherBrief(teacher: TeacherPromptContext): string {
  const profile = teacher.profile
  const subjects = profile.subjects.length ? profile.subjects.join('、') : '未填'
  const lines = [
    `你的名字是「${teacher.name}」。学生可以改称呼，但人格是同一套。`,
    `你的语气：${teacher.tone}。你不替学生思考，先问清他卡在哪，再讲。`,
    `学生目标：${profile.goal || '未填'}；当前水平：${profile.level || '未填'}；学科：${subjects}。`,
    profile.weeklyMinutes > 0 ? `每周可投入约 ${profile.weeklyMinutes} 分钟。` : '',
    profile.notes ? `学生补充：${profile.notes}` : '',
    teacher.boundaries.length ? `边界：${teacher.boundaries.join('；')}` : '',
    teacher.memories.length
      ? `你记得（按可信度排序，未确认的先用“我观察到……”说出来再请学生确认）：\n${teacher.memories
          .map((memory) => `- [${memory.userConfirmed ? '已确认' : '观察'}] ${memory.kind}：${memory.statement}`)
          .join('\n')}`
      : '你还没有关于这个学生的长期记忆；这次课后要记下真正有用的观察。',
  ]
  return lines.filter(Boolean).join('\n')
}

export function buildStudyPlanPrompt(input: {
  title: string
  subject: string
  material: string
  habits: Habits
  teacher?: TeacherPromptContext
  truncated: boolean
  digests?: string
  chunkCount?: number
  repairNote?: string
}): { system: string; user: string } {
  const chunked = Boolean(input.digests && input.chunkCount && input.chunkCount > 1)
  const user = [
    input.teacher ? teacherBrief(input.teacher) : '',
    habitBrief(input.habits),
    `材料：${input.title}${input.subject ? `；科目：${input.subject}` : ''}`,
    chunked
      ? `这份材料很长，已经按页分成 ${input.chunkCount} 段逐段读懂。下面是每一段的理解结果，都带页码范围和逐字摘录的原文。拆课必须覆盖全部 ${input.chunkCount} 段，不能只讲前半份；每个 unit 的 source 写它覆盖的页码范围，例如「第 3–5 页」。`
      : '',
    input.truncated ? '注意：材料超过处理上限，下面只是前面部分；请基于已给部分拆课，并在 overview 里说明覆盖范围。' : '',
    chunked ? '请先读懂这些分段理解，再按上面的习惯设计课程和逐句讲稿。每个 segment 的 source 必须逐字选自同一段「原文摘录」，不能改写、不能自己造句；摘录不够就少讲一句，不要编原文。' : '请先完整读懂，再按上面的习惯设计课程和逐句讲稿。',
    chunked ? '下面是逐段理解结果：' : '下面是材料全文：',
    chunked ? input.digests! : input.material,
    // 重试说明放在末尾：前缀与上一次完全一致，服务端前缀缓存整段命中，重试只花增量。
    input.repairNote ? `上一次输出不合格：${input.repairNote}。请重新输出完整 JSON，并确保每个 unit 至少有两个不同的讲解层次；把 units 控制在 12 讲以内、每讲 segments 最多 5 个，宁可少讲两句也要保证 JSON 完整闭合、能被直接解析。` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return { system: PLAN_SYSTEM, user }
}

export function buildStudyChatPrompt(input: {
  overview: string
  outline: string[]
  units: StudyUnit[]
  unit: StudyUnit | null
  messages: StudyMessage[]
  question: string
  habits: Habits
  teacher?: TeacherPromptContext
}): { system: string; user: string } {
  const teacherSystem = input.teacher
    ? `你的名字是「${input.teacher.name}」。保持同一个人格：${input.teacher.tone}。不要因为换了学科就变成另一个人。`
    : ''
  const system = teacherSystem ? `${CHAT_SYSTEM}\n\n${teacherSystem}` : CHAT_SYSTEM
  const unitText = input.unit
    ? [
        `当前小讲：第 ${input.unit.ordinal + 1} 讲《${input.unit.title}》（${input.unit.source}）`,
        '本讲逐句讲稿：',
        ...input.unit.segments.map((segment, index) =>
          [`${index + 1}. 原文：${segment.source}`, `   老师已经讲过：${segment.explain}`, segment.check ? `   曾问：${segment.check}` : '']
            .filter(Boolean)
            .join('\n'),
        ),
        `本讲必须掌握：${input.unit.keyPoints.join('；')}`,
      ].join('\n')
    : '当前没有指定小讲，请按整门课回答。'
  const history = input.messages
    .slice(-12)
    .map((message) => `${message.role === 'user' ? '学生' : '老师'}：${message.content}`)
    .join('\n')
  // 跨讲的追问只给标题不够：把每讲要点压成一份索引，模型才能把问题接回全课，而不是只说「这一讲没讲」。
  let indexBudget = 2600
  const index: string[] = []
  for (const [position, unit] of input.units.entries()) {
    const line = `第 ${position + 1} 讲《${unit.title}》：${unit.keyPoints.slice(0, 6).join('；')}`
    if (indexBudget - line.length < 0) break
    indexBudget -= line.length
    index.push(line)
  }
  const user = [
    input.teacher ? teacherBrief(input.teacher) : '',
    habitBrief(input.habits),
    `课程总览：${input.overview}`,
    `课程大纲：${input.outline.map((item, index) => `${index + 1}. ${item}`).join('；')}`,
    index.length ? `全课要点索引（学生问到别的讲时用它接回去，不要编造索引里没有的内容）：\n${index.join('\n')}` : '',
    unitText,
    history ? `最近对话：\n${history}` : '',
    `学生现在问：${input.question}`,
    '请先直接回答这个问题，再把它接回本讲原文；不要复述整段讲稿。',
  ]
    .filter(Boolean)
    .join('\n\n')
  return { system, user }
}

export function buildStudySummaryPrompt(input: {
  title: string
  overview: string
  units: StudyUnit[]
  messages: StudyMessage[]
  checks: StudyCheck[]
}): { system: string; user: string } {
  const transcript = input.messages
    .slice(-40)
    .map((message) => `${message.role === 'user' ? '学生' : '老师'}：${message.content}`)
    .join('\n')
  const answers = input.checks
    .slice(0, 40)
    .map((check) => {
      const unit = input.units.find((item) => item.ordinal === check.unitOrdinal)
      return `第 ${check.unitOrdinal + 1} 讲《${unit?.title ?? ''}》\n问：${check.question}\n学生答：${check.answer}`
    })
    .join('\n\n')
  const user = [
    `课程：${input.title}`,
    `课程总览：${input.overview}`,
    `课程大纲：${input.units.map((unit, index) => `${index + 1}. ${unit.title}`).join('；')}`,
    answers ? `讲完后学生的作答（这是判断掌握程度的直接证据）：\n${answers}` : '学生还没有作答「停一下」的问题。',
    `这次对话：\n${transcript || '学生还没有在课堂里提问。'}`,
    '请写这次学习的分析总结。判断掌握程度时优先依据学生的实际作答：答得含糊的写进 weak，答错或混概念的写进 pitfalls；没有作答证据的内容不要写成已掌握。',
  ].join('\n\n')
  return { system: SUMMARY_SYSTEM, user }
}

export function buildTeacherNotePrompt(input: {
  teacherName: string
  title: string
  overview: string
  units: StudyUnit[]
  messages: StudyMessage[]
  checks: StudyCheck[]
}): { system: string; user: string } {
  const answers = input.checks
    .slice(0, 40)
    .map((check) => {
      const unit = input.units.find((item) => item.ordinal === check.unitOrdinal)
      return `第 ${check.unitOrdinal + 1} 讲《${unit?.title ?? ''}》\n问：${check.question}\n学生答：${check.answer}`
    })
    .join('\n\n')
  const transcript = input.messages
    .slice(-40)
    .map((message) => `${message.role === 'user' ? '学生' : '老师'}：${message.content}`)
    .join('\n')
  const user = [
    `你的名字：${input.teacherName}`,
    `课程：${input.title}`,
    `课程总览：${input.overview}`,
    `课程大纲：${input.units.map((unit, index) => `${index + 1}. ${unit.title}`).join('；')}`,
    answers ? `学生这次的实际作答：\n${answers}` : '学生这次没有留下作答。没有作答证据的内容不要写成已掌握。',
    `这次课堂对话：\n${transcript || '学生这次没有提问。'}`,
    '请写下一次课真正用得上的四段式老师手记。',
  ].join('\n\n')
  return { system: NOTE_SYSTEM, user }
}

export function mergeOpening(opening: string, units: StudyUnit[]): string {
  const first = units[0]
  if (!opening.trim()) return first ? `我们从第 1 讲《${first.title}》开始。` : '我们开始。'
  if (!first) return opening
  return `${opening.trim()}\n\n我们从第 1 讲《${first.title}》开始。`
}

export function emptySummary(): StudySummary {
  return { overview: '', mastered: [], weak: [], pitfalls: [], next: [] }
}

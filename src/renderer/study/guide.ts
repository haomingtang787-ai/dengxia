/**
 * 用户可见的入口名和「怎么用」指南。
 * 名字先说人话：复习不是第二套课堂，本讲资料不是整份课件，课件管理不是聊天。
 */
export const FEATURE_LABELS = {
  review: '复习与错题',
  context: '本讲资料',
  materials: '课件总览',
  manage: '课件管理',
  model: '模型设置',
  backup: '备份与恢复',
} as const

export const HELP_STEPS = [
  {
    title: '新建课程',
    body: '先建一门课。它相当于一本教材，不是一份文件。',
  },
  {
    title: '导入课件',
    body: '把 PDF、PPT 或 Word 放进这门课；老师读完会自动拆成 1–4 讲。',
  },
  {
    title: '点一讲，直接问',
    body: '点左边带「讲」编号的条目，在下面输入问题。老师只讲这一讲。',
  },
] as const

export const HELP_SECTIONS = [
  {
    title: '左边：课程和讲',
    body: '上面只用记两个按钮和一种条目：',
    items: [
      '「新建课程」= 建一本教材，先给这门课起名字。',
      '「导入课件」= 把 PDF / PPT / Word 放进当前课程；读完会自动拆讲。',
      '下面带「01、02」的是讲。点一讲，老师就只讲这一讲。',
    ],
  },
  {
    title: '中间：跟老师学',
    body: '不用先点按钮，直接在底部问。',
    items: [
      '比如「这一讲再讲慢一点」「举个生活里的例子」「考考我」。',
      '老师回答里的 p.12 是课件页码，点一下就能看原页。',
      '想细讲就说「细讲这一讲」；想练就说「考考我」。',
    ],
  },
  {
    title: `右边：${FEATURE_LABELS.context} / ${FEATURE_LABELS.materials}`,
    body: '右边是这一讲和整份课件的资料，不看也能正常听课。',
    items: [
      `「${FEATURE_LABELS.context}」= 这一讲的讲稿、知识点、题和学习资料。`,
      `「${FEATURE_LABELS.materials}」= 整份课件的目录、学习总结、老师手记和用量。`,
      `「${FEATURE_LABELS.manage}」= 改名、导入另一份、清空对话、删除这份课堂等整理操作。`,
    ],
  },
  {
    title: `左下角：${FEATURE_LABELS.review}`,
    body: '这里不是重新上课，也不生成新课程。',
    items: [
      '「复习卡」= 今天该回忆的卡片；点「看答案」，再选「记得 / 忘了」。',
      '「错题本」= 课堂里答错或做错的题，可以重做。',
      '卡片和错题会按复习计划自动排；没有就说明今天没有要复习的。',
    ],
  },
  {
    title: `设置：${FEATURE_LABELS.model}与${FEATURE_LABELS.backup}`,
    body: '最常改的是这两类；其他是占用和每月用量上限，不用动。',
    items: [
      `${FEATURE_LABELS.model} = 填模型地址和 API Key；不填，老师不能读课件，也不能回答。`,
      `${FEATURE_LABELS.backup} = 把整个资料库（课程、课件、卡片、错题、设置）复制到文件夹；不是导出某一份课件。`,
      '恢复 = 用备份覆盖当前资料库；应用会先告诉你备份里有多少内容，再让你确认。',
    ],
  },
] as const

export const HELP_FOOTER = '不用记这些按钮。你只要：选课程 → 点一讲 → 在下面问；复习和备份需要时再用。'

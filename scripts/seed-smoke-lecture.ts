/**
 * 开发与截图用的种子数据：往一个空文库写一份三段讲解。
 * 用法：node seed.mjs <library 目录>
 * 不碰用户的真实文库；只用于 DESK_SMOKE_VIEW 截图验证。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AppDatabase } from '../src/storage/database'
import { migrate } from '../src/storage/migrate'
import { Store } from '../src/storage/store'
import { TeachingService } from '../src/teaching/service'

const root = process.argv[2]
if (!root) throw new Error('用法：node seed.mjs <library 目录>')
fs.mkdirSync(root, { recursive: true })

const db = AppDatabase.open(path.join(root, 'library.sqlite'))
migrate(db)
const store = new Store(db)
const documentId = randomUUID()
const versionId = randomUUID()
store.insertDocument({ id: documentId, display_name: '光合作用（示例）.txt', created_at: new Date().toISOString() })
store.insertVersion({
  id: versionId,
  document_id: documentId,
  sha256: 'c'.repeat(64),
  format: 'txt',
  size_bytes: 0,
  original_relpath: `originals/${versionId}.txt`,
  status: 'ready',
  parser_version: 'seed',
  created_at: new Date().toISOString(),
})

const teaching = new TeachingService({ db })
const created = teaching.create({
  requestId: randomUUID(),
  documentVersionId: versionId,
  title: '光合作用 · 示例',
  subject: '生物',
  sourceName: '光合作用（示例）.txt',
  greeting: '我们来一起学习光合作用。',
  thesis: '这一页讲植物怎么把光变成能量。',
  tonight: '按你每次 15 分钟，今晚先上两讲。',
  nextSitting: '',
  rawText: '光合作用把光能转成化学能。光反应发生在类囊体薄膜上。暗反应发生在叶绿体基质里。',
  habitStamp: 'steady|story|15|evening|long|',
  units: [
    {
      title: '光合作用的组成',
      minutes: 4,
      source: '第 1 段',
      teaching: '光合作用需要光、二氧化碳和水。\n\n产物是氧气和有机物。',
      pause: '先把原料想一遍：没有光，这一步还成立吗？',
      terms: [{ word: '光合作用', meaning: '植物用光能合成有机物' }],
      pitfall: '别把原料记成产物。',
      weight: 'core',
      example: '一片叶子在阳光下放出氧气。',
    },
    {
      title: '光反应的场所',
      minutes: 5,
      source: '第 2 段',
      teaching: '光反应发生在类囊体薄膜上，把光能先存成活跃的化学能。',
      pause: '',
      terms: [],
      pitfall: '',
      weight: 'core',
      example: '',
    },
    {
      title: '暗反应的场所',
      minutes: 5,
      source: '第 3 段',
      teaching: '暗反应发生在叶绿体基质里，把二氧化碳固定成有机物。',
      pause: '',
      terms: [],
      pitfall: '光反应和暗反应的场所容易记反。',
      weight: 'support',
      example: '',
    },
  ],
  summary: {
    outline: ['光合作用的组成', '光反应的场所', '暗反应的场所'],
    mustKnow: ['光反应在类囊体薄膜'],
    pitfalls: ['记反场所'],
    mnemonic: '光在膜，暗在质',
    recital: '光能转化学能',
  },
  cards: [
    { front: '光反应在哪', back: '类囊体薄膜' },
    { front: '暗反应在哪', back: '叶绿体基质' },
  ],
  quizzes: [{ prompt: '光反应发生在哪里？', choices: ['类囊体薄膜', '叶绿体基质'], answer: 0, explain: '光反应在类囊体薄膜。' }],
})
console.log(JSON.stringify(created))
db.close()

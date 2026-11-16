// 验收仪器：核对每讲 segment.source 是否真的能在课件原文里逐字找到。
// 用法：node scripts/check-source-fidelity.mjs <library.sqlite>
import { DatabaseSync } from 'node:sqlite'

const file = process.argv[2]
if (!file) {
  console.error('用法：node scripts/check-source-fidelity.mjs <library.sqlite>')
  process.exit(2)
}

const db = new DatabaseSync(file, { readOnly: true })
const normalize = (text) => (text ?? '').replace(/\s+/g, '')

const sessions = db.prepare('SELECT id, title, material_chars, material_chunks FROM study_sessions').all()
for (const session of sessions) {
  const blocks = db.prepare('SELECT text FROM blocks WHERE document_version_id = (SELECT document_version_id FROM study_sessions WHERE id = ?)').all(session.id)
  const readings = db.prepare('SELECT text FROM image_readings WHERE document_version_id = (SELECT document_version_id FROM study_sessions WHERE id = ?)').all(session.id)
  const source = normalize([...blocks.map((row) => row.text), ...readings.map((row) => row.text)].join('\n'))
  const units = db.prepare('SELECT ordinal, title, segments_json FROM study_units WHERE session_id = ? ORDER BY ordinal').all(session.id)
  let total = 0
  let hit = 0
  const misses = []
  for (const unit of units) {
    const segments = JSON.parse(unit.segments_json)
    for (const segment of segments) {
      total += 1
      if (source.includes(normalize(segment.source))) hit += 1
      else if (misses.length < 5) misses.push(`第 ${unit.ordinal + 1} 讲：${String(segment.source).slice(0, 60)}`)
    }
  }
  const rate = total === 0 ? 0 : Math.round((hit / total) * 100)
  console.log(`\n== ${session.title} ==`)
  console.log(`材料 ${session.material_chars} 字 / ${session.material_chunks} 段；讲数 ${units.length}；逐字命中 ${hit}/${total}（${rate}%）`)
  for (const miss of misses) console.log('  未命中：', miss)
}

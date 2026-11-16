// 从 exe 里提取图标资源（RT_GROUP_ICON / RT_ICON），选中尺寸最大的一个保存为 PNG。
import fs from 'node:fs'

const exe = process.argv[2]
const outDir = process.argv[3] || '.'
const buf = fs.readFileSync(exe)

const u16 = (o) => buf.readUInt16LE(o)
const u32 = (o) => buf.readUInt32LE(o)

// DOS header → PE header
const e_lfanew = u32(0x3c)
if (buf.toString('ascii', e_lfanew, e_lfanew + 4) !== 'PE\0\0') throw new Error('不是 PE 文件')

const coff = e_lfanew + 4
const numSections = u16(coff + 2)
const sizeOfOptional = u16(coff + 16)
const opt = coff + 20
const magic = u16(opt)
const isPe32Plus = magic === 0x20b
const nddOff = opt + (isPe32Plus ? 108 : 92)
const numDirs = u32(nddOff)
const dirs = nddOff + 4

// 第 3 个数据目录 = 资源目录
if (numDirs < 3) throw new Error('没有资源目录')
const resRva = u32(dirs + 2 * 8)
const resSize = u32(dirs + 2 * 8 + 4)

// 节表
const secOff = opt + sizeOfOptional
const sections = []
for (let i = 0; i < numSections; i += 1) {
  const s = secOff + i * 40
  sections.push({
    name: buf.toString('ascii', s, s + 8).replace(/\0.*/, ''),
    virtualAddress: u32(s + 12),
    virtualSize: u32(s + 8),
    rawPtr: u32(s + 20),
    rawSize: u32(s + 16),
  })
}

function rvaToOffset(rva) {
  for (const sec of sections) {
    if (rva >= sec.virtualAddress && rva < sec.virtualAddress + Math.max(sec.virtualSize, sec.rawSize)) {
      return sec.rawPtr + (rva - sec.virtualAddress)
    }
  }
  throw new Error(`RVA ${rva.toString(16)} 不在任何节内`)
}

const resBase = rvaToOffset(resRva)

function readDir(off) {
  const named = u16(off + 12)
  const ids = u16(off + 14)
  const entries = []
  for (let i = 0; i < named + ids; i += 1) {
    const e = off + 16 + i * 8
    const name = u32(e)
    const child = u32(e + 4)
    entries.push({ name, isDir: (child & 0x80000000) !== 0, value: child & 0x7fffffff })
  }
  return entries
}

function childDirOff(entry) {
  return resBase + entry.value
}

function readDataEntry(off) {
  return { rva: u32(off), size: u32(off + 4), codePage: u32(off + 8) }
}

// 顶层 type；找 RT_GROUP_ICON(14)
const rootEntries = readDir(resBase)
const groupType = rootEntries.find((e) => !e.isDir && false) ?? null
const typeGroup = rootEntries.find((e) => e.name === 14 && e.isDir)
if (!typeGroup) throw new Error('没有 RT_GROUP_ICON')

// 第二层 name；第三层 language
const groupNameEntries = readDir(childDirOff(typeGroup))
const groupLangEntries = readDir(childDirOff(groupNameEntries[0]))
const groupData = readDataEntry(resBase + groupLangEntries[0].value)

const gOff = rvaToOffset(groupData.rva)
const count = u16(gOff + 4)
const icons = []
for (let i = 0; i < count; i += 1) {
  const e = gOff + 6 + i * 14
  icons.push({
    width: buf.readUInt8(e),
    height: buf.readUInt8(e),
    planes: u16(e + 4),
    bitCount: u16(e + 6),
    bytesInRes: u32(e + 8),
    id: u16(e + 12),
  })
}

// RT_ICON(3)
const typeIcon = rootEntries.find((e) => e.name === 3 && e.isDir)
if (!typeIcon) throw new Error('没有 RT_ICON')
const iconNameEntries = readDir(childDirOff(typeIcon))

// 优先 256（width 存成 0）；否则取 bytesInRes 最大
icons.sort((a, b) => b.bytesInRes - a.bytesInRes)
const best = icons.find((i) => i.width === 0) ?? icons[0]
const iconNameEntry = iconNameEntries.find((e) => e.name === best.id)
if (!iconNameEntry) throw new Error(`找不到图标 id ${best.id}`)
const iconLangEntries = readDir(childDirOff(iconNameEntry))
const iconData = readDataEntry(resBase + iconLangEntries[0].value)

const dataOff = rvaToOffset(iconData.rva)
const bytes = buf.subarray(dataOff, dataOff + iconData.size)

console.log('icons:', icons.map((i) => `${i.width}x${i.height} ${i.bytesInRes}B id=${i.id}`).join('  '))
console.log('best:', `${best.width}x${best.height}`, 'bytesInRes', best.bytesInRes, 'actual', iconData.size)

const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50
const out = `${outDir}/ref-icon.${isPng ? 'png' : 'dib'}`
fs.writeFileSync(out, bytes)
console.log('saved:', out, isPng ? '(PNG)' : '(DIB，需转换)')

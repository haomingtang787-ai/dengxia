// 把 exe 提取出的 32bpp DIB 图标解码成 PNG（BGRA → RGBA）。
import { createCanvas } from '@napi-rs/canvas'
import fs from 'node:fs'

const dib = fs.readFileSync(process.argv[2])
const out = process.argv[3]

const u32 = (o) => dib.readUInt32LE(o)
const u16 = (o) => dib.readUInt16LE(o)

const headerSize = u32(0)
const width = u32(4)
const fullHeight = u32(8) // 2 × 实际高度（含 AND mask）
const bitCount = u16(14)
const compression = u32(16)

const height = Math.floor(fullHeight / 2)
console.log('DIB:', headerSize, 'bitCount', bitCount, 'compression', compression, `${width}x${height}`)

let pixelOffset = headerSize
if (bitCount <= 8) pixelOffset += (1 << bitCount) * 4 // 调色板

const canvas = createCanvas(width, height)
const ctx = canvas.getContext('2d')
const img = ctx.createImageData(width, height)

// 图标 DIB 是自下而上存储，每行 BGRA
for (let row = 0; row < height; row += 1) {
  const srcRow = height - 1 - row
  for (let x = 0; x < width; x += 1) {
    const s = pixelOffset + srcRow * width * 4 + x * 4
    const b = dib[s]
    const g = dib[s + 1]
    const r = dib[s + 2]
    const a = dib[s + 3]
    const d = (row * width + x) * 4
    img.data[d] = r
    img.data[d + 1] = g
    img.data[d + 2] = b
    img.data[d + 3] = a
  }
}

ctx.putImageData(img, 0, 0)
fs.writeFileSync(out, canvas.toBuffer('image/png'))
console.log('saved', out)

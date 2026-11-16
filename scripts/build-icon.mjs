// 生成「灯下」应用图标：build/icon.png（1024）、build/icon.ico（256）、resources/icon.png（窗口图标）。
// 纯本地绘制，不依赖外部图片；改配色/形状后重跑 `node scripts/build-icon.mjs` 即可。
import { createCanvas } from '@napi-rs/canvas'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function drawIcon(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const s = size / 1024

  // 背景：深青绿渐变圆角方块（呼应应用主色 #173e3a / 强调 #1f9d80）
  const radius = 224 * s
  const round = (x, y, w, h, r) => {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }
  const bg = ctx.createLinearGradient(0, 0, 0, size)
  bg.addColorStop(0, '#1d4a42')
  bg.addColorStop(1, '#0a211d')
  round(0, 0, size, size, radius)
  ctx.fillStyle = bg
  ctx.fill()

  // 光晕（暖色，在火苗周围）
  const glow = ctx.createRadialGradient(512 * s, 430 * s, 20 * s, 512 * s, 430 * s, 260 * s)
  glow.addColorStop(0, 'rgba(255, 210, 128, 0.32)')
  glow.addColorStop(1, 'rgba(255, 210, 128, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  // 油灯剪影（借鉴用户提供图标的「油灯」造型：火苗 + 灯托 + 灯身 + 底座）
  const lamp = () => {
    // 底座（胶囊）
    const pill = (x, y, w, h, r) => {
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y, x + w, y + h, r)
      ctx.arcTo(x + w, y + h, x, y + h, r)
      ctx.arcTo(x, y + h, x, y, r)
      ctx.arcTo(x, y, x + w, y, r)
      ctx.closePath()
      ctx.fill()
    }
    ctx.fillStyle = '#efe6d2'
    pill(444 * s, 740 * s, 136 * s, 52 * s, 26 * s)

    // 灯身（倒置碗形：底部窄、腹部鼓、收口到灯托）
    ctx.beginPath()
    ctx.moveTo(452 * s, 742 * s)
    ctx.bezierCurveTo(452 * s, 700 * s, 392 * s, 640 * s, 404 * s, 566 * s)
    ctx.bezierCurveTo(412 * s, 514 * s, 470 * s, 500 * s, 512 * s, 500 * s)
    ctx.bezierCurveTo(554 * s, 500 * s, 612 * s, 514 * s, 620 * s, 566 * s)
    ctx.bezierCurveTo(632 * s, 640 * s, 572 * s, 700 * s, 572 * s, 742 * s)
    ctx.closePath()
    ctx.fill()

    // 灯托（两端上翘的浅盘）
    ctx.beginPath()
    ctx.moveTo(348 * s, 500 * s)
    ctx.quadraticCurveTo(348 * s, 462 * s, 400 * s, 462 * s)
    ctx.lineTo(624 * s, 462 * s)
    ctx.quadraticCurveTo(676 * s, 462 * s, 676 * s, 500 * s)
    ctx.lineTo(654 * s, 500 * s)
    ctx.quadraticCurveTo(512 * s, 486 * s, 370 * s, 500 * s)
    ctx.closePath()
    ctx.fill()
  }
  lamp()

  // 火苗（暖黄泪滴）
  const flame = ctx.createLinearGradient(512 * s, 300 * s, 512 * s, 480 * s)
  flame.addColorStop(0, '#ffd27a')
  flame.addColorStop(1, '#ff9d3c')
  ctx.fillStyle = flame
  ctx.beginPath()
  ctx.moveTo(512 * s, 282 * s)
  ctx.bezierCurveTo(548 * s, 372 * s, 546 * s, 442 * s, 512 * s, 462 * s)
  ctx.bezierCurveTo(478 * s, 442 * s, 476 * s, 372 * s, 512 * s, 282 * s)
  ctx.closePath()
  ctx.fill()

  return canvas
}

function pngBuffer(canvas) {
  return canvas.toBuffer('image/png')
}

function pngFromCanvas(canvas, size) {
  const out = createCanvas(size, size)
  const c = out.getContext('2d')
  c.drawImage(canvas, 0, 0, size, size)
  return out.toBuffer('image/png')
}

// PNG 塞进 ICO 容器（Vista+ 支持 256px PNG 压缩图标）
function buildIco(png) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry.writeUInt8(0, 0) // 0 表示 256
  entry.writeUInt8(0, 1)
  entry.writeUInt8(0, 2)
  entry.writeUInt8(0, 3)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(6 + 16, 12)
  return Buffer.concat([header, entry, png])
}

const icon = drawIcon(1024)
const png1024 = pngBuffer(icon)
const png256 = pngFromCanvas(icon, 256)
const ico = buildIco(png256)

fs.mkdirSync(path.join(root, 'build'), { recursive: true })
fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
fs.writeFileSync(path.join(root, 'build', 'icon.png'), png1024)
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico)
fs.writeFileSync(path.join(root, 'resources', 'icon.png'), pngFromCanvas(icon, 256))

console.log('icon written:', {
  png: `${png1024.length} bytes (1024)`,
  ico: `${ico.length} bytes (256)`,
  windowPng: `${pngFromCanvas(icon, 256).length} bytes (256)`,
})

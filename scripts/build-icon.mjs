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

  // 光晕（暖色，落在一本摊开的书上）
  const glow = ctx.createRadialGradient(470 * s, 760 * s, 40 * s, 470 * s, 760 * s, 400 * s)
  glow.addColorStop(0, 'rgba(255, 210, 128, 0.30)')
  glow.addColorStop(1, 'rgba(255, 210, 128, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  // 光锥：从灯泡向左下洒到书页（柔和渐变）
  const cone = (alpha) => {
    ctx.beginPath()
    ctx.moveTo(720 * s, 280 * s)
    ctx.quadraticCurveTo(560 * s, 640 * s, 300 * s, 820 * s)
    ctx.lineTo(640 * s, 860 * s)
    ctx.quadraticCurveTo(660 * s, 620 * s, 790 * s, 300 * s)
    ctx.closePath()
    ctx.fillStyle = `rgba(255, 210, 128, ${alpha})`
    ctx.fill()
  }
  cone(0.10)
  cone(0.15)

  // 摇臂：从右上角墙面伸出的两段灯臂
  ctx.strokeStyle = '#e9f2ee'
  ctx.lineWidth = 30 * s
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(900 * s, 120 * s)
  ctx.lineTo(820 * s, 220 * s)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(820 * s, 220 * s)
  ctx.lineTo(720 * s, 300 * s)
  ctx.stroke()
  // 墙面安装点
  ctx.fillStyle = '#e9f2ee'
  ctx.beginPath()
  ctx.arc(900 * s, 120 * s, 26 * s, 0, Math.PI * 2)
  ctx.fill()

  // 灯头（灯罩，灯泡朝左下）
  ctx.beginPath()
  ctx.moveTo(660 * s, 200 * s)
  ctx.lineTo(824 * s, 250 * s)
  ctx.lineTo(772 * s, 340 * s)
  ctx.lineTo(612 * s, 288 * s)
  ctx.closePath()
  ctx.fillStyle = '#e9f2ee'
  ctx.fill()

  // 灯泡
  const bulb = ctx.createRadialGradient(716 * s, 274 * s, 6 * s, 716 * s, 274 * s, 40 * s)
  bulb.addColorStop(0, '#fff3d6')
  bulb.addColorStop(1, '#ffb84d')
  ctx.fillStyle = bulb
  ctx.beginPath()
  ctx.arc(716 * s, 274 * s, 34 * s, 0, Math.PI * 2)
  ctx.fill()

  // 摊开的书（左下，稍小）
  const page = (x1, y1, x2, y2, x3, y3, x4, y4, fill) => {
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.lineTo(x3, y3)
    ctx.lineTo(x4, y4)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
  }
  page(440 * s, 820 * s, 250 * s, 872 * s, 250 * s, 736 * s, 440 * s, 782 * s, '#f7f1e3')
  page(440 * s, 820 * s, 640 * s, 872 * s, 640 * s, 736 * s, 440 * s, 782 * s, '#efe6d2')
  ctx.strokeStyle = '#d9c9a8'
  ctx.lineWidth = 6 * s
  ctx.beginPath()
  ctx.moveTo(440 * s, 782 * s)
  ctx.lineTo(440 * s, 820 * s)
  ctx.stroke()

  // 书页上的文字横线
  ctx.strokeStyle = 'rgba(120, 100, 70, 0.35)'
  ctx.lineWidth = 7 * s
  ctx.lineCap = 'round'
  for (let i = 0; i < 3; i += 1) {
    const y = (752 + i * 22) * s
    ctx.beginPath()
    ctx.moveTo(300 * s, y)
    ctx.lineTo(396 * s, y)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(486 * s, y)
    ctx.lineTo(584 * s, y)
    ctx.stroke()
  }

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

import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DocumentService, type DeskEvents, type NativeDialogs } from '../documents/service'
import { AiService } from '../ai/service'
import { BudgetService } from '../ai/budget'
import { ImageService } from '../images/service'
import { ForkWorker } from '../providers/forkWorker'
import { LocalOfficeGateway } from '../providers/officeGateway'
import { SettingsStore } from '../providers/settings'
import { probeLibreOffice } from '../providers/libreoffice'
import { clearOfficeEvidence, recordSandboxEvidence } from '../providers/isolation'
import { runSandboxSelfTest, sandboxHelperPath } from '../providers/sandbox'
import { IpcChannel } from '../shared/ipc'
import { AppDatabase } from '../storage/database'
import { migrate } from '../storage/migrate'
import { Store } from '../storage/store'
import { StudyStore } from '../storage/studyStore'
import { TeachingService } from '../teaching/service'
import { TeacherService } from '../teaching/teacherService'
import { DEFAULT_HABITS } from '../teaching/habits'
import { StudyService } from '../study/service'
import { AppInfoService } from '../app/info'
import { registerIpc } from './ipc'
import { handleAppResource } from './protocol'

const here = import.meta.dirname

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-resource',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    },
  },
])

let service: DocumentService | null = null

function workerEntry(): string {
  const candidates = [
    path.join(app.getAppPath(), 'out', 'worker', 'documentWorker.mjs'),
    path.join(here, '..', 'worker', 'documentWorker.mjs'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('找不到文档工作进程。请先运行 npm run build:worker。')
}

function createWindow(library: DocumentService): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 640,
    show: false,
    title: '灯下',
    icon: path.join(here, '../resources/icon.png'),
    backgroundColor: '#F7F8FA',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => library.dropWindow(String(win.id)))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  const smokeView = process.env.DESK_SMOKE_VIEW
  const query = smokeView === 'class' || smokeView === 'review' ? { view: smokeView } : undefined
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL
    void win.loadURL(query ? `${base}?view=${smokeView}` : base)
  } else {
    void win.loadFile(path.join(here, '../renderer/index.html'), query ? { query } : undefined)
  }
  scheduleSmoke(win, library)
  return win
}

// Test instrument, not a user feature: DESK_SMOKE_IMPORT lets an automated
// install check import one real file and capture the resulting preview.
// It still goes through pick() -> one-time handle -> import(), so the renderer
// never gains a path-based import. Unset in normal runs.
function scheduleSmoke(win: BrowserWindow, library: DocumentService): void {
  if (!process.env.DESK_SMOKE_SHOT) return
  // 验收时可以指定窗口尺寸，用来核对宽屏三栏与窄屏抽屉两种布局。
  if (process.env.DESK_SMOKE_SIZE) {
    const [width, height] = process.env.DESK_SMOKE_SIZE.split('x').map((value) => Number(value))
    if (width > 0 && height > 0) win.setSize(width, height)
  }
  win.webContents.once('did-finish-load', () => {
    void (async () => {
      const smokeFile = process.env.DESK_SMOKE_IMPORT
      let focused: { documentVersionId: string; pageNumber: number } | null = null
      if (smokeFile) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        const picked = await library.pick(String(win.id))
        if (picked.ok && !picked.data.cancelled && picked.data.files[0]) {
          const imported = await library.import(String(win.id), {
            handle: picked.data.files[0].handle,
            requestId: randomUUID(),
          })
          if (imported.ok) {
            await library.settle()
            const job = library.job({ jobId: imported.data.jobId })
            console.log('[smoke] imported', imported.data.documentVersionId, 'job', job.ok ? job.data.state : 'unknown')
            focused = { documentVersionId: imported.data.documentVersionId, pageNumber: 1 }
          } else {
            console.log('[smoke] import failed', imported.error.code, imported.error.message)
          }
        } else {
          console.log('[smoke] pick failed', picked.ok ? 'cancelled' : picked.error.code)
        }
      }
      if (focused) win.webContents.send(IpcChannel.previewFocus, focused)
      await new Promise((resolve) => setTimeout(resolve, focused ? 1400 : 800))
      const action = process.env.DESK_SMOKE_ACTION
      if (action) await runSmokeAction(win, action)
      const image = await win.webContents.capturePage()
      fs.mkdirSync(path.dirname(process.env.DESK_SMOKE_SHOT as string), { recursive: true })
      fs.writeFileSync(process.env.DESK_SMOKE_SHOT as string, image.toPNG())
      app.quit()
    })()
  })
}

// More test instrumentation for the acceptance screenshot: drive the real
// buttons in the real window so the IPC, the model call and SQLite all run.
async function runSmokeAction(win: BrowserWindow, action: string): Promise<void> {
  const click = async (label: string) =>
    win.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`,
    )
  const clickContains = async (text: string) =>
    win.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true })()`,
    )
  const waitFor = async (text: string, tries: number) => {
    for (let i = 0; i < tries; i++) {
      const found = await win.webContents.executeJavaScript(
        `Boolean([...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(text)})))`,
      )
      if (found) return true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }
  if (action === 'image-auto') {
    await new Promise((resolve) => setTimeout(resolve, 500))
    let answer = ''
    let sources = 0
    let readings = 0
    for (let i = 0; i < 240; i++) {
      answer = await win.webContents.executeJavaScript(
        `document.querySelector('.reading.research p')?.textContent ?? ''`,
      )
      sources = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.reading.research .sources li').length`,
      )
      readings = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.readings .reading').length`,
      )
      if (answer) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    console.log('[smoke] 自动读懂 阅读卡', readings, '查证字数', answer.length, '来源', sources, '内容', answer.slice(0, 90).replace(/\n/g, ' / '))
    const readingTitles = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('.readings .reading h4')].map((x) => x.textContent ?? '')`,
    )
    console.log('[smoke] 阅读卡标题', JSON.stringify(readingTitles))
    for (let i = 0; i < 60; i++) {
      const busy = await win.webContents.executeJavaScript(`document.body.innerText.includes('正在让 AI 读懂')`)
      if (!busy) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const topShot = process.env.DESK_SMOKE_SHOT_TOP
    if (topShot) {
      const topImage = await win.webContents.capturePage()
      fs.mkdirSync(path.dirname(topShot), { recursive: true })
      fs.writeFileSync(topShot, topImage.toPNG())
    }
    if (answer) {
      await win.webContents.executeJavaScript(
        `document.querySelector('.reading.research')?.scrollIntoView({ block: 'start' })`,
      )
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
    return
  }
  if (action === 'image-ocr' || action === 'image-vision' || action === 'image-research') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    const label = action === 'image-ocr' ? '识别这一页文字' : action === 'image-vision' ? '让模型看懂这一页' : '联网查证这一页'
    console.log('[smoke] 点击', label, await click(label))
    if (action === 'image-research') {
      let answer = ''
      let sources = 0
      for (let i = 0; i < 240; i++) {
        answer = await win.webContents.executeJavaScript(
          `document.querySelector('.reading.research p')?.textContent ?? ''`,
        )
        sources = await win.webContents.executeJavaScript(
          `document.querySelectorAll('.reading.research .sources li').length`,
        )
        if (answer) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      console.log('[smoke] 联网查证 字数', answer.length, '来源', sources, '内容', answer.slice(0, 90).replace(/\n/g, ' / '))
      if (answer) {
        await win.webContents.executeJavaScript(
          `document.querySelector('.reading.research')?.scrollIntoView({ block: 'start' })`,
        )
        await new Promise((resolve) => setTimeout(resolve, 700))
      }
      return
    }
    let text = ''
    for (let i = 0; i < 160; i++) {
      text = await win.webContents.executeJavaScript(
        `document.querySelector('.readings .reading p')?.textContent ?? ''`,
      )
      if (text) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    console.log('[smoke] 图片阅读', action, '字数', text.length, '内容', text.slice(0, 90).replace(/\n/g, ' / '))
    return
  }
  if (action === 'course-materials') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开老师页', await click('老师'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开课程资料', await click('课程资料'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    const materials = await win.webContents.executeJavaScript(
      `(() => {
        const drawer = document.querySelector('.course-materials');
        if (!drawer) return '';
        drawer.scrollTop = 0;
        return drawer.innerText;
      })()`,
    )
    console.log('[smoke] 课程资料', materials.slice(0, 400).replace(/\n/g, ' / '))
    await new Promise((resolve) => setTimeout(resolve, 500))
    return
  }
  if (action === 'usage-audit') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开老师页', await click('老师'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开课程资料', await click('课程资料'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    const before = await win.webContents.executeJavaScript(
      `(() => {
        const card = document.querySelector('.study-usage');
        if (!card) return '';
        card.scrollIntoView({ block: 'center' });
        return card.innerText;
      })()`,
    )
    console.log('[smoke] 用量卡', before.replace(/\n/g, ' / '))
    console.log('[smoke] 点击核对余额', await click('核对官方余额'))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const after = await win.webContents.executeJavaScript(
      `(() => {
        const card = document.querySelector('.study-usage');
        return {
          card: card?.innerText ?? '',
          audit: document.querySelector('.study-usage-audit')?.innerText ?? '',
        };
      })()`,
    )
    console.log('[smoke] 核对后', JSON.stringify(after).slice(0, 1200))
    // 核对结果接在用量卡下面，重新滚到卡上，截图才能同时看到真实回报/估算与官方余额。
    await win.webContents.executeJavaScript(
      `(() => { const card = document.querySelector('.study-usage'); card?.scrollIntoView({ block: 'end' }); return true })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 600))
    return
  }
  if (action === 'teacher-note-edit') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await click('老师')
    await new Promise((resolve) => setTimeout(resolve, 500))
    await click('课程资料')
    await new Promise((resolve) => setTimeout(resolve, 500))
    console.log('[smoke] 打开手记编辑', await click('编辑'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    const editor = await win.webContents.executeJavaScript(
      `(() => { const e = document.querySelector('.teacher-note-editor'); return e ? e.innerText : '' })()`,
    )
    console.log('[smoke] 手记编辑器', editor.slice(0, 200).replace(/\n/g, ' / '))
    return
  }
  if (action === 'teacher-note-save') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await click('老师')
    await new Promise((resolve) => setTimeout(resolve, 500))
    await click('课程资料')
    await new Promise((resolve) => setTimeout(resolve, 500))
    await click('编辑')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const filled = await win.webContents.executeJavaScript(
      `(() => {
        const area = document.querySelector('.teacher-note-editor textarea');
        if (!area) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(area, '这堂课把内积和正交讲通了；Phase 2 已通过界面保存手记。');
        area.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    )
    console.log('[smoke] 填写手记总览', filled)
    console.log('[smoke] 保存手记', await click('保存'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    const saved = await win.webContents.executeJavaScript(
      `(() => { const n = document.querySelector('.study-teacher-note'); return n ? n.innerText : '' })()`,
    )
    console.log('[smoke] 保存后的手记', saved.slice(0, 220).replace(/\n/g, ' / '))
    return
  }
  if (action === 'teacher-note') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await click('老师')
    await new Promise((resolve) => setTimeout(resolve, 500))
    await click('课程资料')
    await new Promise((resolve) => setTimeout(resolve, 700))
    const note = await win.webContents.executeJavaScript(
      `(() => { const n = document.querySelector('.study-teacher-note'); if (!n) return ''; n.scrollIntoView({ block: 'center' }); return n.innerText })()`,
    )
    console.log('[smoke] 老师手记', note.slice(0, 240).replace(/\n/g, ' / '))
    await new Promise((resolve) => setTimeout(resolve, 700))
    return
  }
  if (action === 'teacher-page') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开老师页', await click('老师'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    return
  }
  if (action === 'workspace-top') {
    await new Promise((resolve) => setTimeout(resolve, 1600))
    return
  }
  if (action === 'workspace-card') {
    await new Promise((resolve) => setTimeout(resolve, 1600))
    await win.webContents.executeJavaScript(
      `(() => { const cite = document.querySelector('.ws-cite'); cite?.scrollIntoView({ block: 'center' }); return true })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    return
  }
  if (action === 'workspace-cites') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开老师页', await click('老师'))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const state = await win.webContents.executeJavaScript(
      `(() => {
        const cite = document.querySelector('.ws-cite');
        cite?.scrollIntoView({ block: 'center' });
        return {
          courses: document.querySelectorAll('.ws-course').length,
          docs: document.querySelectorAll('.ws-doc').length,
          units: document.querySelectorAll('.ws-unit').length,
          lectures: document.querySelectorAll('.ws-lecture').length,
          messages: document.querySelectorAll('.ws-message').length,
          cites: document.querySelectorAll('.ws-cite').length,
          images: document.querySelectorAll('.ws-cite-thumb img').length,
          boxes: document.querySelectorAll('.ws-cite-box').length,
          chips: document.querySelectorAll('.ws-cite-chips button').length,
          contextSections: document.querySelectorAll('.ws-context-section').length,
          citeText: cite?.innerText?.slice(0, 240) ?? '',
        };
      })()`,
    )
    console.log('[smoke] workspace', JSON.stringify(state))
    await new Promise((resolve) => setTimeout(resolve, 500))
    return
  }
  if (action === 'workspace-right') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await click('老师')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    console.log('[smoke] 打开这一讲', await click('这一讲'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const state = await win.webContents.executeJavaScript(
      `(() => {
        const rail = document.querySelector('.ws-context');
        const r = rail?.getBoundingClientRect();
        return {
          open: rail?.classList.contains('open') ?? false,
          display: rail ? getComputedStyle(rail).display : '',
          width: r ? Math.round(r.width) : 0,
          height: r ? Math.round(r.height) : 0,
          sections: rail?.innerText?.slice(0, 260) ?? '',
        };
      })()`,
    )
    console.log('[smoke] right', JSON.stringify(state))
    return
  }
  if (action === 'workspace-peek') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await click('老师')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.ws-cite-label button'); b?.click(); return Boolean(b); })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 700))
    const state = await win.webContents.executeJavaScript(
      `(() => ({
        open: Boolean(document.querySelector('.ws-peek')),
        image: Boolean(document.querySelector('.ws-peek-image img')),
        box: Boolean(document.querySelector('.ws-peek .ws-cite-box')),
      }))()`,
    )
    console.log('[smoke] peek', JSON.stringify(state))
    return
  }
  if (action === 'workspace-materials') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await click('老师')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    console.log('[smoke] 打开整份课件', await click('整份课件'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    const state = await win.webContents.executeJavaScript(
      `(() => ({
        open: Boolean(document.querySelector('.course-materials')),
        tools: Boolean(document.querySelector('.study-tools')),
        cards: document.querySelectorAll('.study-tool-card').length,
        usage: document.querySelector('.study-usage')?.innerText?.slice(0, 160) ?? '',
      }))()`,
    )
    console.log('[smoke] materials', JSON.stringify(state))
    return
  }
  if (action === 'workspace-course') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await click('老师')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const before = await win.webContents.executeJavaScript(`document.querySelectorAll('.ws-course').length`)
    const opened = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.ws-new-course'); b?.click(); return Boolean(b); })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    const typed = await win.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('.ws-course-dialog input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '线性代数（冒烟新建）');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    console.log('[smoke] 建课', await click('建这门课'))
    await new Promise((resolve) => setTimeout(resolve, 900))
    const after = await win.webContents.executeJavaScript(
      `(() => ({
        courses: document.querySelectorAll('.ws-course').length,
        dialog: Boolean(document.querySelector('.ws-course-dialog')),
        names: [...document.querySelectorAll('.ws-course-name')].map((x) => x.textContent),
      }))()`,
    )
    console.log('[smoke] course', JSON.stringify({ before, opened, typed, after }))
    return
  }
  if (action === 'workspace-unit') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await click('老师')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const state = await win.webContents.executeJavaScript(
      `(() => {
        const second = document.querySelectorAll('.ws-unit')[1];
        second?.click();
        return {
          before: document.querySelector('.ws-center-head h2')?.innerText ?? '',
          messages: document.querySelectorAll('.ws-message').length,
          clicked: Boolean(second),
        };
      })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    const after = await win.webContents.executeJavaScript(
      `(() => {
        const active = document.querySelector('.ws-unit.active');
        const lecture = document.querySelector('.ws-lecture.active');
        const firstData = document.querySelector('.ws-unit-divider[data-unit="1"]');
        return {
          activeUnit: active?.innerText ?? '',
          messages: document.querySelectorAll('.ws-message').length,
          activeLecture: Boolean(lecture),
          target: Boolean(firstData),
          top: firstData ? Math.round(firstData.getBoundingClientRect().top) : null,
        };
      })()`,
    )
    const collapsed = await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.ws-collapse'); b?.click(); return Boolean(b); })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const left = await win.webContents.executeJavaScript(
      `(() => ({
        classes: document.querySelector('.ws-study')?.className ?? '',
        width: Math.round(document.querySelector('.ws-left')?.getBoundingClientRect().width ?? 0),
        collapsed: document.querySelector('.ws-left')?.classList.contains('collapsed') ?? false,
      }))()`,
    )
    console.log('[smoke] unit', JSON.stringify({ state, after, collapsed, left }))
    return
  }
  if (action === 'workspace-send') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await click('老师')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const typed = await win.webContents.executeJavaScript(
      `(() => {
        const area = document.querySelector('.ws-composer textarea');
        if (!area) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(area, '请对照第 2 页，说明这个内积式子为什么能用来判断正交，并引用第 2 页原文。');
        area.dispatchEvent(new Event('input', { bubbles: true }));
        area.focus();
        return true;
      })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    console.log('[smoke] 发送问题', await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('.ws-send'); b?.click(); return Boolean(b); })()`,
    ), typed)
    await new Promise((resolve) => setTimeout(resolve, 28000))
    const state = await win.webContents.executeJavaScript(
      `(() => {
        const last = [...document.querySelectorAll('.ws-message.assistant')].at(-1);
        const cites = last?.querySelectorAll('.ws-cite').length ?? 0;
        const images = last?.querySelectorAll('.ws-cite-thumb img').length ?? 0;
        return {
          messages: document.querySelectorAll('.ws-message').length,
          last: last?.innerText?.slice(0, 260) ?? '',
          cites,
          images,
          error: document.querySelector('.banner.bad')?.innerText ?? '',
          busy: document.querySelector('.ws-message.pending') ? true : false,
        };
      })()`,
    )
    console.log('[smoke] send', JSON.stringify(state))
    return
  }
  if (action === 'workspace-course-edit') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await click('老师')
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const found = await win.webContents.executeJavaScript(
      `(() => {
        const course = [...document.querySelectorAll('.ws-course')].find((node) => node.innerText.includes('冒烟'));
        const rename = course?.querySelector('button[title="改名"]');
        rename?.click();
        return Boolean(course && rename);
      })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const typed = await win.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('.ws-course-dialog input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '冒烟改名课程');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 150))
    console.log('[smoke] 保存改名', await click('保存新名字'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    const renamed = await win.webContents.executeJavaScript(
      `(() => [...document.querySelectorAll('.ws-course-name')].map((x) => x.textContent))()`,
    )
    const moved = await win.webContents.executeJavaScript(
      `(() => {
        const course = [...document.querySelectorAll('.ws-course')].find((node) => node.innerText.includes('冒烟改名课程'));
        const up = course?.querySelector('button[title="上移"]');
        up?.click();
        return Boolean(up);
      })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 600))
    const order = await win.webContents.executeJavaScript(
      `(() => [...document.querySelectorAll('.ws-course-name')].map((x) => x.textContent))()`,
    )
    await win.webContents.executeJavaScript(`window.confirm = () => true; true`)
    const deleted = await win.webContents.executeJavaScript(
      `(() => {
        const course = [...document.querySelectorAll('.ws-course')].find((node) => node.innerText.includes('冒烟改名课程'));
        const away = course?.querySelector('button[title="删除课程"]');
        away?.click();
        return Boolean(away);
      })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 900))
    const final = await win.webContents.executeJavaScript(
      `(() => ({
        courses: document.querySelectorAll('.ws-course').length,
        names: [...document.querySelectorAll('.ws-course-name')].map((x) => x.textContent),
      }))()`,
    )
    console.log('[smoke] courseEdit', JSON.stringify({ found, typed, renamed, moved, order, deleted, final }))
    return
  }
  if (action === 'teacher-more') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开老师页', await click('老师'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    console.log('[smoke] 打开更多菜单', await click('更多'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const menu = await win.webContents.executeJavaScript(
      `(() => { const m = document.querySelector('.study-manage-menu'); return m ? m.innerText : '' })()`,
    )
    console.log('[smoke] 更多菜单', menu.replace(/\n/g, ' / '))
    return
  }
  if (action === 'teacher-tools') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开老师页', await click('老师'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    console.log('[smoke] 打开更多菜单', await click('更多'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const menu = await win.webContents.executeJavaScript(
      `(() => { const m = document.querySelector('.study-manage-menu'); return m ? m.innerText : '' })()`,
    )
    console.log('[smoke] 老师工具菜单', menu.replace(/\n/g, ' / '))
    console.log('[smoke] 点击列复习大纲', await click('列复习大纲'))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const state = await win.webContents.executeJavaScript(
      `(() => {
        const panel = document.querySelector('.study-tools');
        const cards = document.querySelectorAll('.study-tool-card');
        return { open: Boolean(document.querySelector('.course-materials')), panel: panel?.innerText?.slice(0, 300) ?? '', cards: cards.length };
      })()`,
    )
    console.log('[smoke] 老师工具后', JSON.stringify(state))
    return
  }
  if (action === 'teacher-search') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开老师页', await click('老师'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    console.log('[smoke] 打开更多菜单', await click('更多'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    console.log('[smoke] 点击找原文', await click('找原文'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    const typed = await win.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('.study-tool-input input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, '正交');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const clicked = await win.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll('.study-tool-input button')].find((x) => x.textContent.includes('找原文')); if (!b) return false; b.click(); return true })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 900))
    const state = await win.webContents.executeJavaScript(
      `(() => { const card = document.querySelector('.study-tool-card'); return { typed: ${JSON.stringify(typed)}, clicked: ${JSON.stringify(clicked)}, card: card?.innerText?.slice(0, 300) ?? '' } })()`,
    )
    console.log('[smoke] 找原文后', JSON.stringify(state))
    return
  }
  if (action === 'teacher-chat') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开老师页', await click('老师'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    console.log('[smoke] 点击问老师', await click('问老师'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    const state = await win.webContents.executeJavaScript(
      `(() => {
        const chat = document.querySelector('.study-chat');
        const area = document.querySelector('.study-composer textarea');
        return {
          open: Boolean(chat?.classList.contains('open')),
          focused: Boolean(area && document.activeElement === area),
        };
      })()`,
    )
    console.log('[smoke] 问老师后', JSON.stringify(state))
    return
  }
  if (action === 'teacher-path') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开老师页', await click('老师'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    console.log('[smoke] 点击路径答一下', await clickContains('答“停一下”'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    const state = await win.webContents.executeJavaScript(
      `(() => {
        const area = document.activeElement;
        return { tag: area?.tagName ?? '', className: area?.className ?? '' };
      })()`,
    )
    console.log('[smoke] 路径答一下后', JSON.stringify(state))
    return
  }
  if (action === 'teacher-save') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await click('老师')
    await new Promise((resolve) => setTimeout(resolve, 500))
    await click('老师档案')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const filled = await win.webContents.executeJavaScript(
      `(() => {
        const input = document.querySelector('.teacher-profile input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, '周老师');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    )
    console.log('[smoke] 填写老师称呼', filled)
    console.log('[smoke] 保存老师档案', await click('保存老师档案'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    return
  }
  if (action === 'teacher-profile') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开老师页', await click('老师'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    console.log('[smoke] 打开老师档案', await click('老师档案'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    return
  }
  if (action === 'study') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开老师页', await click('老师'))
    console.log('[smoke] 上传后零点击：等待自动完整读懂并拆课')
    let units = 0
    let overview = ''
    let progressSeen = ''
    for (let i = 0; i < 2400; i++) {
      units = await win.webContents.executeJavaScript(`document.querySelectorAll('.study-unit').length`)
      overview = await win.webContents.executeJavaScript(`document.querySelector('.study-overview p')?.textContent ?? ''`)
      if (units > 0) break
      const progress = await win.webContents.executeJavaScript(`document.querySelector('.study-progress p')?.textContent ?? ''`)
      if (progress && progress !== progressSeen) {
        progressSeen = progress
        if (i % 20 === 0) console.log('[smoke] 进度', progress.slice(0, 70))
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    console.log('[smoke] 最后进度', progressSeen.slice(0, 90) || '无')
    console.log('[smoke] 课程讲数', units, '总览字数', overview.length, '内容', overview.slice(0, 80).replace(/\n/g, ' / '))
    const checkFilled = await win.webContents.executeJavaScript(
      `(() => {
        const t = document.querySelector('.study-check textarea');
        if (!t) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(t, '我先用自己的话答一遍：这一句在给出判断标准，执行顺序不同，结果就可能不同。');
        t.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    )
    console.log('[smoke] 填写停一下', checkFilled)
    console.log('[smoke] 记下答案', await click('记下我的答案'))
    let checkSaved = ''
    for (let i = 0; i < 80; i++) {
      checkSaved = await win.webContents.executeJavaScript(
        `document.querySelector('.study-check-actions .quiet')?.textContent ?? ''`,
      )
      if (checkSaved) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    console.log('[smoke] 作答已记录', checkSaved || '未出现')
    if (units === 0) return
    const secondShot = process.env.DESK_SMOKE_SHOT_TOP
    if (secondShot) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const topImage = await win.webContents.capturePage()
      fs.mkdirSync(path.dirname(secondShot), { recursive: true })
      fs.writeFileSync(secondShot, topImage.toPNG())
    }
    // 对话默认收起（点标题栏展开），先展开再填追问。
    const openedChat = await win.webContents.executeJavaScript(
      `(() => { const h = document.querySelector('.study-chat-head'); if (!h) return false; h.click(); return true })()`,
    )
    console.log('[smoke] 展开对话', openedChat)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const typed = await win.webContents.executeJavaScript(
      `(() => {
        const t = document.querySelector('.study-composer textarea');
        if (!t) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(t, '老师，这一讲最容易错在哪里？请用一句话说。');
        t.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    )
    console.log('[smoke] 填写追问', typed)
    const drawer = await win.webContents.executeJavaScript(
      `(() => { const c = document.querySelector('.study-chat'); if (!c) return null; const r = c.getBoundingClientRect(); return { open: c.classList.contains('open'), display: getComputedStyle(c).display, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) } })()`,
    )
    console.log('[smoke] 对话区', JSON.stringify(drawer))
    await new Promise((resolve) => setTimeout(resolve, 300))
    console.log('[smoke] 发送追问', await click('发送追问'))
    let messages = 0
    const answer = { value: '' }
    for (let i = 0; i < 180; i++) {
      messages = await win.webContents.executeJavaScript(`document.querySelectorAll('.study-message').length`)
      answer.value = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.study-message.assistant p')[1]?.textContent ?? ''`,
      )
      if (messages >= 3 && answer.value) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    console.log('[smoke] 课堂消息', messages, '老师回复字数', answer.value.length, '内容', answer.value.slice(0, 80).replace(/\n/g, ' / '))
    // 第二轮追问：验证多轮对话真的带上了上一轮，而不是每问一次都从零开始。
    const typedAgain = await win.webContents.executeJavaScript(
      `(() => {
        const t = document.querySelector('.study-composer textarea');
        if (!t) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(t, '顺着你刚才的回答，再举一个课件里能说明它的反例。');
        t.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    const sentAgain = await click('发送追问')
    let secondAnswer = ''
    for (let i = 0; i < 240; i++) {
      messages = await win.webContents.executeJavaScript(`document.querySelectorAll('.study-message').length`)
      secondAnswer = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.study-message.assistant p')[2]?.textContent ?? ''`,
      )
      if (messages >= 5 && secondAnswer) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    console.log('[smoke] 二轮追问', typedAgain && sentAgain, '消息', messages, '回复字数', secondAnswer.length, '内容', secondAnswer.slice(0, 80).replace(/\n/g, ' / '))
    console.log('[smoke] 生成总结', await click('生成学习分析总结'))
    let summary = 0
    for (let i = 0; i < 180; i++) {
      summary = await win.webContents.executeJavaScript(`document.querySelectorAll('.study-summary-group').length`)
      if (summary > 0) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    console.log('[smoke] 总结分组', summary)
    const usageText = await win.webContents.executeJavaScript(
      `document.querySelector('.study-usage')?.innerText.replace(/\\n/g, ' / ') ?? '未出现'`,
    )
    console.log('[smoke] 用量卡片', usageText)
    const scrollState = await win.webContents.executeJavaScript(
      `(() => {
        const sheet = document.querySelector('.study-scroll');
        const msgs = document.querySelector('.study-messages');
        const outline = document.querySelector('.study.has-course .study-outline');
        const room = document.querySelector('.study-room');
        const study = document.querySelector('.study.has-course');
        const body = document.querySelector('.stage .body');
        const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
        return {
          sheetScrollable: sheet ? sheet.scrollHeight > sheet.clientHeight : null,
          msgsScrollable: msgs ? msgs.scrollHeight > msgs.clientHeight : null,
          outlineOverflow: outline ? getComputedStyle(outline).overflowY : '',
          bodyScrolls: document.body.scrollHeight > window.innerHeight,
          rects: { body: rect(body), study: rect(study), room: rect(room), outline: rect(outline), main: rect(document.querySelector('.study-main')), sheet: rect(sheet), chat: rect(document.querySelector('.study-chat')), composer: rect(document.querySelector('.study-composer')) },
          mainScroll: (() => { const m = document.querySelector('.study-main'); return m ? [m.scrollTop, m.scrollHeight, m.clientHeight] : null })(),
          composerStyle: (() => { const c = document.querySelector('.study-composer'); return c ? { position: getComputedStyle(c).position, bottom: getComputedStyle(c).bottom } : null })(),
          studyStyle: study ? { flex: getComputedStyle(study).flex, height: getComputedStyle(study).height, overflow: getComputedStyle(study).overflow } : null,
          bodyStyle: body ? { display: getComputedStyle(body).display, height: getComputedStyle(body).height } : null,
          roomRows: room ? getComputedStyle(room).gridTemplateRows : '',
        }
      })()`,
    )
    console.log('[smoke] 滚动结构', JSON.stringify(scrollState))
    // 验证侧边栏可收放：大纲与总览都能收起/展开。
    const collapseProbe = await win.webContents.executeJavaScript(
      `(async () => {
        const room = document.querySelector('.study-room');
        const snap = () => room ? { cls: room.className, cols: getComputedStyle(room).gridTemplateColumns } : null;
        const wait = () => new Promise((r) => setTimeout(r, 150));
        const before = snap();
        document.querySelector('.study-outline .icon-btn')?.click();
        await wait();
        const afterOutline = snap();
        document.querySelector('.study-side .icon-btn')?.click();
        await wait();
        const afterSide = snap();
        const expandCount = document.querySelectorAll('.study-expand').length;
        document.querySelector('.study-outline .study-expand')?.click();
        document.querySelector('.study-side .study-expand')?.click();
        await wait();
        return { before, afterOutline, afterSide, expandCount, restored: snap() };
      })()`,
    )
    console.log('[smoke] 侧栏收放', JSON.stringify(collapseProbe))
    // 左侧文稿栏也可收起
    const libraryProbe = await win.webContents.executeJavaScript(
      `(async () => {
        const wait = () => new Promise((r) => setTimeout(r, 150));
        const shell = document.querySelector('.shell');
        const snap = () => shell ? { cls: shell.className, cols: getComputedStyle(shell).gridTemplateColumns } : null;
        const before = snap();
        document.querySelector('.library .icon-btn')?.click();
        await wait();
        const after = snap();
        document.querySelector('.library .panel-expand')?.click();
        await wait();
        return { before, after, restored: snap() };
      })()`,
    )
    console.log('[smoke] 文稿栏收放', JSON.stringify(libraryProbe))
    await win.webContents.executeJavaScript(
      `document.querySelector('.study-room')?.scrollIntoView({ block: 'start' })`,
    )
    await new Promise((resolve) => setTimeout(resolve, 700))
    return
  }
  if (action === 'settings') {
    await new Promise((resolve) => setTimeout(resolve, 500))
    console.log('[smoke] 打开设置', await clickContains('模型'))
    await new Promise((resolve) => setTimeout(resolve, 900))
    const state = await win.webContents.executeJavaScript(
      `(() => { const m = document.querySelector('.modal'); return { open: Boolean(m), text: m?.textContent?.slice(0, 80) ?? '', backup: Boolean(m?.textContent?.includes('备份')), budget: Boolean(m?.textContent?.includes('预算')) } })()`,
    )
    console.log('[smoke] 设置状态', JSON.stringify(state))
    return
  }
  if (action === 'model-open') {
    await new Promise((resolve) => setTimeout(resolve, 500))
    console.log('[smoke] 打开模型弹窗', await clickContains('模型'))
    await new Promise((resolve) => setTimeout(resolve, 900))
    const state = await win.webContents.executeJavaScript(
      `(() => { const m = document.querySelector('.modal'); return { open: Boolean(m), text: m?.textContent?.slice(0, 40) ?? '', inputs: [...document.querySelectorAll('.modal input')].map((x) => x.value) } })()`,
    )
    console.log('[smoke] 弹窗状态', JSON.stringify(state))
    return
  }
  if (action === 'model-list') {
    await new Promise((resolve) => setTimeout(resolve, 700))
    console.log('[smoke] 打开模型弹窗', await clickContains('模型'))
    await new Promise((resolve) => setTimeout(resolve, 500))
    console.log('[smoke] 拉取模型', await click('拉取模型'))
    let options: string[] = []
    for (let i = 0; i < 40; i++) {
      options = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll('.modal select option')].map((o) => o.value)`,
      )
      if (options.length > 0) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    console.log('[smoke] 模型数量', options.length, '列表', options.join(','))
    const picked = await win.webContents.executeJavaScript(
      `(() => { const s = document.querySelector('.modal select'); if (!s) return ''; const target = [...s.options].find((o) => o.value === 'deepseek-reasoner') ?? s.options[1] ?? s.options[0]; if (!target) return ''; s.value = target.value; s.dispatchEvent(new Event('change', { bubbles: true })); return target.value })()`,
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    const modelInput = await win.webContents.executeJavaScript(
      `document.querySelector('.modal input[placeholder="deepseek-flash"]')?.value ?? ''`,
    )
    const state = await win.webContents.executeJavaScript(
      `(() => { const m = document.querySelector('.modal'); return { open: Boolean(m), warning: m?.querySelector('.warning')?.textContent ?? '', models: m?.querySelectorAll('select option').length ?? 0 } })()`,
    )
    console.log('[smoke] 选中', picked, '模型输入框', modelInput, '状态', JSON.stringify(state))
    return
  }
  if (action !== 'model-lecture') return
  await new Promise((resolve) => setTimeout(resolve, 900))
  console.log('[smoke] 模型拆讲', await click('模型拆讲'))
  console.log('[smoke] 等讲解', await waitFor('听懂了', 80))
  console.log('[smoke] 听懂一讲', await click('听懂了，下一讲'))
  await new Promise((resolve) => setTimeout(resolve, 700))
  const quizClicked = await win.webContents.executeJavaScript(
    `(() => { const q = document.querySelector('.quiz button'); if (!q) return false; q.click(); return true })()`,
  )
  await new Promise((resolve) => setTimeout(resolve, 600))
  const quizText = await win.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('.quiz p')).map((x) => x.textContent).find((t) => t && (t.includes('答对') || t.includes('答错'))) ?? ''`,
  )
  console.log('[smoke] 做题', quizClicked, quizText)
  console.log('[smoke] 生成笔记', await click('生成课后笔记'))
  await new Promise((resolve) => setTimeout(resolve, 900))
  const noteLength = await win.webContents.executeJavaScript(
    `document.querySelector('.note-text')?.textContent?.length ?? 0`,
  )
  const knownChip = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.chip')].map((x) => x.textContent).find((t) => t.includes('已听懂')) ?? ''`,
  )
  console.log('[smoke] 笔记字数', noteLength, '进度chip', knownChip)
}

// Two pieces of evidence, in order, and both are thrown away first: a sandbox
// self-test that has to actually deny an escape read and a network connection,
// then one real DOCX through LibreOffice inside the same container. Until both
// land, Office page conversion stays closed. Nothing here reads settings,
// IPC or the environment to decide it.
async function verifyOfficeIsolation(settings: SettingsStore): Promise<void> {
  clearOfficeEvidence()
  const roots = app.isPackaged
    ? [process.resourcesPath]
    : [path.join(app.getAppPath(), 'resources'), process.resourcesPath]
  const helper = sandboxHelperPath(roots)
  const evidence = await runSandboxSelfTest(helper ?? '')
  recordSandboxEvidence(evidence)
  if (!evidence.ok) {
    console.log('[office] 沙箱自检未通过：', evidence.reason)
    return
  }
  console.log('[office] 沙箱自检通过：', evidence.containerSid)
  const description = await new LocalOfficeGateway().describe(settings.load())
  if (!description.fileFound || !description.path) {
    console.log('[office] 没有可探测的 LibreOffice，转换证据留空。')
    return
  }
  const probe = await probeLibreOffice(description.path, helper)
  console.log('[office] 转换证据：', probe.ok ? '已取得' : probe.message)
}

async function boot(): Promise<void> {
  // ⚠️ 用户数据目录：文稿、课程、对话、用量都在这里（Windows 默认 %APPDATA%/灯下/library）。
  // 更新时只替换应用文件，绝不要删除或清空这个目录；产品名「灯下」也必须保持稳定，
  // 否则 userData 会迁移到新名字目录，旧数据就找不到了。
  const root = path.join(app.getPath('userData'), 'library')
  fs.mkdirSync(root, { recursive: true })
  const db = AppDatabase.open(path.join(root, 'library.sqlite'))
  migrate(db)
  const store = new Store(db)
  const settings = new SettingsStore(path.join(root, 'settings.json'))
  const dialogs: NativeDialogs = {
    async pickDocuments(windowId) {
      const smokeFile = process.env.DESK_SMOKE_IMPORT
      if (smokeFile) {
        const stat = await fs.promises.stat(smokeFile)
        return { cancelled: false, files: [{ path: smokeFile, name: path.basename(smokeFile), sizeBytes: stat.size }] }
      }
      const parent = BrowserWindow.fromId(Number(windowId)) ?? undefined
      const result = parent
      ? await dialog.showOpenDialog(parent, {
        title: '选择要导入的文稿',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '文稿', extensions: ['pptx', 'docx', 'pdf', 'txt', 'md', 'markdown', 'png', 'jpg', 'jpeg'] },
          { name: '旧版 Office（会被拒绝并给出另存说明）', extensions: ['ppt', 'doc'] },
        ],
      })
      : await dialog.showOpenDialog({
        title: '选择要导入的文稿',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: '文稿', extensions: ['pptx', 'docx', 'pdf', 'txt', 'md', 'markdown', 'png', 'jpg', 'jpeg'] },
          { name: '旧版 Office（会被拒绝并给出另存说明）', extensions: ['ppt', 'doc'] },
        ],
      })
      if (result.canceled || result.filePaths.length === 0) return { cancelled: true, files: [] }
      const files = []
      for (const filePath of result.filePaths) {
        const stat = await fs.promises.stat(filePath)
        files.push({ path: filePath, name: path.basename(filePath), sizeBytes: stat.size })
      }
      return { cancelled: false, files }
    },
    async pickExecutable(windowId) {
      const parent = BrowserWindow.fromId(Number(windowId)) ?? undefined
      const result = parent
      ? await dialog.showOpenDialog(parent, {
        title: '选择本机 LibreOffice 的 soffice 可执行文件',
        properties: ['openFile'],
      })
      : await dialog.showOpenDialog({
        title: '选择本机 LibreOffice 的 soffice 可执行文件',
        properties: ['openFile'],
      })
      if (result.canceled || !result.filePaths[0]) return { cancelled: true, path: null }
      return { cancelled: false, path: result.filePaths[0] }
    },
    async pickDirectory(windowId, title) {
      const parent = BrowserWindow.fromId(Number(windowId)) ?? undefined
      const options = { title, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return null
      return result.filePaths[0]
    },
  }
  const events: DeskEvents = {
    jobsChanged(event) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IpcChannel.jobsChanged, event)
      }
    },
    focus(windowId, target) {
      const win = BrowserWindow.fromId(Number(windowId))
      if (!win || win.isDestroyed()) return false
      win.webContents.send(IpcChannel.previewFocus, target)
      return true
    },
  }
  service = new DocumentService({
    db,
    root,
    worker: new ForkWorker(workerEntry()),
    office: new LocalOfficeGateway(),
    dialogs,
    events,
    settings,
    recheckIsolation: () => verifyOfficeIsolation(settings),
    version: () => app.getVersion(),
    restart: () => {
      app.relaunch()
      setTimeout(() => app.exit(0), 200)
    },
  })
  protocol.handle('app-resource', (request) => handleAppResource(store, root, request))
  const dev = Boolean(process.env.ELECTRON_RENDERER_URL)
  const csp = dev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' app-resource: data:; connect-src 'self' ws://127.0.0.1:43123 http://127.0.0.1:43123; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' app-resource: data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'"
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  const teaching = new TeachingService({ db })
  const teacher = new TeacherService({ db })
  const budget = new BudgetService(db, settings)
  const ai = new AiService({ settings, teaching, budget })
  // 读图/查证也记 token 用量，和开课用量一起落到 ai_usage，课堂界面可以看到真实花费。
  const usageStore = new StudyStore(db)
  const images = new ImageService({
    store,
    root,
    settings,
    budget,
    onUsage: (kind, usage, documentVersionId) => {
      try {
        usageStore.insertUsage({
          sessionId: null,
          documentVersionId,
          kind,
          promptTokens: usage.promptTokens,
          cachedTokens: usage.cachedTokens,
          cacheMissTokens: usage.cacheMissTokens,
          completionTokens: usage.completionTokens,
          reasoningTokens: usage.reasoningTokens,
          providerReported: usage.providerReported,
          model: usage.model,
          createdAt: new Date().toISOString(),
        })
      } catch {
        // 用量统计不许影响读图。
      }
    },
  })
  const study = new StudyService({
    db,
    settings,
    images,
    budget,
    habits: () => {
      const result = teaching.habits()
      return result.ok ? result.data : DEFAULT_HABITS
    },
    teacher,
    onProgress: (progress) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IpcChannel.studyProgress, progress)
      }
    },
  })
  const appInfo = new AppInfoService()
  registerIpc(ipcMain, service, teaching, ai, images, study, teacher, appInfo)
  createWindow(service)
  const runAutoBackup = () => {
    void service?.autoBackup().then((result) => {
      if (result.ok && !result.data.skipped) console.log('[backup] 自动备份：', result.data.path)
    })
  }
  setTimeout(runAutoBackup, 1500)
  setInterval(runAutoBackup, 6 * 60 * 60 * 1000).unref()
  void verifyOfficeIsolation(settings).catch((error) => {
    console.error('[office] 隔离自检异常：', error)
  })
}

app.whenReady().then(boot).catch((error) => {
  console.error(error)
  app.quit()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  void service?.close()
})

# Windows 预览包验证记录

日期：2026-11-15（America/Los_Angeles）。对象：`desk-setup-0.1.0.exe`，即本仓库第一次生成的 Windows 预览安装包。

这是安装与运行验证，不等于功能完整。Office 页面转换仍禁用，授课、图文理解、学习档案和课后笔记都没有交付。

## 结论

- 安装包能生成、能安装、能卸载；安装后开始菜单与桌面都有「案头」快捷方式。
- 安装版能正常启动，窗口标题为「案头」，关闭窗口后进程退出。
- 安装版能真实导入 PDF、TXT、Markdown、DOCX 并显示解析结果：PDF 出页预览与来源锚点；TXT、Markdown 为无页段落；DOCX 为部分完成、只抽文字、没有渲染页。
- 34 项测试、两套 TypeScript 检查和构建在 Windows 上全部通过。
- 仍未验证：Windows 上的原生文件框点击、LibreOffice 转换、`taskkill /T /F` 取消、代码签名与 SmartScreen。AppContainer 与 Job Object 的隔离层在此后同日补做，见 `docs/office-isolation.md`。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 | Microsoft Windows 11 家庭版 中文版 25H2 |
| 版本 / 生成号 | 10.0.26200，UBR 9974 |
| 架构 | x64 |
| Node.js（仅构建用） | v22.23.2 |
| npm | 10.9.8 |
| PowerShell | 7.6.4 |
| Electron | 45.3.2（包内自带 Node 24.22.2） |
| LibreOffice | 未安装，`soffice` 不存在 |
| 电脑操作（GUI 自动化） | 本机被关闭，未使用；验证走应用自带的冒烟入口 |

## 从源码到安装包

在仓库目录依次执行，全部退出码为 0：

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm run dist:win
```

- `npm ci`：373 个包。`node_modules\electron` 的二进制没有随 `npm ci` 下载，另用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js` 补齐；打包时同样设置了 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR`。
- `npm test`：13 个测试文件、34 个测试全部通过（详见 `docs/test-report.md` 的 Windows 段）。
- `npm run typecheck`：`tsconfig.json` 与 `tsconfig.renderer.json` 两套均通过。
- `npm run build`：`out/main/index.js`、`out/preload/index.cjs`、`out/renderer/`、`out/worker/documentWorker.mjs` 生成成功。
- `npm run dist:win`：electron-builder 26.18.0，NSIS，x64，每用户安装。产物 `dist/desk-setup-0.1.0.exe`。

安装包信息：

| 项 | 值 |
| --- | --- |
| 文件名 | `desk-setup-0.1.0.exe` |
| 大小 | 139,690,185 字节 |
| SHA-256 | `4A26101CE3BDC209182C8E03ACF47FA7477CE3FF0461132E1380CC166E6A680F` |
| 签名 | 未签名（`NotSigned`）；`signAndEditExecutable: false` |
| 图标 | 未设置，使用 Electron 默认图标 |
| 安装位置 | `%LOCALAPPDATA%\Programs\desk` |
| 数据目录 | `%APPDATA%\desk-teacher-agent\library` |

`resources/app.asar` 为 11,744,508 字节；`app.asar.unpacked/node_modules` 下有 `@napi-rs`（含 27,868,160 字节的 `.node`）与 `pdfjs-dist`，与 `electron-builder.yml` 的解包规则一致。

## 安装、启动、卸载

安装：

```powershell
Start-Process -FilePath "dist\desk-setup-0.1.0.exe" -ArgumentList "/S" -Wait
```

- 退出码 0。
- `%LOCALAPPDATA%\Programs\desk\desk.exe` 存在（250,056,704 字节）。
- 建立 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\案头.lnk` 与桌面 `案头.lnk`。

启动（普通模式）：

- 进程列表中主窗口标题为「案头」，`Responding = True`。
- `CloseMainWindow()` 后 3 秒内进程退出，没有残留。

卸载：

```powershell
Start-Process -FilePath "%LOCALAPPDATA%\Programs\desk\Uninstall desk.exe" -ArgumentList "/S" -Wait
```

- 退出码 0；安装目录、开始菜单快捷方式、桌面快捷方式都被移除。
- 用户数据保留：`%APPDATA%\desk-teacher-agent\library\library.sqlite` 仍在。卸载不删文库，这是当前行为。
- 卸载后再次安装同一安装包，仍能正常装入并启动。

## 导入与预览

电脑操作（GUI）在本机被关闭，没有用鼠标点击原生文件框。改用应用自带的冒烟入口，由主进程执行同一套 `pick() → 一次性句柄 → import()` 流程，然后抓窗口截图。**原生文件框本身没有被人工点击验证**，这是本次验证的缺口之一。

| 样例 | 结果 | 界面证据 |
| --- | --- | --- |
| `sample.pdf` | 任务 `succeeded`，1 页 1 块，页预览图生成，来源锚点 `pdf-p001-b001`（未校验） | `docs/windows-evidence/import-pdf.png` |
| `sample.txt` | 任务 `succeeded`，0 页 3 块，段落 `txt-p-0001` 到 `txt-p-0003`，无伪造页 | `docs/windows-evidence/import-txt.png` |
| `sample.docx` | 任务 `partial`，0 页 3 块；提示未找到 LibreOffice、Office 未转页面；公式块 `x+1` 标为需复核 | `docs/windows-evidence/import-docx.png` |
| `sample.md` | 任务 `partial`，0 页 4 块；HTML 标记按纯文本保留、未执行（`<script>alert(1)</script>` 原样显示） | `docs/windows-evidence/import-md.png` |

数据落地（`%APPDATA%\desk-teacher-agent\library`）：

- `library.sqlite` 90,112 字节；
- `originals/` 下有 PDF（584 字节）、TXT（66 字节）等原文副本；
- `artifacts/` 下有 PDF 页预览 PNG（12,746 字节）；
- `work/` 为空。

## Windows 上发现并修掉的问题

1. **PDF 在 Windows 上完全无法打开**。`src/documents/parsers/pdf.ts` 的 `slashDir()` 用 `path.sep` 判断目录是否以分隔符结尾；Windows 下产出 `C:\...\cmaps\`，pdf.js 6.5.438 在 `getDocument` 阶段直接抛 `Invalid factory url: ... must include trailing slash`。Linux 上 `path.sep` 是 `/`，所以此前没有暴露。修复为：把反斜杠统一成正斜杠，再补结尾 `/`。复现与复验都用真实 PDF 跑过，打开与页渲染均成功。
2. **符号链接越权测试在 Windows 上无法执行**。无开发者模式或提权时 `fs.symlinkSync` 文件链接返回 `EPERM`。测试改为：Windows 下用目录联接（junction）把 `artifacts/escape-dir` 指到资料目录外，断言仍是 `readManagedPreview` 返回 403。realpath 守卫没有被放宽，只是换了同样的越权载体。
3. **新增冒烟入口** `DESK_SMOKE_SHOT` 原有，`DESK_SMOKE_IMPORT` 为本次新增：仅当环境变量存在时，主进程把该文件当作一次“已选择”的文件交给 `pick()`，再走正常的句柄和导入流程，并在抓图后退出。它不向渲染进程暴露路径导入，也不改变正常启动时的文件框行为。这是验证工具，不是用户功能。

## 仍未验证

- 原生文件框的人工点击、多选、取消。冒烟入口绕过了对话框本身。
- LibreOffice 的探测与 DOCX→PDF 转换：本机没有安装 LibreOffice。
- Windows Office 隔离：本记录成文时还没有实现。同日补做了 AppContainer + Job Object 执行层，越权读与断网阻断已有实测；真实转换仍缺证据，页面转换继续失败关闭。见 `docs/office-isolation.md`。
- 取消任务时的 `taskkill /T /F` 是否带走 LibreOffice 子进程：没有在 Windows 上运行。
- 代码签名、SmartScreen、杀毒软件锁定 SQLite 或 soffice、`MAX_PATH`、大小写不敏感路径、NTFS 符号链接绕过。
- 卸载不删除用户文库，是否需要提供“同时删除数据”的选项，尚未决定。

## 证据文件

- 本记录：`docs/windows-verification.md`
- 截图：`docs/windows-evidence/import-pdf.png`、`import-txt.png`、`import-docx.png`、`import-md.png`
- 测试与构建原始日志（工作副本根目录）：`win-test-1.log`、`win-test-2.log`、`win-typecheck.log`、`win-build.log`、`win-dist.log`、`win-dist-2.log`
- 安装包：`dist/desk-setup-0.1.0.exe`

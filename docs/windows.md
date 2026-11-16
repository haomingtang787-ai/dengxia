# Windows 构建与运行

**2026-11-15 已在一台 Windows 11 家庭版 25H2（10.0.26200，x64）上执行过：** 构建、打 NSIS 安装包、静默安装、普通启动、真实导入 PDF／TXT／Markdown／DOCX、卸载、重装。安装包 `desk-setup-0.1.0.exe` 的大小、SHA-256、截图与逐步结果见 `docs/windows-verification.md`。本文只保留步骤和仍未验证的项。

## 准备

1. 安装 Node.js 22.13 或更新的 22/24。开发测试使用的是 Node 22.23.4，本次 Windows 构建使用 Node 22.23.2。打包后的 Electron 45.3.2 自带 Node 24.22.2，不依赖系统 Node 运行应用本身。
2. 用 LibreOffice 官方安装包安装 LibreOffice，例如从 <https://www.libreoffice.org/download/download-libreoffice/> 下载 Windows 安装器。不要从随机镜像下载，应用也不会自带这份程序，也不需要 Microsoft Office。**本次验证机没有安装 LibreOffice**，因此只验证了缺少它时的失败关闭行为。
3. 安装完成后，`soffice.exe` 通常在 `C:\Program Files\LibreOffice\program\soffice.exe`。应用会查看常见路径；也可以在界面里用系统文件框自己选择这个 exe。

## 构建

在检出的目录中：

```bat
npm ci
npm test
npm run dev
npm run dist:win
```

若 `npm ci` 之后 `node_modules\electron` 里没有 `dist\electron.exe`（本次就出现了），用镜像补齐：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
node node_modules/electron/install.js
```

`npm run dist:win` 会先编译，再用 electron-builder 26.18.0 打 NSIS 安装包，配置在 `electron-builder.yml`。产品名是「案头」，安装包文件名形如 `desk-setup-0.1.0.exe`，输出目录是 `dist/`。`signAndEditExecutable` 设为 false，因为这里没有证书，也没有做过签名。本次打包另外设置了 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`，用于取 NSIS 与 winCodeSign 资源。

安装包是每用户安装，不是一键静默安装，可以选择目录。静默安装可用 `/S`，卸载用 `Uninstall desk.exe /S`。

## 第一次打开

1. 打开案头。左上角应能导入文稿，而不是要求登录。
2. 右侧或空状态里会显示 LibreOffice 是否被检测到，以及 Windows 沙箱自检的结果：通过，还是缺哪一段证据。
3. 沙箱自检通过 ≠ 页面转换可用。还要在同一个沙箱里真实转过一次 DOCX→PDF，两段证据都齐了 PPTX/DOCX 才会转成页面；在此之前只从文件结构提取文字，任务状态是部分完成。
4. 界面可以记下 `soffice.exe` 的路径。没有“允许未沙箱转换”按钮。启动时主进程会跑一次自检（约 20 秒，后台），「重新检查」会清空旧证据再重跑。
5. PDF、TXT、Markdown、PNG、JPEG 不依赖 LibreOffice，导入和预览不受这条关闭影响。

数据在当前用户的 Electron `userData\library` 下，不会上传。Windows 上的实际路径是 `%APPDATA%\desk-teacher-agent\library`。卸载不会删除这个目录。

## 已验证的 Windows 项目

- NSIS 安装包能生成，能安装，能卸载；卸载后目录和快捷方式消失，用户文库保留。
- Electron 45 在 Windows 上能开窗，标题「案头」，中文界面正常，关闭窗口后退出。
- PDF 能打开、抽文字、生成页预览图，并列出 `pdf-p001-b001` 锚点。这里修掉了一个 Windows 专属缺陷：pdf.js 要求 `cMapUrl`／`standardFontDataUrl` 用正斜杠并以 `/` 结尾，原来的 `path.sep` 判断在 Windows 上产出反斜杠，`getDocument` 直接抛错。修复见 `src/documents/parsers/pdf.ts`。
- TXT、Markdown 走无页路径，0 页，段落锚点按文件顺序生成；Markdown 里的 HTML 只按纯文本保留。
- DOCX 在缺少 LibreOffice 时是部分完成：只抽段落，0 页，提示未转页面，公式块标为需复核。
- `@napi-rs/canvas` 与 `pdfjs-dist` 的 asar 解包足以让工人进程加载：页预览图在安装版里实际生成成功。
- 34 项测试、两套类型检查、构建在 Windows 上通过。

## 仍未验证的 Windows 项目

- 原生文件框的人工点击、多选与取消。本次安装验证由应用自带的 `DESK_SMOKE_IMPORT` 冒烟入口提供文件，对话框本身没有被点击过。
- `C:\Program Files\LibreOffice\program\soffice.exe` 的实际探测与 DOCX→PDF 转换：本机没有安装 LibreOffice。沙箱内的真实转换因此没有证据，Office 转页继续关闭。
- Windows 上 `taskkill /T /F` 是否能在应用层取消时带走 LibreOffice 子进程：宿主内部的 `TerminateJobObject` 已实测，界面取消到宿主这一段没有在 Windows 上运行。
- AppContainer 与 Job Object 已经实现，越权读文件、断网、内存上限、进程树终止都有实测输出（`docs/office-isolation.md`）。仍未验证的是真实 soffice 在容器内启动与转换。
- 打包后的 helper：`electron-builder.yml` 用 `extraResources` 把 `resources/office-sandbox` 放到安装包资源目录，但 `npm run dist:win` 没有重跑，安装包内的路径与 ACL 未验证。
- 代码签名、SmartScreen、杀毒软件锁住 SQLite 或 soffice 时的行为。安装包是未签名的。
- `MAX_PATH`、大小写不敏感路径，以及 NTFS 符号链接绕过资料目录的情况。路径检查使用 `path.relative` 和 `realpath`；Windows 上的符号链接测试改用目录联接执行，仍然通过。
- 卸载时是否应提供“同时删除用户文库”的选项。

因此可以说：Windows 安装、启动、基础导入预览已验证；沙箱的越权读与断网阻断已在 Windows 上验证。不能说：Windows Office 转换已完成——第二段证据（真实 DOCX→PDF）因为本机没有 LibreOffice 还没拿到。

# 测试报告

本报告对应仓库里的当前测试，分两部分：2026-11-15 Linux 上的 R2 结果，以及同日 Windows 11 上的复跑与安装验证。两边环境不同，不能互相代替。

## 环境

- 系统：Linux cursor 6.12.113+，x86_64
- Node.js：v22.23.4
- npm：10.9.9
- 测试运行器：vitest 5.1.0
- SQLite：Node 内置 `node:sqlite`。在这台 Node 22 上会打印 ExperimentalWarning；Electron 45.3.2 自带 Node 24.22.2，其文档把该模块标为 release candidate
- LibreOffice：本环境没有 `soffice`
- bubblewrap / firejail：没有
- 图形：有 `xvfb-run`。即便之后能在虚拟显示里打开 Electron，那仍然是 Linux 窗口，不是 Windows

## 命令

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.renderer.json
```

`npm test` 即 `vitest run`。全局准备会用 esbuild 0.28.2 把 `workers/documentWorker.ts` 打成 `out/worker/documentWorker.mjs`。

## 基线与这次改动

基线是上一版第一阶段实现。那一版把 Office 转换默认关掉，但界面、`settings.json`、`prerequisites.setUnsandboxed` 和计划函数仍有“允许未沙箱转换”。打开之后会启动 `soffice`。

这次删掉该开关，并在三条路径上失败关闭：

- `planOfficeConversion` 在隔离未验证时不会返回 `convert`
- `parseDocument` 即使收到 `office.mode = "convert"` 也不调用转换函数
- `libreOfficeVersion`、`probeLibreOffice`、`convertWithLibreOffice` 在隔离未验证时不 `spawn`

`windowsOfficeIsolation()` 不读取配置、IPC 或环境变量。找不到 LibreOffice 时问题码是 `CONVERTER_MISSING`。找到了文件但拒绝启动时是 `CONVERSION_FAILED`。PDF、TXT、Markdown 和图片仍按原路径导入。

这次 Linux 修订没有做 Windows 验证，也没有打 Windows 安装包；Windows 部分在 2026-11-15 补做，见下文「Windows 复跑」。

## 结果

2026-11-15 在上述 Linux 环境运行：

```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.renderer.json
npx vitest run
```

- 两个 `tsc --noEmit` 退出码为 0
- `npx vitest run`：13 个测试文件，34 个测试，全部通过，耗时约 3.5 秒
- `npm run build`（electron-vite build 与 worker esbuild）退出码为 0。没有运行 `npm run dist:win`，没有 Windows 安装包

新增 `tests/office-isolation.test.ts`：伪造的设置、环境变量和 `office.mode = "convert"` 都不能让哨兵 `soffice` 写出启动标记；转换回调调用次数为 0；IPC 白名单没有 `prerequisites.setUnsandboxed`；PDF、PNG、TXT、Markdown 不带 Office 转换错误。

覆盖的行为：

- 分页默认 50、最大 200；非法句柄和路径字符串被拒绝
- 无页文本必须显式使用 `scope: "unpaged"`
- 路径穿越：`../`、绝对路径、ZIP 条目 `../escaped.txt`、预览符号链接指向资料目录之外
- 句柄一次性、按窗口隔离；取消文件框得到空列表
- 相同 `requestId` 的导入和重试不产生第二份记录
- 相同 SHA-256 仍是两份文稿
- 重启时 `running` 变为 `interrupted`，新进程可以用 `retry_of` 重试并成功
- 取消在工人退出前保持 `running` / `canceling`，退出并提交后才是 `cancelled`
- 没有 LibreOffice 时 TXT 仍成功，DOCX 为部分完成、没有页、段落锚点仍在，问题码是 `CONVERTER_MISSING`
- 伪造同意、环境变量或 `office.mode = "convert"` 都不会启动转换，也不会生成渲染页
- `.ppt` 返回 `UNSUPPORTED_FORMAT`，说明里包含 PPTX
- 超限文件在入库前拒绝；超过页数上限的 PDF 任务失败，错误码 `LIMIT_EXCEEDED`
- 外键打开，非法 `document_versions` 插入失败，`schema_migrations` 版本为 1
- LibreOffice 参数 `shell: false`，临时配置包含禁用宏和「不更新链接」
- 找到 LibreOffice 文件时计划结果仍是跳过，错误码为 `CONVERSION_FAILED`，不是 `CONVERTER_MISSING`
- 工人环境不包含测试放进去的密钥
- 真实子进程能解析一份 TXT

SQLite 实验警告出现在测试输出里。它是 Node 22 的模块状态提示，不是测试失败。

## 样例来源位置

夹具在 `tests/fixtures/`，由解析测试写入并保存在仓库中。`expected-locations.json` 记录：

- `sample.txt`：`txt-p-0001`、`txt-p-0002`、`txt-p-0003`，没有页
- `sample.docx`：`docx-p-0001` 到 `docx-p-0003`。第三段文本是 `x+1`，种类为公式，复核状态为需复核
- `sample.pptx`：幻灯片 1「一次函数」bbox `[0, 0, 0.5, 0.2]`；幻灯片 2「练习」bbox `[0.25, 0.4, 0.5, 0.2]`。没有渲染页码
- `sample.pdf`：第 1 页文字层包含 `Hello PDF`，框在页面上方。测试同时检查生成了预览图
- `sample.png` / `sample.jpg`：有预览尺寸，文字块写明内容没有被读取，提取方法是 `none`

## 界面冒烟

在同一台 Linux 上用 `xvfb-run` 打开编译后的 Electron 45.3.2 窗口。预加载脚本必须是 CommonJS（`out/preload/index.cjs`），沙箱渲染进程才能拿到 `window.desk`。基线窗口里还有「允许未沙箱转换」。这次编译后的窗口不再有该按钮，并写明找到文件也不会启动、没有同意开关。dbus 地址无法解析，但不影响空状态画面。这仍然是 Linux 虚拟显示，不是 Windows。截图见本次产物 `desk-library-fail-closed.png`。基线截图仍是早先的 `desk-library.png`。

单独打开渲染页面、没有预加载脚本时，界面只说明必须在桌面窗口中运行，不会假装导入成功。

## Windows 复跑（2026-11-15）

环境：Windows 11 家庭版 中文版 25H2，10.0.26200（UBR 9974），x64；Node.js v22.23.2（仅构建用）；npm 10.9.8；PowerShell 7.6.4；未安装 LibreOffice；电脑操作（GUI 自动化）被关闭。

首次 `npm test`：13 个测试文件、34 个测试中 4 个失败。两处原因，都不是测试断言写错：

1. **产品缺陷：PDF 在 Windows 上完全打不开。** `src/documents/parsers/pdf.ts` 的 `slashDir()` 用 `path.sep` 判断结尾，Windows 上得到 `C:\...\cmaps\`；pdf.js 6.5.438 在 `getDocument()` 里校验工厂 URL，要求正斜杠并以 `/` 结尾，于是抛 `Invalid factory url: ... must include trailing slash`。受影响的是 3 个测试（PDF 预览、超页数上限、Office 失败关闭里的 PDF 分支）。修复：目录统一转成正斜杠再补 `/`。修复后用真实 PDF 复验，打开、取文字、渲染预览图都成功。
2. **测试环境限制：文件符号链接 `EPERM`。** 未开开发者模式、未提权时 Windows 不能创建文件符号链接，`tests/path-traversal.test.ts` 的 `fs.symlinkSync` 直接失败。测试改为：Windows 下创建目录联接（junction）到资料目录之外，artifact 相对路径指向 `artifacts/escape-dir/escape.png`，仍断言 `readManagedPreview` 返回 403。守卫没有放宽，只换了同为越权载体的链接类型。

复跑结果：

- `npm test`：13 个测试文件、34 个测试全部通过。
- `npm run typecheck`：两套 tsconfig 退出码 0。
- `npm run build`：退出码 0。
- `npm run dist:win`：退出码 0，产出 `dist/desk-setup-0.1.0.exe`（139,690,185 字节，SHA-256 `4A26101CE3BDC209182C8E03ACF47FA7477CE3FF0461132E1380CC166E6A680F`，未签名）。

安装与导入的实机结果不在本文件展开，见 `docs/windows-verification.md`：静默安装与卸载退出码均为 0；安装版能启动并导入 PDF／TXT／Markdown／DOCX，截图在 `docs/windows-evidence/`。

Windows 上仍没有测到：原生文件框的人工点击、真实 LibreOffice 转换、取消时的 `taskkill /T /F`、代码签名与 SmartScreen。

## Windows 沙箱实现与自检（2026-11-15 同一台机器）

这一轮加入 AppContainer 执行层，同环境复跑：

- `npm test`：14 个测试文件、**52 个测试**全部通过（新增 18 个，见 `tests/office-sandbox.test.ts`）。
- `npm run typecheck`：两套 tsconfig 退出码 0。
- `npm run build`：退出码 0，包含新增的 `build:sandbox`（用系统 `csc.exe` 编译 `workers/office-sandbox/DeskOfficeSandbox.cs` 到 `resources/office-sandbox/DeskOfficeSandbox.exe`）。
- 真实自检（`DeskOfficeSandbox.exe selftest`）：越权读 `denied`、联网 `blocked-TimedOut`、授予目录 `write=allowed`、700MB 在 512MB 上限下 `alloc=limited`、孙进程心跳终止前 5→15 字节且终止后停住。实录见 `docs/windows-evidence/sandbox-selftest.txt`，分析见 `docs/office-isolation.md`。

新增测试覆盖的行为：

- 报告解析：缺任何一项（启动、容器、Job、越权读、联网、写入、内存、进程树）都判失败，理由写明缺什么
- 假证据防护：孙进程如果终止前就没在写（`treeHeartbeatBefore=0`），判失败而不是当成通过
- 门的开合：只有自检通过不开口；只有转换记录不开口；两段都过才 `verified: true`；清空后回到关闭；失败的转换记录不开门
- 契约层：两段证据会体现在 `prerequisites` 的 `windowsSandboxVerified` / `conversionVerified` / `note`
- 真实集成：在容器内跑目标程序，退出码传回；父进程导出的 `DESK_TEST_SECRET` 在容器内不可见
- 打包：`electron-builder --win dir` 到 `dist-sandbox/`，`resources/office-sandbox/DeskOfficeSandbox.exe` 存在且从该路径自检通过。NSIS 安装包本轮没有重打。

## 没有测到的东西

- Windows 原生文件框的人工点击、多选和取消；安装验证用的是应用自带的冒烟入口。
- 任何真实 LibreOffice 转换，Linux 与 Windows 都没有。这次的哨兵程序如果被启动就会留下标记；测试断言标记不存在。
- 真实 soffice 在 AppContainer 内的启动与转换（本机没装 LibreOffice），以及打包后 helper 的路径与 ACL。
- Windows 上应用层取消任务时进程树是否被清理；宿主的 `TerminateJobObject` 单独验证过。
- 发布、签名和自动更新。没有做这些事。

## 授课纯逻辑（2026-11-16，P1）

把「灯下」的四块教学语法搬进 `src/teaching/`，只搬纯逻辑，不碰存储、IPC 与界面。

- 新增 `src/teaching/types.ts`、`habits.ts`、`plan.ts`、`study.ts`。
- 新增 `tests/teaching-habits.test.ts`（9）、`teaching-plan.test.ts`（13）、`teaching-study.test.ts`（10）。
- `npm test`：17 个测试文件、**84 个测试**全部通过（新增 32 个）。
- `npm run typecheck`：两套 tsconfig 退出码 0。

与灯下原实现的三处有意差异：

1. 答错不再 `due = now`（原实现会让同一张卡在同一场复习里被无限捞回），改为 `now + 1 分钟`。
2. 放慢时显式只取一讲，不再依赖「首讲分钟数当整段」的算术。
3. `99 / 40 / 40` 三个上限收成 `MAX_DAY_COUNT / MAX_DAY_MARKS / MAX_MISSES`。

未搬：`parseKnowledgeImport`、`mergePoints`、`collectTerms`（等知识库与术语表那一步再补）。

## 授课表与 IPC（2026-11-16，P2）

- `migrate.ts` 拆成 v1 / v2 两段：老库只补教学表，不重建文稿表。v2 共 9 张表
  （`lectures / lecture_units / lecture_summaries / lecture_cards / lecture_quizzes /
  lecture_known / misses / habits / day_marks`）。
- 新增 `src/storage/teachingStore.ts`（手写 SQL，和 `Store` 同风格）、`src/teaching/validation.ts`、
  `src/teaching/service.ts`；12 个 `teaching.*` IPC 通道接进 `registerIpc`，preload 暴露
  `window.desk.teaching`。
- 行为：同一 `requestId` 重复建讲解只产生一份；标记听懂幂等并记 `day_marks`；答错入错题本
  （同题去重）；答案留在主进程，详情接口不返回 `answer`。
- 测试：新增 `tests/teaching-service.test.ts`（11 项，含「老库只补 v2」）与
  `tests/teaching-ipc.test.ts`（2 项：每个声明通道都真的绑了处理函数、授课通道把请求交给
  `TeachingService`）。
- `npm test`：19 个测试文件、**97 个测试**全部通过。
- `npm run typecheck`：两套 tsconfig 退出码 0。
- `npm run build`：退出码 0（preload 4.17 kB，renderer 587.03 kB，worker 64.4 kB，helper 19,968 字节）。

未验证：这些通道还没有从真实界面触发过——P3 才会有「上课 / 复习」两个视图。目前只有服务层
单测与 IPC 装配测试，没有 Electron 真机点击证据。

## 授课界面（2026-11-16，P3）

- 新增 `src/renderer/teaching/draft.ts`：没有模型时按标题分段（无标题用首句）、单段上限 420 字或 6 块、`minutes = clamp(2, 12, ceil(字数/200))`；讲解正文就是原文，不冒充老师的话。
- 新增 `ClassView.tsx`：这一坐（`firstSitting` + `sittingSentence`）、慢一点、习惯行（15/25/40 分钟、讲透/适中/抓考点、四个时段）、小讲列表、`pause` 停顿门、听懂了 / 暂停在这 / 取消听懂。
- 新增 `ReviewView.tsx`：到期卡片正背面、记得/忘了（`gradeCard`）、错题本。
- `App.tsx`：顶部「文稿 / 上课 / 复习」页签；文稿页加「按这一页拆讲」；非文稿视图收成两栏；`?view=class|review` 决定初始页（主进程 `DESK_SMOKE_VIEW` 会把它写进 `loadFile` 的 query）。
- 新增 `tests/teaching-draft.test.ts`（6 项）。
- `npm test`：20 个测试文件、**103 个测试**全部通过。
- `npm run typecheck`：两套 tsconfig 退出码 0。
- `npm run build`：退出码 0。

真机截图：临时 `--user-data-dir` + 种子文库（`scripts/seed-smoke-lecture.ts`，esbuild 成临时 mjs 写入 `library.sqlite`）+ `DESK_SMOKE_VIEW=class`，Electron 45.3.2 实际渲染后由 `DESK_SMOKE_SHOT` 截图：

- `docs/teaching-evidence/class-view.png`：讲解标题、共 3 讲、这一坐句子（按 25 分钟算出约 14 分钟）、三个小讲、第一讲的停顿提示。数据经真实 IPC 从 `TeachingService` 读出。
- `docs/teaching-evidence/review-view.png`：2 张到点卡片、正面题面、「看答案」按钮、错题本空态。

未点击验证：听懂了、暂停在这、慢一点、记得/忘了都没有真实点击证据，只有服务层单测覆盖这些写入；截图只证明渲染与取数。
## 授课模型与课后笔记（2026-11-16，P4 / P5）

- 新增 `src/ai/client.ts`（OpenAI 兼容 `/chat/completions`，60 秒超时）、`prompt.ts`（习惯 + 原文 + JSON 合同）、`parse.ts`（剥代码块、校验结构与答案范围）、`service.ts`（配置 / 测试 / 建讲解）；`settings.json` 增加 `ai`，密钥只留主进程。
- 新增 4 个 `ai.*` IPC 与 `teaching.note`；preload 暴露 `window.desk.ai`。
- 文稿页「本地拆讲 / 模型拆讲」，顶部「模型」弹窗可保存并测试连接；失败返回 `AI_FAILED`，不静默降级。
- 新增 `src/teaching/note.ts` 与上课页「生成课后笔记」：只汇总已听懂、错题、到点卡片。
- 新增 `tests/teaching-ai.test.ts`（8 项）与 `tests/teaching-ai-service.test.ts`（5 项）；`teaching-ipc` 增加到 3 项。
- `npm test`：22 个测试文件、**117 个测试**全部通过。
- `npm run typecheck`：两套 tsconfig 退出码 0。
- `npm run build`：退出码 0。
- `npm run dist:win`：退出码 0，产出 `dist/desk-setup-0.2.0.exe`（139,724,274 字节，SHA-256 `E5FBB41937EB6ABF2918CF15312FBC91F35801423317D9CD3FEFD9D175C32C0E`，未签名）。
- 打包后的 `dist/win-unpacked/desk.exe` 在临时 `--user-data-dir` 下真机冒烟：导入 sample.txt → 模型拆讲 2 讲 → 听懂了 1/2 → 做一道题答对 → 生成笔记 179 字；截图 `docs/teaching-evidence/model-class.png`。

验收方式说明：模型链路用本地假模型服务（OpenAI 兼容返回固定 JSON）走真实窗口按钮，因此
测到的是「IPC → AiService → fetch → 解析 → SQLite → 渲染」整条路径；**真实第三方模型没有测**，
因为用户还没给 key。0.2.0 已在本机先静默卸载 0.1.0 再安装，桌面快捷方式为
`C:\Users\16122\Desktop\案头.lnk`；安装后的 exe 已实测启动与导入（临时 `--user-data-dir`，
没有动用户的真实文库）。

## 0.2.1 增量：默认 DeepSeek 与拉取模型（2026-11-16）

- `src/shared/ai.ts` 增加 `DEFAULT_AI`（`https://api.deepseek.com/v1` / `deepseek-chat`），
  模型弹窗初始值改为 DeepSeek；保存过的配置仍然优先。
- `AiClient.listModels()`：GET `/models`、Bearer 鉴权、30 秒超时，兼容 `{data:[{id}]}` 与
  字符串数组，去重、上限 200；`AiService.models()` 支持用未保存的表单地址和密钥，没密钥时
  返回 `INVALID_ARGUMENT`「先填密钥，再拉取模型」。
- 新增 `ai.models` IPC、preload `window.desk.ai.models`；「模型」弹窗加「拉取模型」按钮与
  下拉选择，选中即回填模型名，地址改动会清空旧列表。
- 测试：22 个文件、**121 项全部通过**（新增默认值 1 项、拉取/无密钥/401 共 3 项）。
- `npm run typecheck` 退出 0；`npm run build` 退出 0；`npm run dist:win` 退出 0。
- 产出 `dist/desk-setup-0.2.1.exe`：139,725,375 字节，SHA-256
  `E7B0902B6FEE37B45B42D89D438843F6E071EAE8A522243527BD7098C7CEED46`，未签名。
- 打包后的 exe 真窗口冒烟：打开模型弹窗 → 拉取 3 个模型（deepseek-chat / deepseek-reasoner /
  mock-vision）→ 下拉选 deepseek-reasoner → 模型输入框回填；无 key 时弹窗提示先填密钥。
  截图 `docs/teaching-evidence/model-list.png`。
- 本机已卸载 0.2.0、安装 0.2.1；桌面 `案头.lnk` 指向
  `%LOCALAPPDATA%\Programs\desk\desk.exe`，安装后的 exe 用临时目录重跑同一冒烟通过。
- 未验证：携带真实密钥的 DeepSeek `/models` 返回内容与真实模型拆讲。无密钥探测已确认
  `https://api.deepseek.com/v1/models` 与 `https://api.deepseek.com/models` 都存在
  （返回 401 鉴权失败，而不是 404）。

## 0.2.2 增量：本机 OCR 与模型读图（2026-11-16）

- 调研结论：Doubao 助手侧「扫描全能王」「TextIn xParse」插件和 `byted-mediakit-image`
  的 `image-ocr` 都是云端能力，依赖鉴权，不适合内嵌到本机离线单用户应用；改用 Windows
  自带 `Windows.Media.Ocr`。本机 `AvailableRecognizerLanguages` 返回 `zh-Hans-CN`。
- 新增 `resources/ocr.ps1`（WinRT OCR + Await 包装，输出 JSON）与 `src/ocr/windows.ts`
  （脚本内联到临时文件、调用 powershell、解析 JSON、`normalizeOcrText` 合并汉字间空格）。
- 新增迁移 v3：`image_readings` 表，`kind` 限 `ocr`/`vision`，`UNIQUE(page_id, kind)`，
  按文稿版本建索引；`Store` 增加 `upsertImageReading` / `listImageReadings`。
- `settings.json` 的 `ai` 增加可选 `visionModel`；`AiConfigView` 增加该字段，模型弹窗可填。
- `AiClient` 新增 `authHeaders`（无密钥时不发 Authorization）与 `describeImage`
  （OpenAI 多模态 `image_url` data URI、90 秒超时、兼容 content 字符串或数组）。
- 新增 `ImageService`：`readings/ocr/vision`；OCR 走注入的 `runOcr`，视觉走注入的
  `visionPayload`（默认压到长边 1600 JPEG），结果落库；页面/图片不存在返回 `NOT_FOUND`，
  未配置模型返回 `INVALID_ARGUMENT`。
- 新增 IPC `images.readings`、`images.ocr`、`images.vision`；preload 暴露
  `window.desk.images`；`registerIpc` 增加第 5 个 `ImageService` 参数。
- 文稿页页面工具栏加「识别这一页文字」「让模型看懂这一页」，结果以「识别出的文字」/
  「模型读图」卡片显示；`makeLecture` 会把当前页的 readings 并入原文块。
- 测试：23 个文件、**126 项全部通过**（新增 `tests/image-readings.test.ts` 5 项；
  `teaching-ipc` 适配第 5 个参数；图片导入提示断言同步更新）。
- `npm run typecheck` 退出 0；`npm run build` 退出 0；`npm run dist:win` 退出 0。
- 产出 `dist/desk-setup-0.2.2.exe`：139,729,658 字节，SHA-256
  `9F2408714A9B8D99B5D638E3392824F227E85FEBF284DA05AC7B7A94C37D9CF7`，未签名。
- 开发版真窗口 OCR：导入 `%TEMP%\ocr-test.png` → 点「识别这一页文字」→ 43 字落库并显示；
  截图 `docs/teaching-evidence/ocr-read.png`。
- 开发版真窗口模型读图：本地 OpenAI 兼容假模型（`mock-vision`）→ 请求含 JPEG data URI →
  71 字落库；截图 `docs/teaching-evidence/vision-read.png`。
- 安装后的 0.2.2 用临时 `--user-data-dir` 复跑：OCR 行 `windows-ocr/43 字`，
  视觉行 `mock-vision/71 字`；截图 `docs/teaching-evidence/installed-022-ocr.png`、
  `installed-022-vision.png`。
- 未验证：真实第三方视觉模型（没有 key）；Windows OCR 的英文/公式识别质量
  （实测 `CO2→C02`、`H2O→H20`、`Glucose→GIucose`）；非中文语言包。

## 0.2.3 修正：DeepSeek 当前模型与图片输入（2026-11-16）

- 官方 2026-11 文档确认：`deepseek-flash`（DeepSeek-V4.1-Flash-1017）原生支持图片输入；
  `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停止使用，旧名字会被路由到新模型。
  0.2.2 的「DeepSeek 文本模型不能读图」是旧信息，已更正。
- `DEFAULT_AI.model` 改为 `deepseek-flash`；模型弹窗 placeholder、说明文案、
  页面读图提示同步修改。
- `SettingsStore.readAi` 对 `api.deepseek.com` 地址下的
  `deepseek-chat` / `deepseek-reasoner` / `deepseek-v4-flash` /
  `deepseek-v4-flash-vision-exp` 自动迁到 `deepseek-flash`；自定义网关不改。
- `describeImage` 的 `max_tokens` 从 900 提到 2400，避免思考过程吃掉输出额度。
- 新增 `tests/settings.test.ts`（1 项）和图片服务「不填图像模型、直接用 deepseek-flash」
  （1 项）。`npm test`：24 个文件、**128 项全部通过**。
- `npm run typecheck`、`npm run build`、`npm run dist:win` 均退出 0。
- 产出 `dist/desk-setup-0.2.3.exe`：139,729,578 字节，SHA-256
  `35D31E4891FE19C8D8B99DD4EEDB0D17501240B16A0BA3B616768582961EC6DA`，未签名。
- 安装后的 0.2.3 用临时 `--user-data-dir` 验证（本地兼容服务）：`model=deepseek-flash`、不填图像模型 →
  兼容服务收到 `{"model":"deepseek-flash","isImage":true,"hasDataUri":true}`，
  `image_readings` 落库 `kind=vision, engine=deepseek-flash, 71 字`。
  截图 `docs/teaching-evidence/installed-023-flash-vision.png`。
- **真实 DeepSeek 接口已验证**：`GET /v1/models` 返回 `deepseek-flash,deepseek-v4-pro`；
  直接用 `deepseek-flash` 发 `ocr-test.png`，返回完整中文和公式，用量 642 tokens
  （prompt 307 / completion 335，其中思考 271）。
- **安装后的 0.2.3 + 真实密钥端到端**：临时 `--user-data-dir` 复制真实设置，
  导入 `ocr-test.png` →「让模型看懂这一页」→ `image_readings` 落库
  `kind=vision, engine=deepseek-flash, 662 字`。截图
  `docs/teaching-evidence/installed-023-real-deepseek.png`。
- 安装后的 0.2.3 默认模型界面截图：
  `docs/teaching-evidence/installed-023-default-model.png`。
- 未验证：真实第三方视觉模型；Search / Fetch 接口实际调用；GIF / WebP 与超大扫描件。

## 0.2.4 增量：独立联网查证（2026-11-16）

- 新增迁移 v4 `page_research` 表：`id, document_version_id, page_id, query, answer,
  sources_json, engine, created_at, UNIQUE(page_id)`，按文稿版本建索引；`Store` 增加
  `PageResearchRow`、`upsertPageResearch`（`ON CONFLICT(page_id)` 更新）、
  `listPageResearch`、`getPageResearch`。
- `AiClient` 新增 `search(query, count)`：只允许 `api.deepseek.com`，POST
  `/v1/tools/search`，body 为 `query` / `count=5` / `ori_question` / `need_content=false`；
  把 `results` 归一化为 `ResearchSource`（title、url、snippet、summary、siteName、
  date、authority、score），过滤非 http(s) URL。
- `ImageService` 新增 `researchList` / `researchVerify`：取这一页 OCR/vision 读数或
  blocks 文字 → 没有文字时自动本机 OCR → 用页面文字搜索 → 把「页面内容 + 搜索结果」
  交给模型，只输出「核对结论 / 需要补充或修正 / 讲课建议」，引用 `[1][2]`；结果与来源
  落 `page_research`。
- 修复图片页把「图像已作为预览保留……」占位提示当成页面文字的 bug：
  `source_kind === 'image'` 的页面只用 OCR/vision readings；非图片页用 blocks 并过滤
  该提示。
- 修复查证偶发「模型没有返回内容」：DeepSeek `deepseek-flash` 思考模式默认开启，
  查证请求显式传 `thinking: {"type": "disabled"}`，避免思维链占用 3000 输出额度；
  读图和讲课仍保留默认思考模式。
- IPC 新增 `research.list`、`research.verify`；preload 暴露
  `window.desk.research.list/verify`；页面工具栏新增「联网查证这一页」，结果卡
  「联网查证」与「参考来源」列表。
- 新增 `tests/research.test.ts` 5 项；`npm test`：25 个文件、**133 项全部通过**。
- `npm run typecheck`、`npm run build`、`npm run dist:win` 均退出 0。
- 产出 `dist/desk-setup-0.2.4.exe`：139,732,177 字节，SHA-256
  `9344337EA76E9684112122748234EA42DC8A414E59124BADA14DDA013B50D277`，未签名。
- 已覆盖安装 0.2.4；注册表「案头 0.2.4」，桌面 `案头.lnk` 指向
  `%LOCALAPPDATA%\Programs\desk\desk.exe`。
- **真实 Search 接口已验证**：`POST /v1/tools/search`，query
  `光合作用 叶绿体 光反应 暗反应` 返回 5 条结果。
- **安装后的 0.2.4 + 真实密钥端到端**：临时 `--user-data-dir` 复制真实设置，导入
  `%TEMP%\ocr-test.png` →「联网查证这一页」→ 自动 OCR 43 字 → `page_research` 落库
  `engine=deepseek-flash+search`、answer 1488 字、5 条来源；截图
  `docs/teaching-evidence/installed-024-research.png`，临时库
  `%TEMP%\desk-installed-024-final\library\library.sqlite`。
- 未验证：真实第三方视觉模型；GIF / WebP 与超大扫描件；来源链接点击打开；代码签名与
  SmartScreen。

## 0.2.5 增量：导入即自动读懂，忽略作者聚焦知识点（2026-11-16）

- 新增 IPC `images.auto`：单页自动顺序跑 OCR → 模型读图 → 联网查证，已有结果跳过；
  返回 `ocr/vision/research` 三态（created / existing / skipped / failed）和失败原因。
- 图片页自动跑齐全流程；文字页直接用已解析 blocks 查证，不跑 OCR / 读图；没有文字的页面
  跳过查证。
- `App.tsx` 导入解析完成后自动遍历所有页，逐页调用 `images.auto`，显示
  「正在自动读懂第 N / M 页」；结果实时刷新到页面卡片。关闭再打开会补跑缺失页，不重复调用。
- 保存模型配置后，当前文稿会自动补跑读图和查证，不需要重新导入。
- 页面工具栏不再有「识别这一页文字 / 让模型看懂这一页 / 联网查证这一页」三个主按钮，只在
  自动失败时出现「重试这一页」。
- 忽略非知识信息：OCR 落库前过滤作者 / 主编 / 出版社 / 版权 / ISBN / DOI 等行；
  读图、查证、讲课提示词都要求忽略作者、机构、版权、页眉页脚、页码、日期、致谢和参考文献；
  查证搜索词优先用读图文字，避免 OCR 错字进入搜索；页面底部不再显示来源信息中的作者字段。
- 新增 2 项自动读懂测试；`npm test`：25 个文件、**135 项全部通过**。
- `npm run typecheck`、`npm run build`、`npm run dist:win` 均退出 0。
- 开发版零点击：导入 `ocr-test.png` → 自动 `ocr 43 字`、`vision 206 字`、
  `research 1523 字 + 5 来源`；截图 `docs/teaching-evidence/dev-024-auto.png`。
- **安装后的 0.2.5 + 真实密钥零点击**：临时 `--user-data-dir` 复制真实设置，导入同一张图，
  不点按钮，自动落库 `ocr 43 字`、`vision 185 字`、查证 `1246 字 + 5 来源`；
  搜索词已使用读图知识点，不含 `C02/H20/GIucose` 错字。截图
  `docs/teaching-evidence/installed-025-auto.png`，临时库
  `%TEMP%\desk-installed-025-auto\library\library.sqlite`。
- 打包时 electron-builder 下载 Electron 发行包网络超时；`electron-builder.yml` 增加
  `electronDist: node_modules/electron/dist` 后打包成功。
- 作者过滤真机验证：测试图顶部写「作者：张三 / 主编：李四」，安装版零点击自动读懂后，
  数据库 OCR 为 `光合作用发生在叶绿体。 C02 + H20 一 > GIucose`，不含张三/李四；
  查证 query 只含知识点，不含作者。截图 `docs/teaching-evidence/installed-025-meta.png`，
  临时库 `%TEMP%\desk-installed-025-meta\library\library.sqlite`。
- 产出 `dist/desk-setup-0.2.5.exe`：139,817,067 字节，SHA-256
  `F965D6ACD339F8994F018EB77CED06731BDE7AC8419291C0FDD25A9542D85C35`，未签名。
- 已覆盖安装 0.2.5；注册表「案头 0.2.5」，桌面 `案头.lnk` 指向
  `%LOCALAPPDATA%\Programs\desk\desk.exe`。
- 未验证：多页文稿的 N 页真机计时；真实第三方视觉模型；GIF / WebP 与超大扫描件；
  代码签名与 SmartScreen。

## 0.2.6 增量：AI 优先读懂，本机 OCR 只做兜底（2026-11-16）

- 0.2.5 是「本机 OCR → 模型读图」；OCR 错字会先落库并污染搜索。0.2.6 改为图片页先调
  AI 读图，AI 成功时不跑 OCR，页面只显示「AI 读懂」。
- `VISION_PROMPT` 改为「知识点 / 概念关系 / 讲课提示」三节，不再要求逐行抄整页文字；
  新增 system 提示：区分 O/0、I/l/1、上下标、箭头和希腊字母，看不清写「不确定」，
  作者、机构、出版方、版权、页码、日期、致谢、参考文献一律忽略。
- `AiClient.describeImage` 支持 `system`，`max_tokens` 从 2400 提到 3200。
- `ImageService.auto` 调换顺序：先 AI 读图；AI 不可用（无密钥 / 失败）才退回本机 OCR。
  `AutoReadResult` 在 AI 成功时 `ocr='skipped'`，真实图片页不再产生 OCR 行。
- `pageText` 对图片页只取 AI 文本；AI 不存在时才取 OCR。查证请求不再把两种文字混在一起。
- 前端 `preferredReadings`：有 AI 结果时只展示、只用于本地拆讲的 AI 版本；OCR 卡改名为
  「本机 OCR（备用）」。
- 无密钥或 AI 失败时仍有兜底：OCR 落库，提示用户填模型；失败原因保留在 `errors`。
- 新增/调整 2 项测试；`npx vitest run`：**137 项全部通过**；`npm run typecheck` 退出 0；
  `npm run build`、`npm run dist:win` 退出 0。
- 开发版真实 DeepSeek 零点击：带作者信息的测试图，`image_readings` 只有 `vision`，
  `OCR_ROWS=0`；AI 输出三节知识点，查证 1628 字。截图
  `docs/teaching-evidence/dev-026-ai-top.png`、`dev-026-ai.png`。
- **安装后的 0.2.6 + 真实密钥零点击**：同一张图，`KINDS=["vision"]`、`OCR_ROWS=0`；
  查证 1898 字。截图 `docs/teaching-evidence/installed-026-ai-top.png`、
  `installed-026-ai.png`；临时库 `%TEMP%\desk-installed-026-ai\library\library.sqlite`。
- 产出 `dist/desk-setup-0.2.6.exe`：139,817,541 字节，SHA-256
  `DA593A341EE295CDF44A2CC25F53266A837CBEAD9312D19A4BBD82AE5E428A35`，未签名。
- 已覆盖安装 0.2.6；注册表「案头 0.2.6」，桌面 `案头.lnk` 指向
  `%LOCALAPPDATA%\Programs\desk\desk.exe`。
- 未验证：多页整份文稿的 N 页真机计时；真实第三方视觉模型；GIF / WebP 与超大扫描件；
  代码签名与 SmartScreen。

## 0.3.0 增量：AI 私教闭环（2026-11-16）

- 0.2.x 的“逐页识别 + 一次性拆讲”被判为方向错误。0.3.0 新增独立学习会话架构：
  `study_sessions` / `study_units` / `study_messages`，schema 迁移到 5。
- 新增 `src/study/prompt.ts`、`parse.ts`、`service.ts`；新增 `StudyService.create/send/finish/list/get`。
  `create` 一次完成整份材料接收、课程设计、落库和开场消息；`send` 成功后才写 user/assistant 两条消息；
  `finish` 生成结构化学习总结，已有总结直接返回。
- 课程设计要求整份材料总览、按个人习惯拆 1–12 讲、每讲至少 2 个逐句讲解层次。parser 对单段讲稿判不合格，
  service 带错误原因再请求一次，不把半成品落库。
- 整份材料收集：文字页取 `blocks`；图片页优先 AI 视觉，失败才本机 OCR；空页/失败写入 `warnings`；
  超过 100,000 字保存 `truncated` 并提示。会话创建时冻结习惯到 `habits_json`，后续改习惯不影响已开课。
- 前端新增 `src/renderer/study/StudyView.tsx`；tab 改为「文稿 / AI 私教 / 复习」；文稿页移除旧拆讲按钮。
  进入 AI 私教时自动打开列表第一份文稿、自动创建课堂；手动“再开一门”保留。
- 修复 `.stage header` 的 flex 规则污染讲稿标题，讲稿标题恢复普通文档流。
- IPC：`study.create/list/get/send/finish`；preload 暴露 `window.desk.study`；main 注入 `StudyService`。
- 新增 `tests/study-service.test.ts` 7 项，覆盖完整材料拆课、逐句讲稿、开场消息、多轮对话上下文、
  总结持久化、同 requestId 幂等、图片页 AI 视觉、无 API 提示、单段讲稿修复重试。
- 全量验证：`npx tsc -p tsconfig.json --noEmit` 退出 0；`npx tsc -p tsconfig.renderer.json --noEmit`
  退出 0；`npx vitest run`：**26 个测试文件、144 项全部通过**；`npm run build`、`npm run dist:win` 退出 0。
- 开发版零点击真实 DeepSeek：2 讲，逐句层次 3 / 5，消息 3 条，总结 567 字；库
  `%TEMP%\desk-dev-030-zero\library\library.sqlite`。
- 安装版 0.3.0 真实 DeepSeek 零点击：4 讲，逐句层次 2 / 3 / 3 / 3，总览 281 字，消息 3 条，
  老师回复 142 字，总结 618 字、4 组；库 `%TEMP%\desk-installed-030-final\library\library.sqlite`；
  截图 `docs/teaching-evidence/installed-030-ai.png`、`installed-030-chat.png`、
  `installed-030-summary.png`。
- 产出 `dist/desk-setup-0.3.0.exe`：139,824,370 字节，SHA-256
  `E6E18E2379F008A5141F669C584A4D7E98394CF7AD9C415B070D78936DA51102`，未签名。
- 已卸载 0.2.6、覆盖安装 0.3.0；注册表「案头 0.3.0」；桌面 `案头.lnk` 指向
  `%LOCALAPPDATA%\Programs\desk\desk.exe`。
- 未验证：超长材料分块汇总；PPTX / DOCX 页面转换（未启用 LibreOffice 沙箱转换）；真实第三方视觉模型；
  多页讲稿的 N 页真机计时；代码签名与 SmartScreen。
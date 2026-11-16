# 案头

本地单用户的教师文稿工作台 + AI 私教。当前版本 **0.4.2**。

一条闭环：导入课件 → 整份读懂（文字、表格、演讲者备注、内嵌图、扫描页）→ 按个人学习习惯拆成小讲 →
每讲「原文句子 → 老师逐句讲解 → 停一下的问题」→ 多轮追问 → 学生作答留证 → 学习分析总结。
长课件读懂时界面有分阶段进度（读图 x/y 页、已读 x/y 段），讲稿引用会逐字对回原文，
对不上的如实标注为模型转述。0.4.1 已用 DeepSeek 官方接口对真实 PPTX / DOCX / 82 页 PDF 全链路验收。

没有账号，没有云同步，没有自建代理。模型调用只用你自己配置的 OpenAI 兼容接口（默认 DeepSeek），
密钥只留在主进程。读图优先用你的视觉模型，失败时退回 Windows 自带离线 OCR。
读不出来的内容会明确标成「需复核」或写入课程警告，不会假装读懂。

架构见 `docs/AI私教-0.4.0-架构.md`，0.4.1 增量与真实课件实测见 `docs/验收说明-0.4.1-真实课件.md`，
0.4.2 的省钱（分段理解复用、前缀缓存、用量卡片）与阅读布局见 `docs/验收说明-0.4.2-省钱与阅读.md`。

## 技术栈（版本已锁定）

| 依赖 | 版本 |
| --- | --- |
| Electron | 45.3.2（内置 Node.js 24.22.2，Chromium 156） |
| TypeScript | 7.0.2 |
| React / React DOM | 19.3.1 |
| Vite / electron-vite | 8.3.8 / 6.0.0 |
| SQLite | Node 内置 `node:sqlite`（`DatabaseSync`）。开发机 Node 22.23.4 上它仍是实验模块；Electron 45 自带的 Node 24 里它是 release candidate |
| PDF | pdfjs-dist 6.5.438 + @napi-rs/canvas 1.1.1 |
| Office 包 | fflate 0.8.3、fast-xml-parser 5.12.1 |
| 测试 | vitest 5.1.0 |

精确版本在 `package.json`，安装锁在 `package-lock.json`。不要改成范围版本。

LibreOffice **不随应用打包**。需要页面预览的 PPTX/DOCX 转换时，由使用者用官方安装包安装，并在应用里选择 `soffice` 可执行文件。

## 本地运行

```bash
npm ci
npm test
npm run dev
```

开发窗口由 Electron 打开。渲染进程开发服务器固定在 [http://127.0.0.1:43123](http://127.0.0.1:43123)。只用浏览器打开这个地址时，没有本机文件选择和数据库，页面会说明这一点。

打包出 Windows 安装器的命令是 `npm run dist:win`。安装包已在 Windows 11 25H2（10.0.26200）上生成、安装、启动、导入和卸载验证过，记录见 `docs/windows-verification.md`；仍未验证的项（原生文件框点击、LibreOffice、Office 转换）见 `docs/windows.md`。Windows 沙箱执行层的实现与自检输出见 `docs/office-isolation.md`。

## 现在能做什么

- 从系统文件框选择 PPTX、DOCX、PDF、TXT、Markdown、PNG、JPEG。旧版 `.ppt` / `.doc` 会被拒绝，并提示另存为 PPTX/DOCX。
- 原文复制进应用数据目录并计算 SHA-256。相同哈希不会自动合并成一份文稿。
- 后台任务有排队、进行、成功、部分完成、失败、取消、中断。进度先写入 SQLite，再通知界面。重启后，未完成任务变为「已中断」，可以重试。
- 预览渲染页，并按段落锚点、幻灯片编号或页面定位。TXT/Markdown 没有页。DOCX 段落锚点不会被编造成某一渲染页。
- 解析完整性：PPTX 取形状文字、表格、演讲者备注，并由本地渲染器合成页图；DOCX 取段落、公式可见字符与内嵌图
  （内嵌图落成资源、按块读图）；PDF 文字层成块，文字少且含图的页自动触发整页读图。
- AI 私教：进入页面即自动整份读懂并拆课，不用再点「识别」或「拆课」。
  - 每讲是「原文句子 / 老师讲解 / 停一下的问题」三层结构，模型只给一层时会重请求，不落半成品；
  - 追问带上课程总览、当前讲稿和最近 12 条消息；
  - 学生可以回答「停一下」的问题，作答落库并进入学习总结；总结按作答证据区分已掌握、还不稳、易错、下一步；
  - 材料超过 6 万字时按页分成最多 12 段逐段理解再拆课，不再截断；超过 60 万字才截断并明确提示。
- LibreOffice 只影响 Office 文件转 PDF 页面预览；不装也能导入、抽文字、拆课。
  即使找到了 `soffice`，也要先通过沙箱自检、再在同一沙箱里真实转过一次 DOCX→PDF，两段证据齐了转换才会启动。

契约全文在 `docs/import-contract-v0.1.md`。安全边界和未验证项在 `docs/security.md`，Windows 沙箱的实现与实测在 `docs/office-isolation.md`。测试命令和这次的结果在 `docs/test-report.md`。

## 数据位置

所有数据在 Electron `userData/library/`：

- `library.sqlite`
- `settings.json`（只记录 LibreOffice 路径。没有“允许未沙箱转换”的开关）
- `originals/` 原文
- `artifacts/` 预览图和来源信息
- `work/` 任务临时目录，启动时清空

预览图只通过 `app-resource://<资源 ID>` 读取。渲染进程不能提交磁盘路径。

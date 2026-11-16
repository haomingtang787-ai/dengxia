# 安全边界

文档是不可信输入。这一阶段的目标是避免执行它们，并避免渲染进程读到任意磁盘文件。下面把已经做到的限制和没有证据的部分分开写。

## 已在代码和 Linux 测试中落实的限制

- 渲染进程 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。预加载脚本只暴露白名单方法，没有通用 `invoke(channel)`。
- 文件框在主进程。导入只接受主进程发出的一次性、窗口范围句柄。路径字符串会在校验阶段被拒绝。
- 原文先复制进资料目录再解析。保存的相对路径在读取时必须落在资料根目录内；`realpath` 之后再查一次，用来挡住符号链接指向外部。
- `app-resource:` 只接受资源 UUID。数据库记录还必须是 `artifacts/` 下的 `page-image`，MIME 为 PNG 或 JPEG，文件头和 SHA-256 都要匹配。
- ZIP 在解压前检查条目数、声明体积、压缩比和路径。`..`、绝对路径和 ZIP64 会拒绝。测试覆盖了带 `../escaped.txt` 的 DOCX，以及指向资料目录外的符号链接预览。
- PDF 只把字节交给 pdf.js，并关闭 wasm。页面画布在工人进程里生成，渲染进程不打开 PDF。
- 文本按纯文本显示，不用 HTML 解析文档内容。链接不会被打开。
- LibreOffice 参数由参数数组启动，`shell: false`。每次转换使用单独的临时配置，写入 `DisableMacrosExecution=true`、`MacroSecurityLevel=3`、`DisableActiveContent=true`。Writer 的链接更新值为 2（从不），Calc 为 1（从不）。这些键来自 LibreOffice 当前 schema。Impress 的对应键没有在 schema 里确认，所以不能说幻灯片外部链接也被这个配置关掉了。
- Office 转换在两段证据未齐时失败关闭。`windowsOfficeIsolation()` 的证据不接受设置、IPC 或环境变量。版本检查、试转换和正式转换都先经过这道门，未验证时不 `spawn`。没有同意后无沙箱运行的开关。找不到程序和找到了但拒绝启动，使用不同的错误码。

## Windows 验证工具不改变边界

`DESK_SMOKE_SHOT` 与 `DESK_SMOKE_IMPORT` 是 2026-11-15 Windows 安装验证时使用的冒烟入口，只在对应环境变量存在时生效，且都在主进程里执行：前者抓窗口截图后退出；后者把一个文件当作“用户已选择”交给 `pick()`，再走一次性句柄和 `import()`。渲染进程仍然不能提交磁盘路径，也没有新增 IPC 通道；正常启动（不设这两个变量）时行为不变。用途与结果见 `docs/windows-verification.md`。

## Windows 执行层（2026-11-15 新增）

- 目标进程只在无 capability 的 AppContainer 里启动：没有 `internetClient`、没有 `privateNetworkClientServer`，断网由操作系统保证，不依赖管理员配置防火墙。
- 同时放进一个 Job Object：`KILL_ON_JOB_CLOSE`、进程内存与作业内存上限、活动进程数上限。宿主被强杀时句柄关闭，整棵进程树跟着结束。
- 只授予显式目录：每次转换把输入复制进运行目录，配置目录放在同一处，容器看不到文库路径；输出只回拷 PDF。
- 授予目录必须同时打低完整性标签，否则容器写不进去。只加 DACL 是不够的。
- 宿主由 Node 以白名单环境启动，容器子进程继承这份白名单。实测父进程导出的密钥在容器内不可见。
- 两段证据才开门：沙箱自检（越权读、联网、写入、内存上限、进程树）与同一沙箱内一次真实 DOCX→PDF。证据只在内存里，重启清空，界面「重新检查」先清空再重跑。
- 细节与实测输出见 `docs/office-isolation.md`。

## 不能称为安全隔离的部分

- 独立进程、超时、`--max-old-space-size=512`、临时配置和禁用宏，都只是缓解。它们不是沙箱。
- 工人环境的白名单只证明环境变量没带密钥，不证明联网被禁止；工人进程本身不在 AppContainer 里。
- 真实 LibreOffice 在容器内的转换**没有验证过**：本机没有安装 LibreOffice。因此第二段证据拿不到，Office 页面转换继续关闭。
- 打包后的 helper 路径与 ACL、应用层取消到宿主的链路、AppContainer profile 的清理，都没有验证。
- Linux 上没有使用 bubblewrap，也没有可用的 bwrap／firejail 结果。
- 因此应用仍不会在未获证据时运行 LibreOffice；界面写明缺的是哪一段证据。

无头模式和进程分离不是安全边界。Windows 上的沙箱已经实现并且安全侧有实测证据，但「Office 转换已完成」这句话仍然不能说。

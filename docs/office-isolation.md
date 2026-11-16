# Windows Office 隔离（AppContainer 与 Job Object）

日期：2026-11-15。对象：`resources/office-sandbox/DeskOfficeSandbox.exe`、`src/providers/sandbox.ts`、`src/providers/isolation.ts`。

这是计划第 2 步「完成 Windows Office 隔离」的**第一半**：安全侧已经实现并有本机实测证据。第二半「真实 Word／PPT 能转换」没有取得——本机没有安装 LibreOffice。所以 Office 页面转换仍然关闭，行为与上一版一致。

## 结论

- Windows 11 家庭版 25H2（10.0.26200，x64）、**普通用户、非管理员**下，AppContainer 能创建，容器进程能启动。`CreateAppContainerProfile` 首次创建成功；再次运行时返回「已存在」，退回 `DeriveAppContainerSidFromAppContainerName`。
- 四类断言都有实测输出（完整实录见 `docs/windows-evidence/sandbox-selftest.txt`）：
  - 越权读授予目录外的文件 → `read=denied`
  - 连本机监听端口 → `tcp=blocked-TimedOut`
  - 授予目录写入 → `write=allowed`（低完整性标签必须同时打上，否则写不进）
  - 700MB 申请在 512MB Job 上限下 → `alloc=limited`
  - 派生一个持续写心跳的孙进程，终止 Job 后心跳停止 → `treeKilled=yes`（终止前 5→15 字节，终止后停在 15）
- 父进程环境变量不会进入容器：`DESK_TEST_SECRET` 在容器内不可见，由 `tests/office-sandbox.test.ts` 断言。

## 为什么用 AppContainer，而不是受限令牌

- 受限令牌与低完整性只收紧权限位。用户本来能读的文件，受限令牌下的进程通常仍能读，挡不住「越权读文件」这条。
- AppContainer 的访问检查基于容器 SID：没有显式授予的路径一律拒绝，这才是能验证出来的拒绝。
- 无 capability 的 AppContainer 没有 `internetClient` 与 `privateNetworkClientServer`，断网是操作系统保证的，不需要管理员去加防火墙规则。
- 代价是授予目录必须同时加低完整性标签 `S:(ML;;NW;;;LW)`。只加 DACL 不加标签时容器写不进去，这是实测出来的必要条件。

## 组成

| 部分 | 作用 |
| --- | --- |
| `workers/office-sandbox/DeskOfficeSandbox.cs` | 单文件 C# 宿主：建容器、给目录加 ACL 与低完整性标签、建 Job Object、以 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 启动目标进程、按 `key=value` 输出结果 |
| `scripts/build-sandbox.mjs` | 用系统自带 `csc.exe` 编译到 `resources/office-sandbox/`；非 Windows 直接跳过 |
| `src/providers/sandbox.ts` | 解析宿主输出、运行自检、在沙箱里执行目标程序；环境变量白名单 `sandboxEnv` |
| `src/providers/isolation.ts` | 两段证据的存放与判定；`verified` 只由证据产生 |
| `electron-builder.yml` | `extraResources` 把 helper 放进安装包的 `resources/office-sandbox` |
| `tests/office-sandbox.test.ts` | 报告解析、门的开合、真实自检、环境变量泄漏 |

`npm run build` 现在包含 `build:sandbox`。

## 两段证据

1. **沙箱自检**：探针在容器内尝试越权读、联网、超额申请内存、向授予目录写入，并派生一个持续写心跳的孙进程。宿主把每项结果打出来。
2. **真实转换**：`probeLibreOffice` 在同一个沙箱里把内置的最小 DOCX 转成 PDF；成功才记第二段证据。

`windowsOfficeIsolation().verified` 只有在两段都为真时为 `true`。缺一段就 fail closed，`reason` 写明缺哪段：

- 没有自检 → `Windows 沙箱自检没有运行，或没有留下证据。`
- 自检没过 → 具体是哪一项没过（越权、联网、写入、资源上限、进程树）
- 自检过了但没转换 → `沙箱安全项已通过，但还没有在同一沙箱内完成一次真实的 DOCX→PDF 转换。`

证据只存在进程内存里，重启即清空。界面「重新检查」先清空再重跑两段，旧证据不会顺延。

`probeLibreOffice` 与 `libreOfficeVersion` 只要求第一段证据（自检通过）；正式 `convertWithLibreOffice` 要求两段都过。这是唯一的启动顺序：先证明沙箱能关住东西，再让 LibreOffice 在沙箱里转一次，才允许碰用户文稿。

## 实测输出

`resources/office-sandbox/DeskOfficeSandbox.exe selftest --work <临时目录>`：

```text
probe=ran
read=denied
tcp=blocked-TimedOut
write=allowed
alloc=limited
heartbeat=allowed
spawn=started
childpid=60544
containerMode=reused
container=S-1-15-2-2263601745-3528854297-2714044486-2573611039-3076946093-159133856-1535869698
job=created
launch=ok
probeReport=read
treeHeartbeatBefore=5
treeHeartbeatRunning=15
treeHeartbeatAfterKill=15
treeHeartbeatSettled=15
treeKilled=yes
probe.probe=ran
probe.read=denied
probe.tcp=blocked-TimedOut
probe.write=allowed
probe.alloc=limited
probe.heartbeat=allowed
probe.spawn=started
probe.childpid=60544
```

`treeHeartbeatBefore` / `Running` 用来排除「孙进程自己早就退了」这种假证据：只有终止前文件在长大（5→15），终止后不再变化（15→15），才算进程树被 Job 带走。解析器强制这一条，`treeHeartbeatBefore=0` 一律判失败。

## 仍未验证

- **真实 soffice**：2026-11-16 已用官方 MSI 的「管理安装」（`msiexec /a`，免管理员、不写 HKLM）装到
  `%LOCALAPPDATA%\LibreOffice`，版本 26.2.7。解包版的 `program\bootstrap.ini` 里 `InstallMode=<installmode>`
  是安装器占位符，必须手工改成 `InstallMode=Default`，否则 soffice 根本不工作。
  - 沙箱外：真实 DOCX→PDF 成功（LibreOffice 自己生成的 5,134 字节 DOCX → 14,156 字节 PDF）。
    仓库里 `tests/fixtures/sample.docx` / `sample.pptx` 是手写的最小 OOXML 包，LibreOffice 直接拒收
    （`Error: source file could not be loaded`），这是样例文件的问题，不是转换器的问题。
  - 沙箱内：`soffice.com --version` 能跑并打印出版本；一旦进入初始化（`--headless --terminate_after_init`
    或 `--convert-to`）就挂住，或 `exit=1` 且零输出，profile 只写出一半（有 `user/registrymodifications.xcu`，
    没有 `crash/`）。已排除安装不完整、profile 未预建、`soffice.exe` 与 `soffice.com` 的入口差异、
  字体 ACL；**未排除** AppContainer 下 LibreOffice 初始化所依赖的某个系统服务/句柄。
  因此**第二段证据仍未取得**，页面转换保持关闭。
- **帮助诊断的改动**：宿主 `run` 模式现在把子进程的 stdout/stderr 落成 `child-stdout.txt` /
  `child-stderr.txt`（此前子进程没有控制台，失败只剩一个退出码）。52 项测试仍全过。
- **NSIS 安装包**：本轮没有重打。只做了 `electron-builder --win dir` 到 `dist-sandbox/`，确认 helper 落在 `resources/office-sandbox/DeskOfficeSandbox.exe`（18,944 字节），并从该路径跑通了自检（越权读、断网、内存、进程树结果与源码树一致）。检查完已删除 `dist-sandbox/`，用同一条命令可复现。
- **应用层取消**：宿主内部 `TerminateJobObject` 已验证；从界面取消 → 主进程 → 宿主的链路没有在 Windows 上跑。
- **AppContainer profile 残留**：`DeskOfficeSandbox` 这个 profile 建过就没删，注册表里有残留。
- **杀毒软件、代码签名、SmartScreen**：未涉及。

因此可以说「越权读文件与联网阻断已在 Windows 上验证」，不能说「Windows Office 转换已完成」。
2026-11-16 补测后这条结论不变：LibreOffice 装上了、沙箱外能转，但容器里起不来，门仍然关着。

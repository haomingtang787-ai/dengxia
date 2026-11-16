# 文稿导入契约 v0.1

本文件保存第一阶段的导入契约。后面的「实现说明」只记录本仓库如何落地，不放宽契约。

## 范围

个人、单用户、Windows 桌面应用的第一阶段：导入、解析、预览、来源定位、可持久化和可恢复的任务。

不做讲授、对话、个人资料、课程或笔记。不设账号，不做云同步。全部数据在本机。这一阶段不选择模型供应商，不需要 API 密钥。没有实现的 OCR / 视觉能力不能被说成已经具备。

## 结构

```text
src/{main,preload,renderer,domain,providers,documents,retrieval,storage,shared}
workers/
resources/
tests/
```

Electron 渲染进程不集成 Node。`contextIsolation` 开启。IPC 只有白名单。展示内容要消毒。

本地文档工人与界面进程分开，限制时间、内存和解压规模。文档视为不可信：不执行其中的代码、宏或链接。

## 结果与标识

```ts
type Result<T> =
  | { ok: true; requestId: string; data: T }
  | { ok: false; requestId: string; error: { code: string; message: string; retryable: boolean } }
```

运行时校验所有输入。ID 使用 UUID。时间使用 UTC ISO 时间戳。

`JobState = queued | running | succeeded | partial | failed | cancelled | interrupted`

```ts
type Locator = {
  documentVersionId: string
  pageId?: string
  pageNumber?: number // 1-based rendered page
  slideNumber?: number
  paragraphAnchor?: string
  bbox?: [x, y, w, h] // normalized, upper-left origin
}
```

## 方法

- `documents.pick {} => { cancelled, files: [{ handle, name, sizeBytes }] }`
- `documents.import { handle, requestId } => { documentId, documentVersionId, jobId }`
- `documents.list { offset, limit } => { items, total }`
- `documents.get { documentVersionId } =>` 元数据、解析状态、警告
- `documents.pages { documentVersionId, offset, limit } =>` 页 ID、序号、预览资源 ID、状态
- `documents.blocks { pageId, offset, limit } =>` 块、阅读顺序、locator、提取方法、复核标记
- 无页文本必须有不违反「文本可以没有页」的查询方式
- `jobs.get { jobId } => { state, stage, completed, total, error? }`
- `jobs.cancel { jobId } => { state }`
- `jobs.retry { jobId, requestId } =>` 新的 `{ jobId }`，并带 `retry_of`
- `documents.openSource { locator } => { opened: boolean }`，只做内部预览

句柄由主进程生成，限定在窗口内，一次性使用。渲染进程不能提交路径。取消文件框时返回空列表。分页默认 50，最大 200。

受限的应用资源协议只按资源 ID 提供受管理的产物，并做归属与路径边界检查，不能当成任意磁盘读取。

TXT/Markdown 可以没有页。段落锚点对同一内容稳定。

## 任务事件

`jobs.changed { jobId, seq, state, stage, completed, total }`

先持久化，再发出事件。重启后用 `jobs.get` 读取；未完成任务标为 `interrupted`，并可以安全重试。取消只有在子进程退出并且数据库提交之后才是最终状态。导入和重试的 `requestId` 幂等，避免重复。

## 错误码

`INVALID_ARGUMENT` `NOT_FOUND` `UNSUPPORTED_FORMAT` `LIMIT_EXCEEDED` `FILE_UNREADABLE` `CONVERTER_MISSING` `CONVERSION_FAILED` `PARSE_FAILED` `RESOURCE_LIMIT` `STORAGE_ERROR` `CONFLICT`

## SQLite

外键打开。写入使用事务。

`schema_migrations(version INTEGER PRIMARY KEY, applied_at)`

其余 ID 为 `TEXT` 主键，引用使用外键。

- `documents(id, display_name, created_at)`
- `document_versions(id, document_id, sha256, format, size_bytes INTEGER, original_relpath, status, parser_version, created_at)`
- `pages(id, document_version_id, ordinal INTEGER, source_kind, source_number INTEGER NULL, image_relpath NULL, width INTEGER NULL, height INTEGER NULL, status)`
- `blocks(id, document_version_id, page_id NULL, ordinal INTEGER, kind, text, locator_json, extraction_method, review_state)`
- `artifacts(id, document_version_id, page_id NULL, kind, relpath, mime, sha256)`
- `issues(id, document_version_id, page_id NULL, block_id NULL, code, message, review_state, created_at)`
- `jobs(id, document_version_id, request_id UNIQUE, retry_of NULL, state, stage, completed INTEGER, total INTEGER NULL, seq INTEGER, error_code NULL, error_message NULL, created_at, updated_at)`

`pages` 对 `(document_version_id, ordinal)` 唯一。`blocks` 按版本和顺序索引。

`review_state = unverified | needs_review | user_verified`

所有路径相对应用数据目录，读取时检查边界。工作目录和最终资源分开。导入成功要求原文副本和哈希都在。相同哈希不会自动跨文稿合并。这一阶段没有讲授、资料或笔记表。

## 格式与转换

支持 PPTX、DOCX、PDF、TXT、Markdown、PNG/JPEG。拒绝旧版 PPT/DOC，并给出另存为 PPTX/DOCX 的说明。

第一阶段的 LibreOffice 由用户用官方安装包在外部安装，不捆绑，也不要求 Microsoft Office。应用检测安装，允许用本机原生文件框选择可执行文件，并核对版本和真实转换能力。

转换使用独立子进程、隔离的临时 LibreOffice 配置、禁用宏、不更新外部链接，`spawn` 参数不经过 shell。路径是 Office → PDF → 页面图像。DOCX 另外保留稳定段落锚点。绝不编造「段落对应某一渲染页」。

缺少 LibreOffice 时，只阻断 Office 转页，其他格式仍可导入。

工人进程权限应收紧并阻断网络。无头运行和进程分离不是安全边界，必须在 Windows 上验证。若不能验证安全的 Office 沙箱，就失败关闭或明确拦住不安全转换，不能悄悄无沙箱运行。

支持本地文字提取和页面渲染。渲染页保留图形和来源元数据。没有 OCR / 视觉能力时，扫描件、图像和公式区域必须是 `needs_review`，并明确写上能力未实现。公式的不确定性进入元数据，不能说成已经理解。

## 界面

必须能实际选择、导入和列出文稿，显示进度、警告、错误、取消和重试，预览翻页，以及包括无页锚点在内的来源定位。本机前提和状态要真实，不能假装转换已经成功。

## 测试与交付

包含有代表性的夹具和预期来源位置。测试要覆盖校验、路径穿越、句柄、幂等、重启、取消、缺少转换器、格式限制和解析。

文档写明 Windows 安装步骤、真实环境和样例结果，以及仅 Windows 才能验证的缺口。Linux 上的构建和测试不是 Windows 验证。没有 Windows 安全隔离的实际证据时，不能宣称隔离已经完成。

## 隔离更正（取代任何“同意后无沙箱运行”的做法）

Office 转 PDF 只有在下面四项都已经实际验证时才能运行：受限权限、禁止网络、资源上限，以及 Windows 上的进程树生命周期。没有这些证据时，主进程、服务和文档工人都必须失败关闭，不启动 `soffice`。

不存在同意开关、配置项、IPC 或环境变量可以把未隔离转换打开。选择本机可执行文件只记录路径。版本探测和试转换本身也会启动 LibreOffice，因此在隔离未验证时也不运行。

找不到可执行文件时，错误是 `CONVERTER_MISSING`。找到了文件但隔离未验证时，错误是 `CONVERSION_FAILED`，并写明没有启动。PDF、TXT、Markdown 和图片不走这条转换路径。

## 实现说明

这些说明是本仓库的落地选择，不是契约的放宽。

- 无页文本使用 `documents.blocks { documentVersionId, scope: "unpaged", offset, limit }`。它只返回 `page_id IS NULL` 的块，不为 TXT/Markdown 伪造页。
- 段落锚点规则：TXT 为 `txt-p-0001` 起，按空行分段；Markdown 为 `md-b-0001` 起，标题、段落和围栏代码按出现顺序编号；DOCX 为 `docx-p-` 加 `document.xml` 中 `w:p` 的源序号；PPTX 为 `pptx-s001-sh001`，序号来自幻灯片文件和形状源顺序。
- `bbox` 只在坐标来源真实时出现。PDF 文字层相对渲染页；PPTX 形状相对幻灯片尺寸。DOCX 段落没有 `pageNumber`，也不会在转换出 PDF 后补上。
- `windowsOfficeIsolation()` 不读取设置、IPC 或环境变量，当前固定返回未验证。`planOfficeConversion`、`parseDocument` 和 `convertWithLibreOffice` / `libreOfficeVersion` / `probeLibreOffice` 在未验证时都直接返回，不 `spawn`。
- 工人环境变量是白名单，不传递密钥、代理和 `NODE_OPTIONS`。这不是网络阻断的证据；状态里的 `networkBlocked` 恒为 `false`。
- 预览协议只返回 `artifacts/` 下、种类为 `page-image`、MIME 为 PNG/JPEG、哈希匹配、且真实路径仍在资料目录内的文件。
- 复核标记会显示。这一阶段没有把 `user_verified` 做成编辑流程。
- 本机状态方法只剩 `prerequisites.get`、`prerequisites.pickLibreOffice` 和 `prerequisites.recheck`。没有 `prerequisites.setUnsandboxed`。选择路径和重新检查都不启动 LibreOffice。渲染进程不能提交路径。

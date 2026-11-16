# 案头 AI 私教 0.4.0：完整接收课件、按习惯拆讲、逐句讲、可作答、出总结

> 目标链路：上传任意课件 → Agent 完整读懂（文字 + 表格 + 备注 + 图）→ 按个人习惯拆成小讲 →
> 每讲「原文句子 → 老师讲解 → 停一下的问题」→ 多轮追问 → 学生作答留证 → 学习分析总结。

0.3.0 已把这条链路跑通，但「完整读懂」在三个地方是空的：PPTX 的表格与备注没进正文、DOCX 的内嵌图
读不到、扫描版 PDF 有页图却不触发读图；另外长课件超过 20 万字直接截断，总结也没有学生的真实作答
作证据。0.4.0 只补这些缺口，不重做已经验证的链路。

## 一、各格式的读取路径（0.4.0 之后）

| 格式 | 文字 | 表格 | 备注 | 内嵌图 | 页图 |
| --- | --- | --- | --- | --- | --- |
| PPTX | 形状文字，按位置排序 | **新增**：`a:tbl` 逐行取，单元格用竖线连接 | **新增**：`notesSlide`，跳过缩略图/页码占位符 | 由本地幻灯片渲染器合成页图，整页送视觉模型 | 有（`pptxRender`，不依赖 LibreOffice） |
| DOCX | 段落与公式可见字符 | 单元格文字按段落收集 | 不适用 | **新增**：`drawing → a:blip → rels → word/media`，写进工作目录后落 artifact，按块读图 | 无页，不渲染 |
| PDF | 文字层按行成块 | 由文字层体现 | 不适用 | 不拆单图，整页读 | 有；**新增**：文字少且含图的页补 `image_region` 块，触发整页读图 |
| 图片 | — | — | — | — | 整页读图，失败退本机 OCR |
| TXT / MD | 纯文本 / 标题 | — | — | — | — |

读图顺序始终是：已有 AI 结果 → 调用视觉模型（用户自己的 key）→ 本机 Windows OCR 兜底。
任一页/任一图读不出来，只写警告，不假装读懂，也不阻断整门课。

### 为什么不接云端 OCR 插件

腾讯云、百度、TextIn 这类 OCR 识别率更高，但都要把整页课件上传到第三方并要求额外密钥。
当前产品的边界是「本地单用户 + 用户自己的模型接口」，所以默认只做两件事：
本机 OCR 兜底、把页图发给用户已配置的视觉模型。若将来要接云 OCR，落点应是
`ImageService.visionEmbedded` / `vision` 旁边再加一个 provider，而不是改授课链路。

## 二、数据模型（schema 6）

在 schema 5 之上新增，旧库原地升级，不改旧表语义：

```sql
block_readings(id, document_version_id, block_id, kind, text, engine, created_at)
  UNIQUE(block_id, kind)         -- 块级读图缓存，DOCX 没有页也能缓存

study_checks(id, session_id, unit_ordinal, segment_index, question, answer, created_at)
  UNIQUE(session_id, unit_ordinal, segment_index)  -- 同一句只留最后一次作答

ALTER TABLE study_sessions ADD COLUMN material_chunks INTEGER NOT NULL DEFAULT 1
```

- `block_readings`：同一张图只调用一次视觉模型；重开课直接复用。
- `study_checks`：掌握程度的**证据**，不是模型的感觉。问题文本由小讲决定，客户端传的问题不被采信。
- `material_chunks`：这份材料实际被分成几段理解，界面如实显示。

内嵌图不进 `pages`：DOCX 没有页，强行造虚拟页会污染页码定位。图片落 `artifacts`，
`kind='embedded-image'`，`page_id` 可为空，块 `locator.artifactId` 指回资源。

## 三、代码结构与职责

```text
documents/parsers/pptx.ts   + collectTables / notesText
documents/parsers/docx.ts   + parseRels / imageRelIds / takeImage（写工作目录）
documents/parsers/pdf.ts    + 低文字量含图页补 image_region 块
documents/parseTypes.ts     + ParsedBlock.embeddedImage
documents/service.ts        + 内嵌图复制进 artifacts，artifactId 写回 locator
images/service.ts           + visionEmbedded(blockId)：按块读图并缓存
study/digest.ts             + 切块 / 逐段理解 / 渲染给拆课
study/prompt.ts             + 分块拆课提示、总结带学生作答
study/service.ts            + 分块编排、块级读图、check()、detail 暴露 checks
storage/migrate.ts          + v6 迁移
renderer/study/StudyView    + 「停一下」作答框与已记录状态
```

### 长课件：不再截断，改成「逐段读懂 → 合并拆课」

```text
整份材料（≤ 60 万字）
   │  ≤ 6 万字：直接进拆课
   └─ > 6 万字：按【第 X 页】边界切块（最多 12 段，单段 ≥ 1.6 万字）
        每段 → 结构化理解（页码范围 / 主题 / 知识点 / 公式 / 例题 / 易错）
        单段失败重试一次；仍失败 → 原文前 3000 字降级 + 明确警告
        12 段理解结果 → 拆课（提示要求覆盖全部段，unit.source 写页码范围）
```

硬上限 60 万字，超出才置 `truncated` 并在界面说明「只处理了前面部分」。
这样既不会把 80 页课件切掉一半，也不会把 20 万字硬塞进一次请求。

### 「逐字逐句」仍然是持久结构

`study_units.segments_json` 每项是 `{source, explain, check}`：

- `source` 必须引用原文真实出现的一句或一个公式；
- `explain` 是老师口吻的讲解（80–220 字），同一句可以拆成多个层次，但解释不能复制；
- `check` 是讲完这句后的追问，学生可以作答。

模型只给一个讲解层次时，服务带错误原因重请求一次，不合格不落库。

### 测评闭环

```text
讲解 → 「停一下」问题 → 学生写下答案 → study_checks
                                         │
                          学习分析总结（带全部作答）→ 掌握 / 还不稳 / 易错 / 下一步
```

作答这一步不调模型、不判对错，只留证据；总结提示明确要求：没有作答证据的内容不许写成已掌握。

## 四、失败与恢复

| 场景 | 行为 |
| --- | --- |
| 某张内嵌图读不出来 | 记警告，其余内容继续；整门课不失败 |
| 某段材料模型没读懂 | 重试一次；仍失败用原文头部降级，并写明哪一段降级 |
| 表格/备注抽取为空 | 不生成空块，不产生「已读懂」的假象 |
| 没有配置模型 | 创建直接拒绝，不写半门课；不静默降级成摘要 |
| 作答内容为空 / 讲次不存在 | `INVALID_ARGUMENT`，不写库 |
| 重复开同一份材料 | 读图结果复用，不重复扣视觉调用 |
| 材料超过 60 万字 | 明确 `truncated`，界面提示覆盖范围 |

## 五、0.4.0 验收口径

必须同时满足：

1. PPTX 的表格文字与备注进入材料，缩略图占位与页码不混入（单测）。
2. DOCX 内嵌图被单独取出、落 artifact、按块读图，且第二次开课不再调用视觉模型（单测）。
3. 没有可读图的块只产生警告，材料其余部分照常拆课（单测）。
4. 80 页材料分成多段理解，最后一段页码进入模型请求；拆课提示声明「逐段」（单测）。
5. 作答能落库、重复作答只更新、总结提示包含真实作答（单测）。
6. 真实窗口里能完成：导入 → 自动拆课 → 作答并显示已记录 → 追问 → 生成总结（界面冒烟）。
7. 两套 TypeScript 检查、全量测试、构建通过。

未验证边界见 `docs/验收说明-0.4.0.md`：真实第三方模型、真实 PPTX 表格/备注样本、
真实 DOCX 图解题、超长扫描件、Windows 安装包。

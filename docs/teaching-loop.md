# 从「灯下」学到什么

`C:\Users\16122\Desktop\灯下` 是同一件事的上一版：一个中学课件的「私人书房」，Grok App Builder
在 Linux 沙箱里生成，跑在 0.0.0.0:8080 的预览里，最后被套进一个 84MB、未签名的 Electron 壳
（`灯下程序\灯下.exe`，产品名「灯下 · 私人书房」，1.0.0.0）。

它不是废品。它的**内容层**已经跑通了一整套教学语法；废掉的是**运行时**：服务端函数 + pglite +
better-auth + 预览桥 + Vercel，没有本地文件管线，也没有可恢复任务。

结论：不要重做它，把它的语言搬进案头的骨架。

## 一、值得原样搬的四块（纯逻辑，零框架依赖）

| 灯下文件 | 内容 | 为什么值钱 |
|---|---|---|
| `src/lib/habits.ts` | 习惯画像：Pace（讲透/适中/抓考点）、TeachStyle（先比方/先定义/先提问）、StudyWindow、Avoid（公式堆着/段落太长/没有例子）、`sanitizeHabits`、`habitBrief` | `habitBrief` 本身就是给模型的提示词，规定了字数、人称、称呼上限、例子要求——这是「像个老师」的全部秘密 |
| `src/lib/plan.ts` | `firstSitting`（这一坐）、`sittingSentence`、`buildRhythm`（考试日倒排、core/support 取舍、slowTaps 放慢） | 把「一页课件」变成「今晚 15 分钟听哪几讲」，并且说得出口 |
| `src/lib/study.ts` | 五箱间隔重复 `CARD_GAPS`、`gradeCard`、`collectDue`、错题 `Miss`、按科汇总 `CourseRoll`、连续天数、`todayBrief` | 复习不是列表，是有到期概念的任务 |
| `src/lib/tutor-types.ts` | `Unit`（minutes/teaching/**pause**/terms/pitfall/weight/example）、`Summary`（mustKnow/pitfalls/mnemonic/recital）、`QuizItem`、`Card` | `pause` 字段是「分知识点讲解与追问」的落点；`weight` 是排课的依据 |

这四块可以直接进 `src/teaching/`，只把 `@/lib/...` 的导入改成相对路径。

## 二、必须重写的

| 灯下 | 案头对应 |
|---|---|
| `src/lib/tutor.functions.ts`（39KB，服务端函数 + 真实模型调用） | 主进程服务 + IPC，按 `Result<T>` 契约返回 |
| `src/lib/db.ts` + pglite/postgres + `migrations/0001_auth.sql` | `src/storage/store.ts`（node:sqlite），新建表 |
| `src/lib/desk-storage.ts`（localStorage 持久化） | SQLite 行 |
| `desk-app.tsx` / `lesson-pane.tsx`（50KB + 28KB） | 案头 renderer，按现有页面风格重画，不搬组件 |
| `better-auth`、`preview-host-bridge`、`vercel.json`、`multiplayer/` | 全部删除；本地单用户不需要 |

## 三、实际落地的表（migration v2）

`src/storage/migrate.ts` 现在是两段迁移：v1 是原有的文稿/页/块/任务，v2 是教学数据。已存在的库只补 v2，不重建 v1。

```
lectures          (id, request_id UNIQUE, document_version_id, title, subject, source_name,
                   greeting, thesis, tonight, next_sitting, raw_text, habit_stamp, cursor, created_at)
lecture_units     (lecture_id, ordinal, id, title, minutes, source, teaching, pause,
                   terms_json, pitfall, weight, example)
lecture_summaries (lecture_id PK, outline_json, must_know_json, pitfalls_json, mnemonic, recital)
lecture_cards     (lecture_id, ordinal, id, front, back, box, due)
lecture_quizzes   (lecture_id, ordinal, id, prompt, choices_json, answer, explain)
lecture_known     (lecture_id, unit_id, marked_at)
misses            (id, lecture_id, prompt, explain, at)
habits            (单行 id=1, name, pace, style, minutes, window, avoid, updated_at)
day_marks         (date PK, known, cards, quizzes)
```

和最初草案的差异：

- `lectures.request_id` 唯一：同一个 requestId 重复提交不会产生第二份讲解，沿用文稿导入的幂等习惯。
- 「听懂」单独建 `lecture_known` 表，不用逗号串，取消听懂就是删一行。
- 题目答案留在主进程：`teaching.lecturesGet` 不返回 `answer` / `explain`，判题走 `teaching.answerQuiz`。
- `knowledge_points` 暂未建，等知识库那一步再说。

## 四、灯下自身的坑（照抄会带病）

1. `CARD_GAPS[0] = 0`：答错立刻到期，`collectDue` 下一秒又把它捞回来，同一场复习里会无限刷同一张卡。
   已改为答错进 0 箱、`due = now + 1 分钟`（`RELEARN_MS`），既保留「当场再见一次」，又不会锁死。
2. `packStrict` 是单向贪心：`day` 只前进不回头，一天装不下就跳到下一天，前面剩下的分钟不再回收；
   后面明明还有余量的小讲也可能被挤进 `leftover`。这是排课质量损失，不是死循环。
3. 各种上限散落：`dayNumber` 截 99、`normalizeDays` 留 40 天、`normalizeMisses` 留 40 条、`mergePoints` 留 200 条。
   已收成 `MAX_DAY_COUNT / MAX_DAY_MARKS / MAX_MISSES` 三个常量。
4. 放慢时用 `remaining[0].minutes` 当整段时长，靠分钟算术「碰巧」只装一讲，与文案「只上 X」不是一个来源。
   已改成显式只取一讲，文案与行为同源。
5. 人称与称呼规则只写在 `habitBrief` 里，UI 文案另有一套；迁移时必须把这条规则一起搬，否则口吻会散。

## 五、迁移顺序（就是第 3 步）

1. **纯模块落地 + 单测**：`habits` / `plan` / `study` / 类型。不碰 UI、不碰 AI、不碰数据库。
2. **表 + IPC**：建讲解、列讲解、标记听懂、卡片到期、判题、错题入册。
3. **渲染**：上课（大纲 → 小讲 → 讲解 → 暂停 → 续学）、复习（到期卡片 + 错题）。
4. **接真实 AI**：按 `habitBrief` 生成 `Lecture`（需要 provider 与 key）。
5. **课后笔记**：从已听懂的小讲与错题汇总。

步骤 1 不需要任何外部依赖，可以立刻做；步骤 4 需要你给一个能用的模型接口。

## 六、落地状态

- **P1 已完成（2026-11-16）**：`src/teaching/types.ts`、`habits.ts`、`plan.ts`、`study.ts`；
  `tests/teaching-habits.test.ts`、`teaching-plan.test.ts`、`teaching-study.test.ts` 共 32 项。
- **P2 已完成（2026-11-16）**：migration v2（9 张表）、`src/storage/teachingStore.ts`、
  `src/teaching/validation.ts`、`src/teaching/service.ts`；12 个 `teaching.*` IPC 通道、
  preload 的 `window.desk.teaching`。`tests/teaching-service.test.ts`（11 项）、
  `tests/teaching-ipc.test.ts`（2 项，含「每个声明通道都真的绑了处理函数」）。
- **P3 已完成（2026-11-16）**：`src/renderer/teaching/draft.ts`（本地拆讲，无模型时按标题/长度
  把原文拆成小讲）、`ClassView.tsx`（这一坐 / 慢一点 / 小讲列表 / 停顿 / 听懂 / 暂停续学）、
  `ReviewView.tsx`（到期卡片 / 看答案 / 记得忘了 / 错题本）；App 顶部加「文稿 / 上课 / 复习」
  三个页签，文稿页加「按这一页拆讲」，非文稿视图收成两栏。`tests/teaching-draft.test.ts` 6 项。
  真机截图见 `docs/teaching-evidence/class-view.png`、`review-view.png`。
- P3 未点击验证：听懂了 / 记得 / 忘了 / 暂停在这 这几个动作没有机器点击证据；截图只证明
  渲染和 IPC 取数。拆讲目前是「原文即讲解」，接模型后同一结构换成模型写的 teaching。
- **P4 已完成（2026-11-16）**：`settings.json` 增加 `ai`（地址 / 模型名 / 密钥，密钥只留主进程）；
  新增 `src/ai/client.ts`（OpenAI 兼容 `/chat/completions`，60 秒超时）、`prompt.ts`（习惯 +
  原文 + JSON 合同）、`parse.ts`（剥代码块、校验结构，答案越界直接报错）、`service.ts`
  （状态 / 保存 / 测试 / 建讲解）。四个 `ai.*` IPC。文稿页有「本地拆讲 / 模型拆讲」，顶部
  「模型」弹窗可保存并测试连接；模型失败返回 `AI_FAILED`，不假装成功，本地拆讲照旧可用。
  测试 `tests/teaching-ai.test.ts`（9）、`tests/teaching-ai-service.test.ts`（8）。
- **0.2.1 默认 DeepSeek + 拉取模型（2026-11-16）**：`src/shared/ai.ts` 增加 `DEFAULT_AI`，
  表单默认 `https://api.deepseek.com/v1` / `deepseek-chat`（0.2.3 已改为 `deepseek-flash`）；`AiClient.listModels()` 请求
  `/models`，`AiService.models()` 允许用表单里未保存的地址和密钥；新增 `ai.models` IPC。
  「模型」弹窗加「拉取模型」按钮，拉回后用下拉框选，选中即回填模型名；无密钥时明确
  「先填密钥，再拉取模型」，不静默失败。
- **自查补齐（2026-11-16）**：模型会生成开场、主旨和题，但 P3 的上课页只用了小讲——补了开场 /
  主旨展示和「这一页的题」，答错走 `answerQuiz` 进错题本；切换讲解时清空做题与笔记状态，避免
  上一份讲解的答案串到下一份。
- **P5 已完成（2026-11-16）**：`src/teaching/note.ts` 从已听懂、错题、到点卡片生成课后笔记，
  `teaching.note` IPC，上课页底部「生成课后笔记」，可以全选复制。笔记只写已经发生的事。
- **端到端验收（2026-11-16）**：本地假模型服务 + 临时 `--user-data-dir`，在真窗口里点按钮：
  导入 `sample.txt` → 模型拆讲 2 讲 → 听懂了 1/2 → 生成笔记 179 字。截图
  `docs/teaching-evidence/model-class.png`。真实第三方模型未测（用户还没给 key）。
  `model-list` 冒烟另证：弹窗「拉取模型」拉到 3 个模型、下拉选中后模型名回填；
  无密钥时弹窗留在原地并提示先填密钥。截图 `docs/teaching-evidence/model-list.png`。
- **0.2.2 图片 OCR + 模型读图（2026-11-16）**：新增 `resources/ocr.ps1` 与
  `src/ocr/windows.ts`，用 Windows 自带 `Windows.Media.Ocr` 离线识别中文，Node 侧合并
  汉字间空格；新增 `src/images/service.ts`、migration v3 `image_readings`、三个 `images.*`
  IPC；文稿页工具栏「识别这一页文字 / 让模型看懂这一页」，结果落库并进入拆讲原文。
  模型弹窗新增可选「图像模型（`visionModel`）」：0.2.2 当时误以为 DeepSeek 文本模型不能读图；
  0.2.3 已更正，`deepseek-flash` 原生支持图片，该字段只在换第三方视觉服务时需要。真机安装版两条路径都已跑通，见
  `docs\teaching-evidence\installed-022-ocr.png`、`installed-022-vision.png`。
- 暂未搬 / 未做：`parseKnowledgeImport` / `mergePoints` / `collectTerms`；可编辑大纲（要 update
  通道）；讲解中追问；笔记落库与搜索导出。

## 七、自问自答（P4 / P5）

- 问：密钥会不会漏到渲染层？答：`ai.status` / `ai.saveConfig` 只回 `configured` 与 `hasKey`，
  测试断言返回的 JSON 里不含密钥。
- 问：模型胡说怎么办？答：`parseLectureResponse` 先剥代码块再校验结构和答案范围；不合格就
  `INVALID_ARGUMENT`，不会写进半份讲解；写入仍过原来的 `parseCreateLecture`。
- 问：没有 key 能不能用？答：能。本地拆讲完全离线；点模型拆讲会打开配置弹窗，不会静默降级。
- 问：课后笔记会不会编？答：只汇总 `known`、错题和到点卡片；没错题就写「还没有错题」，
  测试覆盖空错题与进度两段。
- 问：为什么不用现成 OCR 插件？答：搜到的「扫描全能王」「TextIn xParse」和
  `byted-mediakit-image` 的 `image-ocr` 都是云端服务，依赖鉴权，装不进本机离线单用户应用；
  Windows 自带 OCR 不联网、无依赖，够读中文印刷体。
- 问：OCR 和模型读图怎么分工？答：0.2.6 起改为 AI 优先。图片页直接把整页图发给
  `deepseek-flash` 读懂知识点，AI 成功时不跑 OCR；只有没密钥或 AI 失败时才退回本机 OCR。
  本机 OCR 快、免费、离线，但英文/公式会错字，只当兜底。AI 读图需要用户自己的密钥，
  按页发送，只发送当前这一页。
- 问：为什么单独加 `visionModel`？答：0.2.2 最初误判 DeepSeek 默认文本模型不支持图片；
  0.2.3 确认 `deepseek-flash` 已原生支持图片输入，默认直接用它读图。字段保留，只在换
  第三方视觉服务时填写。
- 问：还差什么才算「完整老师应用」？答：真实 provider 实测、可编辑大纲、讲解追问、笔记搜索与导出。

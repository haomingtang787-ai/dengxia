export const PARSER_VERSION = 'import-contract-0.2.0'

export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200

export const LIMITS = {
  maxFileBytes: 80 * 1024 * 1024,
  maxTextFileBytes: 8 * 1024 * 1024,
  maxZipEntries: 4000,
  maxUncompressedEntryBytes: 32 * 1024 * 1024,
  maxTotalUncompressedBytes: 200 * 1024 * 1024,
  maxCompressionRatio: 80,
  maxPages: 200,
  maxBlocks: 8000,
  maxBlockChars: 16_000,
  maxImagePixels: 16_000_000,
  maxImageEdge: 8000,
  workerTimeoutMs: 120_000,
  officeTimeoutMs: 90_000,
  versionTimeoutMs: 20_000,
  maxMetadataChars: 500,
}

export type Limits = typeof LIMITS

export const MESSAGES = {
  legacyOffice:
    '不支持旧版 .ppt / .doc。请用 LibreOffice 或 Microsoft Office 将文件另存为 PPTX 或 DOCX 后再导入。本程序不要求、也不会调用 Microsoft Office。',
  unsupported:
    '这个格式不在第一阶段的导入范围内。可以导入 PPTX、DOCX、PDF、TXT、Markdown、PNG 和 JPEG。',
  utf8: '请将文本保存为 UTF-8 后再导入。当前阶段不猜测其他编码。',
  noOcr:
    '图像已作为预览保留。打开文稿后会自动让 AI 读懂图中知识点并联网查证，不用手动点按钮。',
  docxImage:
    '这一段的图片没能单独取出来（可能是旧版对象或 EMF 图元）。这一段只保留可见文字，不假装读懂了图。',
  formula:
    '这里有公式结构。当前阶段不会解释公式语义，只保留未校验的可见字符。',
  formulaGlyph: '部分字形疑似公式字体。公式语义没有被解析，请人工复核。',
  pdfImage:
    '此页包含图像。打开文稿后会自动让 AI 读懂图中知识点，不用手动点按钮。',
  links: '检测到外部链接。预览不会打开链接，也不会更新外部内容。',
  scripts: '检测到文档脚本或打开动作。这些内容不会执行。',
  converterMissing:
    '未找到 LibreOffice 可执行文件，所以没有把 Office 文件转成 PDF 页面。段落或幻灯片文字仍从文件结构提取。PDF、文本、Markdown 和图片不依赖 LibreOffice。',
  isolationUnavailable:
    '已发现 LibreOffice，但没有启动它。Office 转换必须先穿过一座已验证的 Windows 沙箱；这道门现在没有打开。配置、环境变量和界面操作都不能改成运行未隔离的转换。结构文字仍然保留。',
  sandboxUntested: 'Windows 沙箱自检没有运行，或没有留下证据。',
  sandboxDenied: 'Windows 沙箱自检没有全部通过：',
  conversionUntested: '沙箱安全项已通过，但还没有在同一沙箱内完成一次真实的 DOCX→PDF 转换。',
  conversionFailed:
    'LibreOffice 没有产出可用的 PDF。Office 页面预览缺失；已提取的结构文字仍然保留。',
  paragraphPages:
    'DOCX 段落锚点来自 document.xml 的段落顺序，没有映射到渲染页。',
  slidePages:
    'PPTX 文字定位来自幻灯片 XML。渲染页来自 LibreOffice 转出的 PDF，二者没有自动对齐。',
  notesSkipped: '演讲者备注没有纳入正文。本阶段不解析备注。',
  notesRead: '演讲者备注已并入正文，按幻灯片位置排序，不替代幻灯片上的文字。',
  htmlText: '文本中含有 HTML 标记。它们只按纯文本保留，不会执行。',
  sandboxNote:
    '进程分离不是安全隔离。Office 转换只有两段证据都落地才会运行：沙箱自检（越权读文件、断网、资源上限、进程树终止）与同一沙箱内的一次真实 DOCX→PDF。',
}

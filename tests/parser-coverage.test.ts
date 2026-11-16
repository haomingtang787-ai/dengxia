import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { LIMITS } from '../src/shared/constants'
import { parseDocxXml } from '../src/documents/parsers/docx'
import { parsePptxXml } from '../src/documents/parsers/pptx'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-parser-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

function richPptx(): Uint8Array {
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="10000000" cy="5000000"/>
</p:presentation>`
  const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp>
      <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5000000" cy="800000"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>二次函数图像</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:graphicFrame>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
        <a:tbl>
          <a:tr>
            <a:tc><a:txBody><a:p><a:r><a:t>开口方向</a:t></a:r></a:p></a:txBody></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:t>a 大于 0 向上</a:t></a:r></a:p></a:txBody></a:tc>
          </a:tr>
          <a:tr>
            <a:tc><a:txBody><a:p><a:r><a:t>对称轴</a:t></a:r></a:p></a:txBody></a:tc>
            <a:tc><a:txBody><a:p><a:r><a:t>x = -b/2a</a:t></a:r></a:p></a:txBody></a:tc>
          </a:tr>
        </a:tbl>
      </a:graphicData></a:graphic>
    </p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`
  const notes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>缩略图占位，不要出现</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>讲这里先强调 a 的符号决定开口。</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>3</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:notes>`
  const slideRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>
</Relationships>`
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
    'ppt/presentation.xml': strToU8(presentation),
    'ppt/slides/slide1.xml': strToU8(slide),
    'ppt/slides/_rels/slide1.xml.rels': strToU8(slideRels),
    'ppt/notesSlides/notesSlide1.xml': strToU8(notes),
  })
}

function docxWithImage(): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:t>下图是抛物线。</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="rId7"/></a:graphicData></a:graphic></w:drawing></w:r></w:p>
    <w:p><w:r><w:t>结论：开口向上。</w:t></w:r></w:p>
  </w:body>
</w:document>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">
  <Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`
  // 解析器会跳过 8KB 以下的图（图标、项目符号）；这里用足够大的假 PNG 数据。
  // 必须用随机字节：全零会被压缩到极小，触发压缩比上限。
  const image = new Uint8Array(randomBytes(12 * 1024))
  image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
    'word/document.xml': strToU8(document),
    'word/_rels/document.xml.rels': strToU8(rels),
    'word/media/image1.png': image,
  })
}

function docxWithTable(): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>二、用例描述</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>用例编号</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>UC-01</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>参与者及目标</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>学生：</w:t></w:r></w:p><w:p><w:r><w:t>完成标注</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>前置条件</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>已登录并导入判决书</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:r><w:t>三、界面说明</w:t></w:r></w:p>
  </w:body>
</w:document>`
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
    'word/document.xml': strToU8(document),
  })
}

describe('课件解析完整性', () => {
  it('PPTX 的表格和演讲者备注都进入正文，占位图与页码不混进来', () => {
    const parsed = parsePptxXml(richPptx(), randomUUID(), LIMITS)
    const table = parsed.blocks.find((block) => block.text.includes('开口方向'))
    expect(table).toBeTruthy()
    expect(table?.text).toContain('开口方向 | a 大于 0 向上')
    expect(table?.text).toContain('对称轴 | x = -b/2a')
    const notes = parsed.blocks.find((block) => block.text.includes('讲这里先强调'))
    expect(notes).toBeTruthy()
    expect(notes?.text).not.toContain('缩略图占位')
    expect(notes?.text).not.toContain('3')
    expect(parsed.issues.some((issue) => issue.code === 'NOTES_READ')).toBe(true)
  })

  it('DOCX 的表格整块进正文，单元格不再散成一堆孤立段落', () => {
    const parsed = parseDocxXml(docxWithTable(), randomUUID(), LIMITS)
    const table = parsed.blocks.find((block) => block.text.includes('用例编号'))
    expect(table).toBeTruthy()
    expect(table?.text).toBe('用例编号 | UC-01\n参与者及目标 | 学生：完成标注\n前置条件 | 已登录并导入判决书')
    const paragraphs = parsed.blocks.filter((block) => block.kind === 'paragraph').map((block) => block.text)
    expect(paragraphs).toEqual(['二、用例描述', table?.text, '三、界面说明'])
    expect(paragraphs.some((text) => text === 'UC-01')).toBe(false)
  })

  it('DOCX 的内嵌图被单独取出来，交给读图，而不是写成「未读取」', () => {
    const workDir = tempDir()
    const parsed = parseDocxXml(docxWithImage(), randomUUID(), LIMITS, workDir)
    const imageBlock = parsed.blocks.find((block) => block.kind === 'image_region')
    expect(imageBlock).toBeTruthy()
    expect(imageBlock?.embeddedImage?.mime).toBe('image/png')
    expect(imageBlock?.embeddedImage?.path && fs.existsSync(imageBlock.embeddedImage.path)).toBe(true)
    const text = parsed.blocks.filter((block) => block.kind === 'paragraph').map((block) => block.text).join('\n')
    expect(text).toContain('下图是抛物线。')
    expect(text).toContain('结论：开口向上。')
    expect(text).not.toContain('未读取')
  })

  it('没有工作目录时不写文件，但也不谎称读到了图', () => {
    const parsed = parseDocxXml(docxWithImage(), randomUUID(), LIMITS)
    expect(parsed.blocks.every((block) => !block.embeddedImage)).toBe(true)
    expect(parsed.issues.some((issue) => issue.code === 'NO_OCR')).toBe(true)
  })
})

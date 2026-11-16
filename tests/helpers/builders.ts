import { strToU8, zipSync } from 'fflate'

export function makePdf(pages: string[]): Buffer {
  const objects: string[] = []
  const fontId = 3 + pages.length * 2
  objects.push('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n')
  const pageIds: number[] = []
  let next = 3
  const pageParts: Array<{ pageId: number; contentId: number; stream: string }> = []
  for (const stream of pages) {
    const pageId = next
    next += 1
    const contentId = next
    next += 1
    pageIds.push(pageId)
    pageParts.push({ pageId, contentId, stream })
  }
  objects.push(`2 0 obj << /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >> endobj\n`)
  for (const page of pageParts) {
    objects.push(`${page.pageId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${page.contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >> endobj\n`)
    objects.push(`${page.contentId} 0 obj << /Length ${Buffer.byteLength(page.stream)} >> stream\n${page.stream}\nendstream endobj\n`)
  }
  objects.push(`${fontId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n`)
  const header = '%PDF-1.4\n'
  let position = Buffer.byteLength(header)
  const offsets = [0]
  for (const object of objects) {
    offsets.push(position)
    position += Buffer.byteLength(object)
  }
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index <= objects.length; index += 1) xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  xref += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`
  return Buffer.from(header + objects.join('') + xref)
}

export function makeDocx(): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <w:body>
    <w:p><w:r><w:t>第一段：课程导入。</w:t></w:r></w:p>
    <w:p><w:r><w:t>第二段：例题说明。</w:t></w:r></w:p>
    <w:p><w:r><w:t></w:t></w:r><m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath></w:p>
  </w:body>
</w:document>`
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
    'word/document.xml': strToU8(document),
    'docProps/core.xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><dc:title>一次函数讲义</dc:title><dc:creator>案头</dc:creator></cp:coreProperties>'),
  })
}

export function makePptx(options: { withImage?: boolean } = {}): Uint8Array {
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>
  <p:sldSz cx="10000000" cy="5000000"/>
</p:presentation>`
  const picture = options.withImage
    ? '<p:pic><p:nvPicPr><p:cNvPr id="3" name="图表"/></p:nvPicPr><p:spPr/></p:pic>'
    : ''
  const slide = (title: string, x: number, y: number, extra = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="5000000" cy="1000000"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody>
    </p:sp>
    ${extra}
  </p:spTree></p:cSld>
</p:sld>`
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
    'ppt/presentation.xml': strToU8(presentation),
    'ppt/slides/slide1.xml': strToU8(slide('一次函数', 0, 0, picture)),
    'ppt/slides/slide2.xml': strToU8(slide('练习', 2500000, 2000000)),
    'ppt/notesSlides/notesSlide1.xml': strToU8('<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'),
  })
}

export function makeSlipDocx(): Uint8Array {
  return storedZip([
    { name: 'word/document.xml', data: strToU8('<w:document><w:body><w:p><w:r><w:t>不应写出外部</w:t></w:r></w:p></w:body></w:document>') },
    { name: '../escaped.txt', data: strToU8('escaped') },
  ])
}

export function storedZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const local = Buffer.alloc(30 + name.length + file.data.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(file.data.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    Buffer.from(file.data).copy(local, 30 + name.length)
    locals.push(local)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(file.data.length, 20)
    central.writeUInt32LE(file.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralStart = offset
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(centralStart, 16)
  return new Uint8Array(Buffer.concat([...locals, centralBuf, eocd]))
}

export const SAMPLE_TXT = '第一段。\n\n第二段有两行\n仍属同一段。\n\n第三段。\n'
export const SAMPLE_MD = '# 阅读提纲\n\n第一段说明来源定位。\n\n第二段保留链接文字 [参考](https://example.com)。\n\n<script>alert(1)</script>\n'

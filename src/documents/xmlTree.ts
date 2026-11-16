export type XmlNode = {
  name: string
  children: XmlNode[]
  text: string
  attrs: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asTree(nodes: unknown): XmlNode[] {
  if (!Array.isArray(nodes)) return []
  const out: XmlNode[] = []
  for (const node of nodes) {
    if (!isRecord(node)) continue
    const attrs = isRecord(node[':@']) ? stringAttrs(node[':@']) : {}
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@') continue
      if (key === '#text') {
        out.push({ name: '#text', children: [], text: String(value ?? ''), attrs })
        continue
      }
      out.push({
        name: key,
        children: asTree(value),
        text: '',
        attrs,
      })
    }
  }
  return out
}

function stringAttrs(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = String(value)
  }
  return out
}

export function localName(name: string): string {
  const index = name.indexOf(':')
  return index === -1 ? name : name.slice(index + 1)
}

export function walk(nodes: XmlNode[], visit: (node: XmlNode) => boolean | void): void {
  for (const node of nodes) {
    const stop = visit(node)
    if (stop === true) continue
    if (node.children.length) walk(node.children, visit)
  }
}

export function descendants(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = []
  walk(node.children, (child) => {
    if (localName(child.name) === name) found.push(child)
  })
  return found
}

export function hasDescendant(node: XmlNode, name: string): boolean {
  let found = false
  walk([node], (child) => {
    if (child !== node && localName(child.name) === name) found = true
  })
  return found
}

export function textOf(node: XmlNode, skip: Set<string> = new Set()): string {
  if (skip.has(localName(node.name))) return ''
  if (node.name === '#text') return node.text
  let out = ''
  for (const child of node.children) {
    const local = localName(child.name)
    if (skip.has(local)) continue
    if (local === 'tab') out += '\t'
    else if (local === 'br' || local === 'cr') out += '\n'
    else out += textOf(child, skip)
  }
  return out
}

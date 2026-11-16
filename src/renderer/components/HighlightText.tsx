import { useMemo, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { BlockView } from '../../shared/contract'
import type { HighlightView } from '../../shared/highlights'

type SelectedText = { start: number; end: number; quote: string; x: number; y: number }

type Props = {
  block: BlockView
  highlights: HighlightView[]
  focused?: boolean
  onSelect: (selection: SelectedText | null) => void
  onDeleteHighlight: (id: string) => void
}

/** 正文块按高亮偏移切段；划词时用 Range 的前缀长度算相对 block 的字符偏移。 */
export function HighlightText({ block, highlights, focused, onSelect, onDeleteHighlight }: Props) {
  const ranges = useMemo(
    () =>
      highlights
        .filter((item) => item.blockId === block.blockId && item.startOffset >= 0 && item.endOffset <= block.text.length && item.endOffset > item.startOffset)
        .slice()
        .sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset),
    [block.blockId, block.text.length, highlights],
  )

  function handleMouseUp(event: ReactMouseEvent<HTMLParagraphElement>) {
    const element = event.currentTarget
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      onSelect(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
      onSelect(null)
      return
    }
    const prefix = range.cloneRange()
    prefix.selectNodeContents(element)
    prefix.setEnd(range.startContainer, range.startOffset)
    const start = prefix.toString().length
    const selected = range.toString()
    const end = start + selected.length
    if (!selected.trim() || selected.length > 500) {
      onSelect(null)
      return
    }
    const rect = range.getBoundingClientRect()
    onSelect({
      start,
      end,
      quote: selected,
      x: Math.min(window.innerWidth - 260, Math.max(12, rect.left)),
      y: Math.min(window.innerHeight - 64, rect.bottom + 8),
    })
  }

  const parts: ReactNode[] = []
  let cursor = 0
  for (const item of ranges) {
    if (item.startOffset < cursor) continue
    if (item.startOffset > cursor) parts.push(block.text.slice(cursor, item.startOffset))
    parts.push(
      <mark
        key={item.id}
        className="text-highlight"
        title="点击取消这段高亮"
        onClick={() => onDeleteHighlight(item.id)}
      >
        {block.text.slice(item.startOffset, item.endOffset)}
      </mark>,
    )
    cursor = item.endOffset
  }
  if (cursor < block.text.length) parts.push(block.text.slice(cursor))

  return (
    <p
      id={`block-${block.blockId}`}
      className={`block selectable ${block.kind} ${focused ? 'focus' : ''}`}
      onMouseUp={handleMouseUp}
    >
      {parts}
    </p>
  )
}

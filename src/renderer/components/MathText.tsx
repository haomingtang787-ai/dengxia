import katex from 'katex'
import { useMemo } from 'react'
import { splitMath } from '../../shared/math'

type Props = {
  text: string
  className?: string
}

function renderMath(value: string, display: boolean): string {
  return katex.renderToString(value, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    strict: 'ignore',
    output: 'html',
  })
}

/** 把正文里的 $...$ / $$...$$ / \(...\) / \[...\] 渲染成公式；解析失败保留原文。 */
export function MathText({ text, className }: Props) {
  const segments = useMemo(() => splitMath(text), [text])
  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <span
            key={index}
            className={segment.display ? 'math-block' : 'math-inline'}
            dangerouslySetInnerHTML={{ __html: renderMath(segment.value, segment.display) }}
          />
        ),
      )}
    </span>
  )
}

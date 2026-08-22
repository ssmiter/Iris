import { memo, useRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { ImageOff } from 'lucide-react'
import { cn } from '@/lib/cn'

import { CodeBlock } from './CodeBlock'

function PrePass({ children }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  return <>{children}</>
}

// remarkPlugins 在流式输出期间必须保持稳定引用，否则 ReactMarkdown 会反复重新解析整棵树
const remarkPlugins = [remarkGfm, remarkBreaks]

function createMarkdownComponents(): Components {
  return {
    h1({ children }: { children?: ReactNode }) {
      return <h1 className={cn('text-lg font-bold mt-4 mb-2 pb-1 border-b border-border text-ink')}>{children}</h1>
    },
    h2({ children }: { children?: ReactNode }) {
      return <h2 className={cn('text-base font-bold mt-3 mb-2 text-ink')}>{children}</h2>
    },
    h3({ children }: { children?: ReactNode }) {
      return <h3 className={cn('text-sm font-bold mt-3 mb-1.5 text-ink')}>{children}</h3>
    },
    h4({ children }: { children?: ReactNode }) {
      return <h4 className={cn('text-sm font-semibold mt-2 mb-1 text-ink')}>{children}</h4>
    },
    p({ children }: { children?: ReactNode }) {
      return <p className={cn('mb-2 last:mb-0 leading-relaxed text-ink')}>{children}</p>
    },
    ul({ children }: { children?: ReactNode }) {
      return <ul className={cn('pl-5 mb-2 space-y-0.5 list-disc text-ink')}>{children}</ul>
    },
    ol({ children }: { children?: ReactNode }) {
      return <ol className={cn('pl-5 mb-2 space-y-0.5 list-decimal text-ink')}>{children}</ol>
    },
    li({ children }: { children?: ReactNode }) {
      return <li className={cn('leading-relaxed text-ink')}>{children}</li>
    },
    blockquote({ children }: { children?: ReactNode }) {
      return (
        <blockquote className={cn('border-l-4 pl-3 py-1 my-2 italic rounded-r-[0.25rem] border-primary/40 bg-surface-muted text-ink-subtle')}>
          {children}
        </blockquote>
      )
    },
    hr() {
      return <hr className={cn('my-3 border-border')} />
    },
    a({ href, children }: { href?: string; children?: ReactNode }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={cn('underline text-primary hover:text-primary-hover')}>
          {children}
        </a>
      )
    },
    strong({ children }: { children?: ReactNode }) {
      return <strong className={cn('font-bold text-ink')}>{children}</strong>
    },
    code({ node, inline, className, children, ...props }: any) {
      const text = String(children)
      const match = /language-(\w+)/.exec(className || '')
      // Iris 没有 ThinkingProcess 的 Python 代码块旁路，所有代码块正常渲染
      const isBlock = (!inline && Boolean(match)) || text.includes('\n')
      if (isBlock) {
        return (
          <CodeBlock className={className} {...props}>
            {children}
          </CodeBlock>
        )
      }
      return (
        <code className={cn('px-1.5 py-0.5 rounded text-sm font-mono bg-surface-muted text-ink')} {...props}>
          {children}
        </code>
      )
    },
    table({ children }: { children?: ReactNode }) {
      return (
        <div className={cn('overflow-x-auto my-3 rounded-[0.5rem] border border-border')}>
          <table className={cn('min-w-full text-sm border-collapse m-0 text-ink')}>
            {children}
          </table>
        </div>
      )
    },
    thead({ children }: { children?: ReactNode }) {
      return <thead className={cn('bg-surface-muted')}>{children}</thead>
    },
    th({ children }: { children?: ReactNode }) {
      return (
        <th className={cn('px-3 py-2 border-b font-semibold text-left border-border text-ink')}>
          {children}
        </th>
      )
    },
    td({ children }: { children?: ReactNode }) {
      return (
        <td className={cn('px-3 py-2 border-b border-border text-ink')}>
          {children}
        </td>
      )
    },
    tr({ children }: { children?: ReactNode }) {
      return <tr className={cn('transition-colors hover:bg-surface')}>{children}</tr>
    },
    img({ alt }: { alt?: string }) {
      return (
        <span className={cn('inline-flex items-center gap-1 text-small text-ink-muted')}>
          <ImageOff aria-hidden="true" className="h-3.5 w-3.5" />
          外部图片未自动加载{alt ? `：${alt}` : ''}
        </span>
      )
    },
  }
}

const markdownComponents = createMarkdownComponents()

interface MarkdownChunk {
  offset: number
  content: string
}

interface MarkdownCache {
  source: string
  sealedLength: number
  chunks: MarkdownChunk[]
}

const listMarker = /^(?:[-+*]|\d+[.)])\s/

function canSealAtBlankLine(before: string, after: string) {
  const previousLine = before.trimEnd().split('\n').at(-1)?.trimStart() ?? ''
  const nextLine = after.split('\n', 1)[0]?.trimStart() ?? ''

  if (!nextLine || !after.includes('\n')) return false
  if (previousLine.startsWith('>') && nextLine.startsWith('>')) return false
  if (listMarker.test(previousLine) && listMarker.test(nextLine)) return false
  if (listMarker.test(previousLine) && /^(?:\s{2,}|\t)/.test(after)) return false
  return true
}

function findSealedChunks(source: string, baseOffset: number) {
  const chunks: MarkdownChunk[] = []
  let chunkStart = 0
  let cursor = 0
  let fence: '`' | '~' | null = null

  while (cursor < source.length) {
    const lineEnd = source.indexOf('\n', cursor)
    if (lineEnd < 0) break
    const line = source.slice(cursor, lineEnd)
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      fence = fence === null ? marker : fence === marker ? null : fence
    }

    if (
      fence === null
      && line.length === 0
      && cursor > chunkStart
      && canSealAtBlankLine(
        source.slice(chunkStart, cursor),
        source.slice(lineEnd + 1),
      )
    ) {
      const boundary = lineEnd + 1
      chunks.push({
        offset: baseOffset + chunkStart,
        content: source.slice(chunkStart, boundary),
      })
      chunkStart = boundary
    }
    cursor = lineEnd + 1
  }

  return {
    chunks,
    consumed: chunkStart,
  }
}

const MarkdownFragment = memo(function MarkdownFragment({
  content,
}: {
  content: string
}) {
  if (!content) return null
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  )
})

export function IncrementalMarkdown({ content }: { content: string }) {
  const cacheRef = useRef<MarkdownCache>({
    source: '',
    sealedLength: 0,
    chunks: [],
  })
  const cache = cacheRef.current

  if (!content.startsWith(cache.source)) {
    cache.source = ''
    cache.sealedLength = 0
    cache.chunks = []
  }

  const unsealed = content.slice(cache.sealedLength)
  const partition = findSealedChunks(unsealed, cache.sealedLength)
  if (partition.chunks.length > 0) {
    cache.chunks = [...cache.chunks, ...partition.chunks]
    cache.sealedLength += partition.consumed
  }
  cache.source = content

  const liveTail = content.slice(cache.sealedLength)

  return (
    <>
      {cache.chunks.map((chunk) => (
        <MarkdownFragment
          key={chunk.offset}
          content={chunk.content}
        />
      ))}
      <MarkdownFragment content={liveTail} />
    </>
  )
}

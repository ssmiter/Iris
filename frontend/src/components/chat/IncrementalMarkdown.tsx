import { memo, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownChunk {
  offset: number
  content: string
}

interface MarkdownCache {
  source: string
  sealedLength: number
  chunks: MarkdownChunk[]
}

const markdownPlugins = [remarkGfm]
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
    <ReactMarkdown remarkPlugins={markdownPlugins}>
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

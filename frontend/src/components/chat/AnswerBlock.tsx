import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AnswerNode } from '@/domain/chat/models'
import { cn } from '@/lib/cn'
import { useReveal } from '@/motion/useReveal'

interface AnswerBlockProps {
  node: AnswerNode
}

export const AnswerBlock = memo(function AnswerBlock({ node }: AnswerBlockProps) {
  const isFinal = node.role === 'final'
  const streaming = node.status === 'streaming'
  const visibleContent = useReveal(node.content, streaming)

  return (
    <section
      className="mt-4 min-w-0 text-body text-ink"
      aria-label={isFinal ? 'Iris 的回答' : '阶段结论'}
      aria-busy={streaming}
    >
      {!isFinal && (
        <div className="mb-2 flex items-center gap-2 text-caption text-ink-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
          阶段结论
        </div>
      )}
      <div
        className={cn(
          'prose prose-sm max-w-none text-ink',
          'prose-headings:text-ink prose-p:text-ink prose-strong:text-ink',
          'prose-a:text-primary prose-code:text-ink prose-code:before:content-none prose-code:after:content-none',
          'prose-pre:border prose-pre:border-border/70 prose-pre:bg-surface-muted',
          streaming
            && 'after:ml-1 after:inline-block after:h-4 after:w-px after:animate-soft-pulse after:bg-ink-muted after:align-text-bottom motion-reduce:after:animate-none',
        )}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {visibleContent}
        </ReactMarkdown>
      </div>
      {node.status === 'stopped' && (
        <p className="mt-3 text-small text-warning">
          已停止，已生成的内容仍被保留。
        </p>
      )}
      {node.status === 'failed' && (
        <p className="mt-3 text-small text-danger">
          回答生成失败，过程记录仍可查看。
        </p>
      )}
    </section>
  )
})

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AnswerNode } from '@/domain/chat/models'
import { cn } from '@/lib/cn'

interface AnswerBlockProps {
  node: AnswerNode
}

export function AnswerBlock({ node }: AnswerBlockProps) {
  const isFinal = node.role === 'final'

  return (
    <section
      className={cn(
        'mt-4 min-w-0 text-body text-ink',
        isFinal && 'rounded-md border border-border/80 bg-surface px-4 py-4',
      )}
      aria-label={isFinal ? 'Iris 的回答' : '阶段结论'}
    >
      {!isFinal && (
        <div className="mb-2 flex items-center gap-2 text-caption text-primary">
          <span className="rounded-full bg-primary-soft px-2 py-0.5">
            阶段结论
          </span>
        </div>
      )}
      <div
        className={cn(
          'prose prose-sm max-w-none text-ink',
          'prose-headings:text-ink prose-p:text-ink prose-strong:text-ink',
          'prose-a:text-primary prose-code:text-ink prose-code:before:content-none prose-code:after:content-none',
          'prose-pre:border prose-pre:border-border prose-pre:bg-surface-muted',
          node.status === 'streaming' &&
            'after:ml-1 after:inline-block after:h-4 after:w-0.5 after:animate-soft-pulse after:bg-primary after:align-text-bottom motion-reduce:after:animate-none',
        )}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.content}</ReactMarkdown>
      </div>
      {node.status === 'stopped' && (
        <p className="mt-3 text-small text-warning">已停止，已生成的内容仍被保留。</p>
      )}
      {node.status === 'failed' && (
        <p className="mt-3 text-small text-danger">回答生成失败，过程记录仍可查看。</p>
      )}
    </section>
  )
}

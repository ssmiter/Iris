import { memo } from 'react'
import type { AnswerNode } from '@/domain/chat/models'
import { useChatStore } from '@/stores/chatStore'
import { useReveal } from '@/motion/useReveal'
import { IncrementalMarkdown } from './IncrementalMarkdown'

interface AnswerBlockProps {
  node: AnswerNode
}

export const AnswerBlock = memo(function AnswerBlock({ node }: AnswerBlockProps) {
  const isFinal = node.role === 'final'
  const streaming = node.status === 'streaming'
  const visibleContent = useReveal(node.content, streaming)
  const revealing = streaming || visibleContent !== node.content

  const turnStopped = useChatStore(
    (state) => node.turnId != null
      && state.turnsById[node.turnId]?.phase === 'stopped',
  )
  const runCancelled = useChatStore(
    (state) => node.runId != null
      && state.runsById[node.runId]?.phase === 'cancelled',
  )
  const roundStopped = useChatStore(
    (state) => node.roundId != null
      && state.roundsById[node.roundId]?.phase === 'stopped',
  )

  const hasContent = visibleContent.trim().length > 0
  const stoppedByParent = turnStopped || runCancelled || roundStopped
  const showStoppedEyebrow = hasContent
    && (node.status === 'stopped' || stoppedByParent)

  return (
    <section
      className="mt-2.5 min-w-0 text-body text-ink"
      aria-label={isFinal ? 'Iris 的回答' : '阶段结论'}
      aria-busy={revealing}
    >
      {!isFinal && (
        <div className="mb-1.5 flex items-center gap-2 text-caption text-ink-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
          阶段结论
        </div>
      )}
      <div className="answer-prose prose prose-sm max-w-none text-ink">
        <IncrementalMarkdown content={visibleContent} />
      </div>
      {showStoppedEyebrow && (
        <div
          className="mt-2 flex items-center gap-1.5 text-caption text-warning"
          role="status"
        >
          <span
            className="h-1.5 w-1.5 rounded-full bg-warning"
            aria-hidden="true"
          />
          输出已停止
        </div>
      )}
      {node.status === 'failed' && (
        <p className="mt-3 text-small text-danger">
          回答生成失败，过程记录仍可查看。
        </p>
      )}
    </section>
  )
})

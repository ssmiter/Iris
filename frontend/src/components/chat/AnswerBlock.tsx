import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { AnswerNode } from '@/domain/chat/models'
import { useChatStore } from '@/stores/chatStore'
import { useReveal } from '@/motion/useReveal'
import { Button } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Tooltip'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'
import { IncrementalMarkdown } from './IncrementalMarkdown'
import { formatStreamingMarkdown, normalizeMarkdown } from '@/utils/markdownNormalizer'

interface AnswerBlockProps {
  node: AnswerNode
}

export const AnswerBlock = memo(function AnswerBlock({ node }: AnswerBlockProps) {
  const isFinal = node.role === 'final'
  const streaming = node.status === 'streaming'
  const visibleContent = useReveal(node.content, streaming)
  const revealing = streaming || visibleContent !== node.content

  const [copied, setCopied] = useState(false)
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(visibleContent)
      setCopied(true)
    } catch {
      // 静默失败，避免误导
    }
  }, [visibleContent])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

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

  const renderContent = useMemo(() => {
    return streaming
      ? formatStreamingMarkdown(visibleContent)
      : normalizeMarkdown(visibleContent)
  }, [streaming, visibleContent])

  return (
    <section
      className="group relative mt-2.5 min-w-0 text-body text-ink"
      aria-label={isFinal ? 'Iris 的回答' : '阶段性回答'}
      aria-busy={revealing}
    >
      {hasContent && (
        <Tooltip content={copied ? '已复制' : '复制回答'}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'absolute -top-1 -right-1 z-10 h-8 w-8 rounded-xs p-0',
              'opacity-0 transition-opacity duration-fast ease-standard',
              'group-hover:opacity-100 focus-visible:opacity-100',
              'motion-reduce:transition-none',
              copied && 'text-success',
            )}
            onClick={handleCopy}
          >
            {copied
              ? (
                  <Check size={16} aria-hidden="true" />
                )
              : (
                  <Copy size={16} aria-hidden="true" />
                )}
            <span className="sr-only">{copied ? '已复制' : '复制回答'}</span>
          </Button>
        </Tooltip>
      )}
      <div className="answer-prose prose prose-sm max-w-none text-ink">
        <IncrementalMarkdown content={renderContent} streaming={streaming} />
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

import { memo, useState } from 'react'
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  CircleEllipsis,
  FileText,
  GitBranch,
  MessageSquareMore,
  Wrench,
  X,
} from 'lucide-react'
import type {
  AttentionAction,
  AttentionNode,
  RenderNode,
} from '@/domain/chat/models'
import { Button } from '@/components/ui'
import { cn } from '@/lib/cn'
import { ArtifactCard } from './ArtifactCard'
import { BrowserScreenshotPreview } from './BrowserScreenshotPreview'

interface FlowNodeProps {
  node: RenderNode
  expanded: boolean
  onToggle: () => void
  /** 链上第一个节点：来路线段收成短桩，不再向上伸进虚空 */
  isFirst: boolean
  /** 链上最后一个节点：去路线段渐隐到透明，给链条一个收尾 */
  isLast: boolean
  /** 回合活跃且过程区可见：此时挂载的新节点播出生动画（线段生长+淡入微升） */
  chainLive: boolean
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
}

/**
 * 已播过出生动画的节点（会话级，不持久化）。
 * Virtuoso 会回收/重建 DOM，靠这个集合防止回滚再滚回时动画重放；
 * 历史水合时回合已 settled（chainLive=false），根本不会入册。
 */
const bornNodeIds = new Set<string>()

const nodeIcon = {
  thinking: Brain,
  tool: Wrench,
  attention: AlertTriangle,
  artifact: FileText,
  answer: MessageSquareMore,
  supplement: CircleEllipsis,
  run: GitBranch,
} satisfies Record<RenderNode['type'], typeof Brain>

function isActive(node: RenderNode) {
  return (
    node.status === 'running' ||
    node.status === 'streaming' ||
    node.status === 'waiting' ||
    node.status === 'verifying'
  )
}

function isFailed(node: RenderNode) {
  return (
    node.status === 'failed' ||
    node.status === 'outcome_unknown' ||
    node.status === 'unavailable'
  )
}

function nodeTitle(node: RenderNode) {
  switch (node.type) {
    case 'thinking':
      return '分析与判断'
    case 'tool':
      return node.toolName
    case 'attention':
      return node.subtype === 'approval' ? '需要你确认' : '需要你的输入'
    case 'artifact':
      return node.title
    case 'answer':
      return node.role === 'final' ? '最终回答' : '阶段结论'
    case 'supplement':
      return '已收到补充'
    case 'run':
      return node.label
  }
}

function statusText(node: RenderNode) {
  const labels: Record<string, string> = {
    queued: '排队中',
    accepted: '已接受',
    running: '进行中',
    streaming: '生成中',
    verifying: '验证中',
    waiting: '等待处理',
    completed: '已完成',
    succeeded: '已完成',
    available: '可查看',
    injected: '已注入',
    promoted: '已升格',
    resolved: '已处理',
    superseded: '已有新版本',
    suspended: '已暂停',
    stopped: '已停止',
    cancelled: '已取消',
    expired: '已过期',
    failed: '失败',
    unavailable: '不可用',
    outcome_unknown: '结果待核实',
  }
  return labels[node.status] ?? node.status
}

function NodeBody({
  node,
  expanded,
  onAttentionAction,
}: Pick<FlowNodeProps, 'node' | 'expanded' | 'onAttentionAction'>) {
  switch (node.type) {
    case 'thinking':
      return (
        <div className="space-y-2">
          <p>{node.summary}</p>
          {node.detailRef && (
            <p className="text-caption text-ink-muted">
              详细记录可按需读取 · {node.detailRef}
            </p>
          )}
        </div>
      )
    case 'tool':
      return (
        <div className="space-y-2">
          <p>{node.summary}</p>
          {node.evidenceSummary &&
            node.evidenceSummary !== node.summary && (
            <p className="rounded-xs bg-surface-muted px-3 py-2 text-small">
              {node.evidenceSummary}
            </p>
            )}
          {node.resultRef && (
            <p className="font-mono text-caption text-ink-muted">
              result: {node.resultRef}
            </p>
          )}
          {expanded && node.preview?.kind === 'browser_screenshot' && (
            <BrowserScreenshotPreview preview={node.preview} />
          )}
        </div>
      )
    case 'attention':
      return (
        <div className="rounded-sm border border-warning/30 bg-warning-soft p-3">
          <p className="font-medium text-warning-foreground">{node.impact}</p>
          {node.status === 'waiting' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {node.actions.map((action) => (
                <Button
                  key={action.id}
                  size="sm"
                  variant={action.tone}
                  onClick={() => onAttentionAction?.(node, action)}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-small text-ink-subtle">
              此请求已经结束，历史影响陈述仍被保留。
            </p>
          )}
        </div>
      )
    case 'artifact':
      return <ArtifactCard node={node} />
    case 'answer':
      return <p>回答节点固定显示在过程摘要下方。</p>
    case 'supplement':
      return (
        <p className="rounded-full bg-primary-soft px-3 py-1.5 text-small text-primary">
          “{node.text}”
        </p>
      )
    case 'run':
      return (
        <div className="space-y-1">
          <p>{node.progressSummary}</p>
          <p className="font-mono text-caption text-ink-muted">
            child run · {node.childRunId}
          </p>
        </div>
      )
  }
}

export const FlowNode = memo(function FlowNode({
  node,
  expanded,
  onToggle,
  isFirst,
  isLast,
  chainLive,
  onAttentionAction,
}: FlowNodeProps) {
  const Icon = nodeIcon[node.type]
  const active = isActive(node)
  const failed = isFailed(node)
  // 水流语义：执行到达过本节点，则来路/去路线段染色（queued 是唯一"未到达"态）。
  // 已到达的连续染色在活跃节点的呼吸点处收束，形成"水流前沿"。
  const reached = node.status !== 'queued'
  // 出生动画只在挂载瞬间判定一次：回合活跃 + 过程区可见 + 此前未播过。
  // 折叠挂载（用户尚未展开）不播也不入册，展开靠容器自身的 grid-rows 展开动画。
  const [born] = useState(() => {
    if (!chainLive || bornNodeIds.has(node.nodeId)) return false
    bornNodeIds.add(node.nodeId)
    if (bornNodeIds.size > 4096) {
      const oldest = bornNodeIds.values().next().value
      if (oldest) bornNodeIds.delete(oldest)
    }
    return true
  })
  const bodyId = `flow-node-body-${node.nodeId}`

  return (
    <div className="relative grid grid-cols-[20px_minmax(0,1fr)] gap-2">
      <div className="flex flex-col items-center" aria-hidden="true">
        <span
          className={cn(
            'w-px',
            isFirst ? 'h-2 flex-none' : 'flex-1',
            reached
              ? failed
                ? 'bg-danger/20'
                : 'bg-primary/15'
              : 'bg-border',
            born && !isFirst &&
              'origin-top animate-seg-grow motion-reduce:animate-none',
          )}
        />
        <span
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded-full border bg-surface',
            active && 'border-primary text-primary',
            failed && 'border-danger text-danger',
            !active && !failed && reached && 'border-primary/40 text-primary',
            !active && !failed && !reached &&
              'border-border-strong text-ink-muted',
          )}
        >
          {active ? (
            <span className="h-1.5 w-1.5 animate-soft-pulse rounded-full bg-current motion-reduce:animate-none" />
          ) : failed ? (
            <X className="h-3 w-3" />
          ) : (
            <Check className="h-3 w-3" />
          )}
        </span>
        <span
          className={cn(
            'w-px flex-1',
            isLast
              ? reached
                ? 'bg-gradient-to-b from-primary/15 to-transparent'
                : 'bg-gradient-to-b from-border to-transparent'
              : reached
                ? failed
                  ? 'bg-danger/20'
                  : 'bg-primary/15'
                : 'bg-border',
          )}
        />
      </div>

      <div
        className={cn(
          'min-w-0 py-1',
          born && 'animate-node-enter motion-reduce:animate-none',
        )}
      >
        <button
          type="button"
          className={cn(
            'flex min-h-9 w-full items-center gap-2 rounded-sm px-2 text-left',
            'transition-[color,background-color,transform,opacity] duration-fast ease-standard',
            'hover:bg-surface-muted active:scale-[0.995] active:bg-surface-muted active:opacity-80',
            'focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none',
          )}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <Icon
            aria-hidden="true"
            className={cn(
              'h-4 w-4 shrink-0 text-ink-muted',
              active && 'text-ink-subtle',
              failed && 'text-danger',
            )}
          />
          <span className="min-w-0 flex-1 truncate text-small font-medium text-ink-subtle">
            {nodeTitle(node)}
          </span>
          <span
            className={cn(
              'shrink-0 text-caption text-ink-muted',
              active && 'text-ink-subtle',
              failed && 'text-danger',
            )}
          >
            {statusText(node)}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform duration-deliberate ease-flow',
              expanded && 'rotate-90',
              'motion-reduce:transition-none',
            )}
          />
        </button>
        <div
          id={bodyId}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-fold ease-flow',
            expanded
              ? 'grid-rows-[1fr] opacity-100'
              : 'grid-rows-[0fr] opacity-0',
            'motion-reduce:transition-none',
          )}
        >
          <div className="overflow-hidden">
            <div className="px-2 pb-3 pt-1 text-small text-ink-subtle">
              <NodeBody
                node={node}
                expanded={expanded}
                onAttentionAction={onAttentionAction}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}, (previous, next) => (
  previous.node === next.node
  && previous.expanded === next.expanded
  && previous.isFirst === next.isFirst
  && previous.isLast === next.isLast
  && previous.chainLive === next.chainLive
  && previous.onAttentionAction === next.onAttentionAction
))

import {
  AlertTriangle,
  Box,
  Brain,
  Check,
  ChevronRight,
  CircleEllipsis,
  FileText,
  GitBranch,
  LoaderCircle,
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

interface FlowNodeProps {
  node: RenderNode
  expanded: boolean
  onToggle: () => void
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
}

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
  onAttentionAction,
}: Pick<FlowNodeProps, 'node' | 'onAttentionAction'>) {
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
          {node.evidenceSummary && (
            <p className="rounded-xs bg-surface-muted px-3 py-2 text-small">
              {node.evidenceSummary}
            </p>
          )}
          {node.resultRef && (
            <p className="font-mono text-caption text-ink-muted">
              result: {node.resultRef}
            </p>
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
      return (
        <div className="flex items-center gap-3 rounded-sm border border-border bg-surface-raised p-3">
          <Box aria-hidden="true" className="h-5 w-5 text-primary" />
          <div className="min-w-0">
            <p className="truncate font-medium text-ink">{node.title}</p>
            <p className="text-caption text-ink-muted">
              {node.kind} · 预览将在产物视图中打开
            </p>
          </div>
        </div>
      )
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

export function FlowNode({
  node,
  expanded,
  onToggle,
  onAttentionAction,
}: FlowNodeProps) {
  const Icon = nodeIcon[node.type]
  const active = isActive(node)
  const failed = isFailed(node)
  const bodyId = `flow-node-body-${node.nodeId}`

  return (
    <div className="relative grid grid-cols-[20px_minmax(0,1fr)] gap-2">
      <div className="flex flex-col items-center" aria-hidden="true">
        <span className="w-px flex-1 bg-border" />
        <span
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded-full border bg-surface',
            active && 'border-primary text-primary',
            failed && 'border-danger text-danger',
            !active && !failed && 'border-border-strong text-ink-muted',
          )}
        >
          {active ? (
            <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" />
          ) : failed ? (
            <X className="h-3 w-3" />
          ) : (
            <Check className="h-3 w-3" />
          )}
        </span>
        <span className="w-px flex-1 bg-border" />
      </div>

      <div className="min-w-0 py-1">
        <button
          type="button"
          className={cn(
            'flex min-h-9 w-full items-center gap-2 rounded-sm px-2 text-left',
            'transition-colors duration-fast hover:bg-surface-muted',
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
              active && 'text-primary',
              failed && 'text-danger',
            )}
          />
          <span className="min-w-0 flex-1 truncate text-small font-medium text-ink-subtle">
            {nodeTitle(node)}
          </span>
          <span
            className={cn(
              'shrink-0 text-caption text-ink-muted',
              active && 'text-primary',
              failed && 'text-danger',
            )}
          >
            {statusText(node)}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform duration-normal',
              expanded && 'rotate-90',
              'motion-reduce:transition-none',
            )}
          />
        </button>
        <div
          id={bodyId}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-normal ease-standard',
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
                onAttentionAction={onAttentionAction}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

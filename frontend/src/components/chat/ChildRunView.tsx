import { useEffect, useMemo, useState } from 'react'
import { GitBranch } from 'lucide-react'
import type {
  AttentionAction,
  AttentionNode,
  RunPhase,
  RunView,
} from '@/domain/chat/models'
import { Badge, Button, Modal } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useChatStore } from '@/stores/chatStore'
import { useViewStateStore } from '@/stores/viewStateStore'
import { RunSection } from './RunSection'

/**
 * 子 agent Run 的前端投影（docs/33 §4）。
 * 数据早已在 runsById/roundsById/renderNodesById 中（child Run 与父共享
 * conversation/branch/turn，SSE 事件全量进入 store），这里只做渲染，
 * 不引入任何新 API；完整视图复用 RunSection/RoundSection 时间线组件，
 * 不造第二套渲染器。
 */

const TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set([
  'succeeded',
  'failed',
  'cancelled',
])

export function isTerminalRunPhase(phase: RunPhase) {
  return TERMINAL_PHASES.has(phase)
}

const phaseMeta: Record<
  RunPhase,
  { label: string; tone: 'info' | 'success' | 'warning' | 'danger' | 'neutral'; breathing: boolean }
> = {
  accepted: { label: '已接受', tone: 'info', breathing: true },
  running: { label: '进行中', tone: 'info', breathing: true },
  // 挂起=在等审批：保持可见但静止，PendingApprovalStack 才是真正的注意力锚
  suspended: { label: '等待审批', tone: 'warning', breathing: false },
  verifying: { label: '验证中', tone: 'info', breathing: true },
  outcome_unknown: { label: '结果待核实', tone: 'warning', breathing: false },
  succeeded: { label: '已完成', tone: 'success', breathing: false },
  failed: { label: '失败', tone: 'danger', breathing: false },
  cancelled: { label: '已取消', tone: 'neutral', breathing: false },
}

function formatRunElapsed(run: RunView) {
  const start = new Date(run.startedAt).getTime()
  const end = run.endedAt ? new Date(run.endedAt).getTime() : Date.now()
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function runStatsText(run: RunView) {
  const counts = run.closure?.counts
  const rounds = counts?.rounds ?? run.roundIds.length
  const tools = counts?.toolCalls
  return [
    `${rounds} 轮`,
    tools != null ? `${tools} 个工具` : null,
    formatRunElapsed(run),
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * 完整子运行视图：Modal + RunSection，展开状态为对话框局部
 * （打开时继承全局已播种的展开节点——审批等待/失败节点依旧自动展开），
 * 不污染主时间线的折叠状态。
 */
export function ChildRunDialog({
  runId,
  open,
  onOpenChange,
  onAttentionAction,
}: {
  runId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
}) {
  const run = useChatStore((state) =>
    runId ? state.runsById[runId] : undefined,
  )
  const roundsById = useChatStore((state) => state.roundsById)
  const nodesById = useChatStore((state) => state.renderNodesById)
  const [expandedRoundIds, setExpandedRoundIds] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const [expandedNodeIds, setExpandedNodeIds] = useState<ReadonlySet<string>>(
    new Set(),
  )

  // 每次打开重置局部展开状态，并继承全局视野里已播种的展开节点
  useEffect(() => {
    if (!open) return
    setExpandedRoundIds(new Set())
    setExpandedNodeIds(
      new Set(Object.keys(useViewStateStore.getState().expandedNodeIds)),
    )
  }, [open, runId])

  if (!runId) return null
  const meta = run ? phaseMeta[run.phase] : undefined

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={run?.purpose ?? '子运行'}
      description={
        run && meta ? (
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={meta.tone} showDot={meta.breathing}>
              {meta.label}
            </Badge>
            <span>{runStatsText(run)}</span>
          </span>
        ) : undefined
      }
    >
      {run ? (
        <RunSection
          run={run}
          roundsById={roundsById}
          nodesById={nodesById}
          expandedRoundIds={expandedRoundIds}
          expandedNodeIds={expandedNodeIds}
          onToggleRound={(roundId, nodeIds) => {
            setExpandedRoundIds((current) => {
              const next = new Set(current)
              if (next.has(roundId)) {
                next.delete(roundId)
                return next
              }
              next.add(roundId)
              setExpandedNodeIds((nodes) => {
                const merged = new Set(nodes)
                for (const nodeId of nodeIds) merged.add(nodeId)
                return merged
              })
              return next
            })
          }}
          onToggleNode={(nodeId) => {
            setExpandedNodeIds((current) => {
              const next = new Set(current)
              if (next.has(nodeId)) {
                next.delete(nodeId)
              } else {
                next.add(nodeId)
              }
              return next
            })
          }}
          onRevealNewRoundNodes={(roundId, nodeIds) => {
            if (!expandedRoundIds.has(roundId)) return
            setExpandedNodeIds((current) => {
              const next = new Set(current)
              for (const nodeId of nodeIds) next.add(nodeId)
              return next
            })
          }}
          onAttentionAction={onAttentionAction}
        />
      ) : (
        <p className="text-small text-ink-muted">
          该子运行的投影不在当前视野中，可能属于其他对话。
        </p>
      )}
    </Modal>
  )
}

/**
 * 主时间线中 delegate_task 节点展开后的子运行摘要卡。
 * 直接订阅 store（绕过 FlowNode 的 memo 比较器），
 * 子运行有事件推进时卡片自身重渲染。
 */
export function ChildRunCard({
  childRunId,
  fallbackSummary,
  onAttentionAction,
}: {
  childRunId: string
  fallbackSummary: string
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
}) {
  const run = useChatStore((state) => state.runsById[childRunId])
  const [viewerOpen, setViewerOpen] = useState(false)

  if (!run) {
    // 投影缺失时退化为纯文本摘要，不阻断时间线
    return (
      <div className="space-y-1">
        <p>{fallbackSummary}</p>
        <p className="font-mono text-caption text-ink-muted">
          child run · {childRunId}
        </p>
      </div>
    )
  }

  const meta = phaseMeta[run.phase]

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={meta.tone} showDot={meta.breathing}>
          {meta.label}
        </Badge>
        <span className="text-caption text-ink-muted">
          {runStatsText(run)}
        </span>
      </div>
      {run.progressSummary && <p>{run.progressSummary}</p>}
      {run.failure && (
        <p className="text-small text-danger">{run.failure.userMessage}</p>
      )}
      <div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-caption"
          onClick={() => setViewerOpen(true)}
        >
          查看完整运行
        </Button>
      </div>
      <ChildRunDialog
        runId={childRunId}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        onAttentionAction={onAttentionAction}
      />
    </div>
  )
}

/**
 * ComposerDock 上方的运行中胶囊条：只列出当前会话仍未终态的子 Run，
 * 执行中呼吸点锚定注意力，挂起静止，终态即消失（docs/33 §4 唯一新动效）。
 */
export function ChildRunCapsules({
  onAttentionAction,
}: {
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
}) {
  const runsById = useChatStore((state) => state.runsById)
  const [viewerRunId, setViewerRunId] = useState<string | null>(null)

  const liveChildren = useMemo(
    () =>
      Object.values(runsById)
        .filter(
          (run) => run.parentRunId !== null && !isTerminalRunPhase(run.phase),
        )
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    [runsById],
  )

  if (liveChildren.length === 0) return null

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 px-1 pb-2">
        <GitBranch
          aria-hidden="true"
          className="h-3.5 w-3.5 text-ink-muted"
        />
        {liveChildren.map((run) => {
          const meta = phaseMeta[run.phase]
          return (
            <button
              key={run.runId}
              type="button"
              className={cn(
                'inline-flex max-w-64 items-center gap-1.5 rounded-full border border-border/70 bg-surface-raised/92 px-2.5 py-1',
                'text-caption text-ink-subtle shadow-hairline backdrop-blur-md',
                'transition-[color,background-color,transform] duration-fast ease-standard',
                'hover:bg-surface-muted active:scale-[0.98]',
                'focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none',
              )}
              onClick={() => setViewerRunId(run.runId)}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  meta.tone === 'info' && 'bg-primary',
                  meta.tone === 'warning' && 'bg-warning',
                  meta.breathing &&
                    'animate-soft-pulse motion-reduce:animate-none',
                )}
              />
              <span className="truncate">{run.purpose}</span>
              <span className="shrink-0 text-ink-muted">{meta.label}</span>
            </button>
          )
        })}
      </div>
      <ChildRunDialog
        runId={viewerRunId}
        open={viewerRunId !== null}
        onOpenChange={(open) => {
          if (!open) setViewerRunId(null)
        }}
        onAttentionAction={onAttentionAction}
      />
    </>
  )
}

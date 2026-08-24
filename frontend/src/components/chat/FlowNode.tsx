import { createContext, memo, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
} from 'lucide-react'
import type {
  AttentionAction,
  AttentionNode,
  RenderNode,
} from '@/domain/chat/models'
import { Badge, Button } from '@/components/ui'
import { Tooltip } from '@/components/ui/Tooltip'
import { cn } from '@/lib/cn'
import { riskMeta } from '@/domain/capability/riskMeta'
import { ArtifactCard } from './ArtifactCard'
import { ChildRunCard } from './ChildRunView'
import { ClampText } from './ClampText'
import { ToolResultText } from './ToolResultText'
import { useChatStore } from '@/stores/chatStore'

interface FlowNodeProps {
  node: RenderNode
  expanded: boolean
  onToggle: () => void
  /** 链上第一个节点：来路线段收成短桩，不再向上伸进虚空 */
  isFirst: boolean
  /** 链上最后一个节点：去路线段渐隐到透明，给链条一个收尾 */
  isLast: boolean
  /** 前序节点已沉淀（完成/失败/取消）：来路线段染淡主色，形成"水流过"的进度感 */
  segFlowed: boolean
  /** 回合活跃且过程区可见：此时挂载的新节点播出生动画（线段生长+淡入微升） */
  chainLive: boolean
  onAttentionAction?: (
    node: AttentionNode,
    action: AttentionAction,
  ) => void
  onOpenChildRun?: (runId: string) => void
}

/**
 * 已播过出生动画的节点（会话级，不持久化）。
 * Virtuoso 会回收/重建 DOM，靠这个集合防止回滚再滚回时动画重放；
 * 历史水合时回合已 settled（chainLive=false），根本不会入册。
 */
const bornNodeIds = new Set<string>()

interface StallContextValue {
  lastEventAt: string | null
  now: number
}

const StallContext = createContext<StallContextValue>({
  lastEventAt: null,
  now: Date.now(),
})

/** 会话级停滞检测：Provider 持有唯一 1s interval，仅活跃节点消费上下文。 */
export function StallProvider({ children }: { children: ReactNode }) {
  const lastEventAt = useChatStore((state) => state.lastEventAt)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  // value 记忆化：否则每次 Provider 渲染都产生新对象，
  // 所有 StallBanner 消费者跟着白渲染（流式期间 20Hz）
  const value = useMemo(() => ({ lastEventAt, now }), [lastEventAt, now])
  return (
    <StallContext.Provider value={value}>
      {children}
    </StallContext.Provider>
  )
}

function useStall() {
  return useContext(StallContext)
}

/**
 * 脊柱轨道（WonWork wf-rail 同构）：来路段 → 状态点 → 去路段。
 * 点线同轴由 flex column + items-center 保证；轨道贯穿节点全高（含展开体），
 * 去路段随节点体延伸，链条视觉连续不断。
 */
function Spine({
  node,
  isFirst,
  isLast,
  segFlowed,
  born,
}: {
  node: RenderNode
  isFirst: boolean
  isLast: boolean
  segFlowed: boolean
  born: boolean
}) {
  const active = isActive(node)
  const failed = isFailed(node)
  const settled = !active

  // 来路段：活跃节点渐变（上淡下浓），前序沉淀染淡主色，否则常规发丝线
  const segUpClass = active
    ? 'bg-gradient-to-b from-primary/15 to-primary/45'
    : segFlowed
      ? 'bg-primary/15'
      : 'bg-border'

  // 状态点：活跃=白底主色描边+光环呼吸；等待处理=警告色光环；
  // 失败=白底红描边；其余=柔色实心点（WonWork 终态染色同款）
  const attentionWaiting = node.type === 'attention' && node.status === 'waiting'
  const dotClass = attentionWaiting
    ? 'border-warning bg-canvas motion-safe:animate-halo-warn'
    : active
      ? 'border-primary bg-canvas motion-safe:animate-halo'
      : failed
        ? 'border-danger bg-canvas'
        : 'border-transparent bg-ink-muted'

  // 去路段：本节点沉淀后染淡主色；末节点渐隐收尾
  const segDownClass = isLast
    ? settled && !failed
      ? 'bg-gradient-to-b from-primary/15 to-transparent'
      : 'bg-gradient-to-b from-border to-transparent'
    : settled && !failed
      ? 'bg-primary/15'
      : 'bg-border'

  return (
    <div aria-hidden="true" className="flex w-5 shrink-0 flex-col items-center">
      <span
        className={cn(
          'w-0.5 shrink-0 basis-3 rounded-full transition-colors duration-500',
          segUpClass,
          isFirst && 'invisible',
          born && !isFirst && 'origin-top animate-seg-grow motion-reduce:animate-none',
        )}
      />
      <span
        className={cn(
          'h-[9px] w-[9px] shrink-0 rounded-full border-[1.5px]',
          'transition-[background-color,border-color] duration-500 motion-reduce:transition-none',
          dotClass,
        )}
      />
      <span
        className={cn(
          'w-0.5 min-h-1.5 flex-1 rounded-full transition-colors duration-500',
          segDownClass,
        )}
      />
    </div>
  )
}

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

/** 节点已沉淀（不再处于活跃态）：前序沉淀时本节点来路段染淡主色（水流感） */
export function isFlowNodeSettled(node: RenderNode) {
  return !isActive(node)
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

function formatMs(durationMs: number) {
  if (durationMs < 1000) return `${durationMs}ms`
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s`
}

function statusText(node: RenderNode): React.ReactNode {
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
  const base = labels[node.status] ?? node.status
  // 思考节点后端喂了 durationMs，完成时把耗时带上（WonWork 节点耗时同款）
  if (
    node.type === 'thinking'
    && node.status === 'completed'
    && node.durationMs != null
  ) {
    return `${base}，${formatMs(node.durationMs)}`
  }
  // tool 节点 meta：状态，mono 耗时，摘要首行摘录
  if (node.type === 'tool') {
    const duration =
      node.durationMs != null && node.durationMs > 0
        ? `${(node.durationMs / 1000).toFixed(1)}s`
        : null
    const excerpt =
      node.status !== 'running' && node.summary
        ? node.summary.split('\n')[0].slice(0, 40)
        : null
    return (
      <>
        {base}
        {duration && (
          <>
            {'，'}
            <span className="font-mono tabular-nums">{duration}</span>
          </>
        )}
        {excerpt && (
          <>
            {'，'}
            <span className="truncate">{excerpt}</span>
          </>
        )}
      </>
    )
  }
  return base
}

/**
 * 审批/澄清卡。两阶段退场（WonWork ghost 的克制版）：
 * 点击后按钮区立刻淡出禁用（决定已提交，不瞬消），
 * 后端 resolved 推送到达后整卡切换为保留说明（淡入）。
 * 4s 未收到 resolved 视为提交失败，按钮恢复可点。
 */
function AttentionBody({
  node,
  onAttentionAction,
}: {
  node: AttentionNode
  onAttentionAction?: FlowNodeProps['onAttentionAction']
}) {
  const [acting, setActing] = useState(false)

  useEffect(() => {
    if (!acting) return
    const timer = setTimeout(() => setActing(false), 4000)
    return () => clearTimeout(timer)
  }, [acting])

  return (
    <div className="rounded-sm border border-warning/30 bg-warning-soft p-3">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 font-medium text-warning-foreground">
          {node.impact}
        </p>
        {node.approval && (
          <Badge tone={riskMeta(node.approval.riskLevel).tone}>
            {riskMeta(node.approval.riskLevel).label}
          </Badge>
        )}
      </div>
      {node.status === 'waiting' ? (
        <div
          className={cn(
            'mt-3 flex flex-wrap gap-2 transition-opacity duration-fast motion-reduce:transition-none',
            acting && 'pointer-events-none opacity-40',
          )}
        >
          {node.actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant={action.tone}
              onClick={() => {
                setActing(true)
                onAttentionAction?.(node, action)
              }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : (
        <p className="mt-2 animate-overlay-in text-small text-ink-subtle motion-reduce:animate-none">
          {node.subtype === 'clarification' && node.input?.answer
            ? `已选择：${node.input.answer}`
            : '此请求已经结束，历史影响陈述仍被保留。'}
        </p>
      )}
    </div>
  )
}

/**
 * 工具入参单行摘要：紧凑 JSON，120 字截断，可点击展开（无动画）。
 * WonWork ArgsLine 的 Iris 等价物，使用 surface-muted + mono 字体。
 */
function ArgsLine({ args }: { args: string }) {
  const [expanded, setExpanded] = useState(false)
  const truncated = args.length > 120
  const display = truncated && !expanded ? `${args.slice(0, 120)}…` : args
  return (
    <Tooltip content={truncated ? (expanded ? '点击收起' : '点击展开') : undefined}>
      <div
        className={cn(
          'rounded-xs bg-surface-muted px-3 py-2 font-mono text-caption text-ink-subtle',
          truncated && 'cursor-pointer',
        )}
        onClick={truncated ? () => setExpanded((v) => !v) : undefined}
      >
        <span className="break-all">{display}</span>
        {truncated && (
          expanded
            ? (
                <ChevronUp
                  aria-hidden="true"
                  className="ml-1 inline h-3.5 w-3.5 align-text-bottom text-ink-muted"
                />
              )
            : (
                <ChevronDown
                  aria-hidden="true"
                  className="ml-1 inline h-3.5 w-3.5 align-text-bottom text-ink-muted"
                />
              )
        )}
      </div>
    </Tooltip>
  )
}

/** 停滞横幅：会话级 SSE watchdog，30s 无新进展时静态提示。 */
function StallBanner() {
  const { lastEventAt, now } = useStall()
  if (!lastEventAt) return null
  const elapsed = Math.floor((now - new Date(lastEventAt).getTime()) / 1000)
  if (elapsed < 30) return null
  return (
    <div className="mt-2 rounded-xs border border-warning/30 bg-warning-soft px-3 py-2 text-caption text-warning-foreground">
      仍在执行，已 {elapsed}s 无新进展
    </div>
  )
}

function NodeBody({
  node,
  expanded,
  onAttentionAction,
  onOpenChildRun,
}: Pick<FlowNodeProps, 'node' | 'expanded' | 'onAttentionAction' | 'onOpenChildRun'>) {
  switch (node.type) {
    case 'thinking':
      return (
        <ClampText>
          <div className="space-y-2">
            <p>{node.summary}</p>
            {node.detailRef && (
              <p className="text-caption text-ink-muted">
                详细记录可按需读取：{node.detailRef}
              </p>
            )}
          </div>
        </ClampText>
      )
    case 'tool':
      return (
        <div className="space-y-2">
          {node.catalogPath && (
            <p className="text-caption text-ink-muted">{node.catalogPath}</p>
          )}
          {node.args && <ArgsLine args={node.args} />}
          <ClampText>
            <div className="space-y-2">
              <p>{node.summary}</p>
              {node.evidenceSummary &&
                node.evidenceSummary !== node.summary && (
                <p className="rounded-xs bg-surface-muted px-3 py-2 text-small">
                  {node.evidenceSummary}
                </p>
                )}
            </div>
          </ClampText>
          {node.resultRef && (
            <ToolResultText
              resultRef={node.resultRef}
              expanded={expanded}
              className="max-h-40 overflow-auto"
            />
          )}
        </div>
      )
    case 'attention':
      return (
        <AttentionBody node={node} onAttentionAction={onAttentionAction} />
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
      // 子 agent Run 摘要卡：直接订阅 store，自身随运行事件重渲染（M6b）
      return (
        <ChildRunCard
          childRunId={node.childRunId}
          fallbackSummary={node.progressSummary}
          onAttentionAction={onAttentionAction}
          onOpen={onOpenChildRun}
        />
      )
  }
}

export const FlowNode = memo(function FlowNode({
  node,
  expanded,
  onToggle,
  isFirst,
  isLast,
  segFlowed,
  chainLive,
  onAttentionAction,
  onOpenChildRun,
}: FlowNodeProps) {
  const active = isActive(node)
  const failed = isFailed(node)
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
    <div
      className={cn(
        'flex items-stretch',
        born && 'animate-node-enter motion-reduce:animate-none',
      )}
    >
      <Spine
        node={node}
        isFirst={isFirst}
        isLast={isLast}
        segFlowed={segFlowed}
        born={born}
      />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className={cn(
            'flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left',
            'transition-colors duration-fast ease-standard',
            'hover:bg-surface-muted/70',
            'focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none',
          )}
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-small',
              failed
                ? 'text-danger'
                : active
                  ? 'font-medium text-ink-subtle'
                  : 'text-ink-muted',
            )}
          >
            {nodeTitle(node)}
          </span>
          <span
            className={cn(
              'min-w-0 max-w-[50%] inline-block truncate text-caption',
              failed
                ? 'text-danger'
                : active
                  ? 'text-ink-subtle'
                  : 'text-ink-muted/80',
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
                onOpenChildRun={onOpenChildRun}
              />
              {chainLive && isActive(node) && <StallBanner />}
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
  && previous.segFlowed === next.segFlowed
  && previous.chainLive === next.chainLive
  && previous.onToggle === next.onToggle
  && previous.onAttentionAction === next.onAttentionAction
  && previous.onOpenChildRun === next.onOpenChildRun
))

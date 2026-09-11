import { memo, useState, useCallback, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { RenderNode, ThinkingNode, ToolNode, AttentionNode, AnswerNode, ChatMessage } from '@/types/chat'
import { cn } from '@/utils'
import { InlineTable, extractTableRows } from './InlineTable'
import { ClampController } from './ClampController'
import { useReveal } from './useTextReveal'
import { getToolRenderer, isResultPromoted } from '@/agent/tools/toolRenderRegistry'
import { formatToolDisplayName } from '@/utils/toolDisplayNames'
// 与 SubAgentFlow 相互 import（渲染期引用，模块初始化期不互调，详见该文件头注释）
import { SubAgentFlow, isSubAgentToolNode } from './SubAgentFlow'

/** Turn 级别阶段，由 WaterfallTurn 计算并传入 */
export type TurnPhase = 'active' | 'settling' | 'settled'

interface FlowNodeProps {
  node: RenderNode
  /** 当前 turn 的阶段（控制展开行为与 seg 颜色） */
  turnPhase: TurnPhase
  /** 此节点的来路段是否已"流过"（前序节点已完成），决定 seg-up 颜色 */
  segFlowed: boolean
  /** R4: 此节点是否被用户手动切换过（由父级从 ref 计算后传入 boolean，避免 Set 引用变化导致全体重渲染） */
  isOverridden: boolean
  /** 是否为整个脊柱的最后一个可视节点（跨越 FlowGroup 时不携带此标记） */
  isLastInFlow?: boolean
  onToggle: (nodeId: string) => void
  /** 接管浏览器回调 */
  onTakeover?: (nodeId: string) => void
  /** 跳过当前 attention 回调 */
  onSkipAttention?: (nodeId: string) => void
  /** 审批通过/拒绝回调 */
  onApprove?: (toolCallId: string) => void
  onReject?: (toolCallId: string) => void
  /** 已提升为产物卡的 toolCallId 集合（避免 ToolNode 内联表格与 ArtifactCard 重复展示） */
  promotedToolCallIds?: Set<string>
}

/**
 * 单个瀑布流节点渲染器（memo 优化减少跳动）。
 *
 * 视觉结构（与 prototype-v5 同构，由结构保证点线对齐）：
 *   wf-node
 *     wf-rail (flex column, 20px wide)
 *       wf-seg wf-seg-up   ← 来路段（可"流过"染色）
 *       wf-dot             ← 状态点
 *       wf-seg wf-seg-down ← 去路段
 *     wf-node-main
 *       wf-node-head (label / meta / toggle)
 *       wf-node-body (grid 0fr→1fr 折叠)
 *
 * 展开规则（纯手动模型）：
 * - 初始状态为挂载时的快照：运行中/等待/错误节点展开，其余折叠
 * - 此后折叠状态只由用户点击改变——流式状态变化、turn 阶段迁移均不再触碰
 */
export const FlowNode = memo(function FlowNode({
  node,
  turnPhase,
  segFlowed,
  isOverridden,
  isLastInFlow,
  onToggle,
  onTakeover,
  onSkipAttention,
  onApprove,
  onReject,
  promotedToolCallIds,
}: FlowNodeProps) {
  const { t } = useTranslation()
  const cls = statusClass(node)
  const userOverridden = isOverridden
  const autoShouldOpen = shouldAutoOpen(node, turnPhase)

  // 初始展开状态（挂载快照：此后折叠状态只由用户点击改变，流式状态变化不再触碰）
  const [open, setOpen] = useState(() =>
    userOverridden ? !autoShouldOpen : autoShouldOpen
  )

  // 出生动画：active 阶段新节点淡入（settled 阶段跳过）
  const [born, setBorn] = useState(turnPhase === 'active')
  useEffect(() => {
    if (turnPhase === 'active') {
      setBorn(true)
      const timer = setTimeout(() => setBorn(false), 520)
      return () => clearTimeout(timer)
    } else {
      setBorn(false)
    }
    return undefined
  }, [turnPhase])

  const handleToggle = useCallback(() => {
    setOpen((v) => !v)
    onToggle(node.id)
  }, [node.id, onToggle])

  return (
    <div
      className={cn('wf-node', cls, open && 'open', born && 'born')}
      data-nid={node.id}
      data-seg-flowed={segFlowed ? '' : undefined}
    >
      {/* 脊柱轨道：点线同轴由 flex column + align-items: center 保证 */}
      <div className="wf-rail">
        <span className="wf-seg wf-seg-up" />
        <span className="wf-dot" />
        <span className="wf-seg wf-seg-down" />
      </div>

      <div className="wf-node-main">
        <button
          className="wf-node-head"
          aria-expanded={open}
          onClick={handleToggle}
        >
          <span className="wf-node-label">{nodeLabel(node, t)}</span>
          <span className="wf-node-meta">{nodeMeta(node, t)}</span>
          <span className="wf-node-toggle">▾</span>
        </button>
        <div className="wf-node-body">
          <div className="wf-node-body-inner">
            <div className="wf-node-body-pad">
              {/* 子 Agent 派遣节点：折叠时子瀑布不挂载 DOM（真懒渲染，非 grid 0fr 视觉折叠） */}
              {isSubAgentToolNode(node) && !open
                ? null
                : nodeBody(node, { onTakeover, onSkipAttention, onApprove, onReject, promotedToolCallIds })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})

// ── helpers ──────────────────────────────────────────

function statusClass(node: RenderNode): string {
  // BUG-25: attention 按 status 区分视觉
  if (node.type === 'attention') {
    if (node.status === 'resolved') return 'attention resolved'
    if (node.status === 'skipped') return 'attention skipped'
    if (node.status === 'timeout') return 'attention timeout'
    if (node.status === 'cancelled') return 'attention cancelled'
    return 'attention'  // waiting
  }
  if (node.type === 'tool') {
    if (node.status === 'error') return 'error'
    if (node.status === 'cancelled') return 'cancelled'
    if (node.status === 'running') return 'active'
    return 'done'
  }
  if (node.type === 'answer') {
    if (node.status === 'error') return 'error'
    if (node.status === 'stopped') return 'cancelled'
    if (node.status === 'streaming') return 'active'
    return 'done'
  }
  if (node.type === 'thinking') {
    if (node.status === 'running') return 'active'
    return 'done'
  }
  return 'done'
}

/**
 * 判断节点是否应自动展开（考虑 turn 阶段）。
 *
 * 关键规则：active / settling 阶段，done 节点保持展开——
 * 不在每个节点单独折叠，由 turn 级 settling 统一控制视觉效果。
 * 这消除了"工具 running→done 立刻折叠、下一工具 queued→running 立刻展开"
 * 导致的页面反复跳动。
 */
function shouldAutoOpen(node: RenderNode, turnPhase: TurnPhase): boolean {
  // ── 子 Agent 派遣节点：全程默认闭合（2026-08-01 用户拍板）——
  // 运行中也不自动展开，围观子瀑布靠手动点击；进度经节点 meta 与 executionLog 透出 ──
  if (isSubAgentToolNode(node)) return false

  // ── 运行时节点：始终展开 ──
  if (node.type === 'tool' && node.status === 'running') return true
  if (node.type === 'thinking' && node.status === 'running') return true
  if (node.type === 'attention' && node.status === 'waiting') return true
  if (node.type === 'answer' && node.status === 'streaming') return true

  // ── 错误节点：始终展开（不沉默） ──
  if (node.type === 'tool' && node.status === 'error') return true
  if (node.type === 'answer' && node.status === 'error') return true

  // ── 已完成节点：active / settling 阶段保持展开 ──
  // （这是消除"反复开合"的关键：不在 turn 活跃期间折叠任何节点）
  if (turnPhase === 'active' || turnPhase === 'settling') {
    if (node.type === 'tool' && node.status === 'done') return true
    if (node.type === 'thinking' && node.status === 'done') return true
    if (node.type === 'answer' && node.status === 'done') return true
  }

  // ── settled 阶段：done 节点折叠（用户可通过摘要行展开过程区 + 手动展开） ──
  return false
}

function nodeLabel(node: RenderNode, t: (key: string, options?: Record<string, unknown>) => string): string {
  switch (node.type) {
    case 'thinking':
      return node.role === 'verify' ? t('chat.flowNode.kindVerify') : t('chat.flowNode.kindThinking')
    case 'tool':
      return formatToolDisplayName(node.toolName)
    case 'attention':
      return node.toolName ? formatToolDisplayName(node.toolName) : t('chat.flowNode.attentionNeedAction')
    case 'artifact':
      return node.title
    case 'answer':
      return t('chat.flowNode.kindAnswer')
  }
}

function nodeMeta(node: RenderNode, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (node.type === 'thinking') {
    if (node.durationMs != null) return `${(node.durationMs / 1000).toFixed(1)}s`
    return node.status === 'running' ? t('chat.flowNode.thinking') : ''
  }
  if (node.type === 'tool') {
    const parts: string[] = []
    if (node.status === 'running') parts.push(t('chat.flowNode.running'))
    else if (node.status === 'error') parts.push(t('chat.flowNode.failed'))
    else if (node.status === 'cancelled') parts.push(t('chat.flowNode.cancelled'))
    if (node.durationMs != null) parts.push(`${(node.durationMs / 1000).toFixed(1)}s`)
    // error 态不回显摘要——红盒（ToolBody wf-err-box）已装全文，meta 再塞是同一信息同屏重复
    if (node.summary && node.status !== 'running' && node.status !== 'error') {
      const short = node.summary.split('\n')[0].slice(0, 40)
      parts.push(short)
    }
    return parts.join(' · ')
  }
  if (node.type === 'attention') {
    // BUG-25: waiting 状态显示 elapsed，终态显示耗时
    if (node.durationMs != null) return `${(node.durationMs / 1000).toFixed(0)}s`
    if (node.status === 'waiting') {
      const elapsed = ((Date.now() - node.startedAt) / 1000).toFixed(0)
      return t('chat.flowNode.waiting', { elapsed })
    }
    return ''
  }
  if (node.type === 'answer') {
    if (node.status === 'streaming') return t('chat.flowNode.outputting')
    if (node.status === 'stopped') return t('chat.flowNode.stopped')
    if (node.status === 'error') return t('chat.flowNode.error')
    return ''
  }
  return ''
}

// ── body dispatch ────────────────────────────────────

interface BodyCallbacks {
  onTakeover?: (nodeId: string) => void
  onSkipAttention?: (nodeId: string) => void
  onApprove?: (toolCallId: string) => void
  onReject?: (toolCallId: string) => void
  promotedToolCallIds?: Set<string>
}

function nodeBody(node: RenderNode, cbs: BodyCallbacks): ReactNode {
  switch (node.type) {
    case 'thinking':
      return <ThinkingBody node={node} />
    case 'tool':
      // 子 Agent 派遣节点：嵌套同款子瀑布（任务书 + FlowNode 递归 + 真实终态页脚）
      if (isSubAgentToolNode(node)) return <SubAgentFlow node={node} />
      return <ToolBody node={node} promotedToolCallIds={cbs.promotedToolCallIds} />
    case 'attention':
      return <AttentionBody node={node} cbs={cbs} />
    case 'answer':
      return <AnswerBody node={node} />
    case 'artifact':
      return null
  }
}

function ThinkingBody({ node }: { node: ThinkingNode }) {
  if (!node.content) return null
  // 视觉时钟揭示：running 时连续生长，done 后追尾全量（历史水合直接全量，不重放）
  return (
    <ThinkingReveal text={node.content} isActive={node.status === 'running'} />
  )
}

/** 思考内容的流式揭示包装器（平滑由视觉时钟保证，不再依赖逐字 span） */
function ThinkingReveal({ text, isActive }: { text: string; isActive: boolean }) {
  const visible = useReveal(text, isActive)
  const steps = visible.split('\n').filter(Boolean)
  if (steps.length === 0) return null

  return (
    <ClampController maxHeight={148}>
      <div className="wf-think-stream">
        {steps.map((s, i) => (
          <div key={i} className="wf-step">
            {s}
          </div>
        ))}
      </div>
    </ClampController>
  )
}

/** 从 ToolNode id 中提取 toolCallId（id 格式: prefix:tool:<toolCallId>:seq） */
function extractToolCallId(nodeId: string): string | undefined {
  const m = nodeId.match(/:tool:(.+?):\d+$/)
  return m?.[1]
}

/**
 * 2026-07-31 渲染保真：注册表里有专属 resultRenderer 的工具（web_search/web_fetch/
 * webbridge 原语等），结果直接内联渲染在 ToolNode 体内，不再退化为裸摘要/表格。
 * 排除规则：
 * - promoteResult 条目（render_chart 等）由 WaterfallTurn.PromotedToolResult 提升到答案区
 * - present_artifact 由 extractFileCards 产物卡承接
 */
const INLINE_RENDERER_DENYLIST = new Set(['present_artifact'])

function ToolInlineResult({ node }: { node: ToolNode }) {
  const entry = getToolRenderer(node.toolName)
  if (!entry?.resultRenderer || isResultPromoted(node.toolName, node.result)) return null
  if (INLINE_RENDERER_DENYLIST.has(node.toolName)) return null
  const Renderer = entry.resultRenderer
  const message: ChatMessage = {
    id: `inline:${node.id}`,
    role: 'tool',
    content: node.summary,
    structuredData: node.result,
    toolCallName: node.toolName,
    toolCallStatus: node.status === 'error' ? 'error' : 'done',
  }
  return (
    <div style={{ marginTop: 8 }}>
      <Renderer message={message} argsText={node.args} />
    </div>
  )
}

/** 工具参数行：超 120 字符折叠，点击展开/收起全文。
 *  2026-07-31：不再重复 toolName 前缀（节点标题已是工具名，参数行只承担参数）。 */
function ArgsLine({ args }: { args: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const truncated = args.length > 120
  return (
    <div
      className="wf-args-line"
      style={truncated ? { cursor: 'pointer' } : undefined}
      title={truncated ? (expanded ? t('chat.flowNode.collapseArgs') : t('chat.flowNode.expandArgs')) : undefined}
      onClick={truncated ? () => setExpanded((v) => !v) : undefined}
    >
      {truncated && !expanded ? args.slice(0, 120) + '…' : args}
      {truncated && (
        <span style={{ marginLeft: 6, opacity: 0.6 }}>{expanded ? '▴' : '▾'}</span>
      )}
    </div>
  )
}

/** 导出给 SubAgentFlow 历史水合兜底用（无运行记录时退化为普通工具体） */
export function ToolBody({ node, promotedToolCallIds }: { node: ToolNode; promotedToolCallIds?: Set<string> }) {
  const { t } = useTranslation()
  const errorLines = node.status === 'error' && node.summary
    ? node.summary.split('\n').filter(Boolean)
    : []
  const errorMain = errorLines[0] || ''
  const errorHint = errorLines.slice(1).join(' ') || undefined

  const promoted = promotedToolCallIds?.has(extractToolCallId(node.id) || '')
  const hasInlineRenderer = node.status === 'done' && node.result != null
    && !!getToolRenderer(node.toolName)?.resultRenderer
    && !isResultPromoted(node.toolName, node.result)
    && !INLINE_RENDERER_DENYLIST.has(node.toolName)
  const rows = node.status === 'done' && node.result && !promoted && !hasInlineRenderer
    ? extractTableRows(node.result)
    : null

  return (
    <>
      {node.args && <ArgsLine args={node.args} />}
      {node.executionLog && (
        <ClampController maxHeight={160}>
          <div className="wf-log">{node.executionLog}</div>
        </ClampController>
      )}
      {/* 停滞提示（watchdog 30s 无进展） */}
      {node.status === 'running' && node.executionLog?.includes('等待较久') && (
        <div className="wf-stalled-banner">
          <span>{t('chat.flowNode.stalledBanner')}</span>
        </div>
      )}
      {node.status === 'error' && (
        <div className="wf-err-box">
          <div className="wf-err-title">{t('chat.flowNode.executionFailed')}</div>
          {/* 稳妥去重：日志盒（executionLog）已装错误全文时，红盒只留标题，不再重复原文 */}
          {!node.executionLog && <div>{errorMain || node.summary}</div>}
          {errorHint && (
            <div className="wf-err-hint">{t('chat.flowNode.errorHint', { hint: errorHint })}</div>
          )}
        </div>
      )}
      {promoted && (
        <div style={{ fontSize: 12.5, color: 'var(--wf-mut)', padding: '4px 0' }}>
          {t('chat.flowNode.resultInArtifacts')}
        </div>
      )}
      {hasInlineRenderer && <ToolInlineResult node={node} />}
      {rows && rows.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <InlineTable rows={rows} />
        </div>
      )}
      {node.status === 'done' && node.summary && !node.executionLog && !rows && !promoted && !hasInlineRenderer && (
        <div style={{ fontSize: 13, color: 'var(--wf-sub)' }}>{node.summary}</div>
      )}
    </>
  )
}

function AttentionBody({ node, cbs }: { node: AttentionNode; cbs: BodyCallbacks }) {
  const { t } = useTranslation()
  const subtype = node.subtype || 'approval'
  const isWaiting = node.status === 'waiting'

  if (subtype === 'takeover') {
    return (
      <div className="wf-browser-card">
        <div className="wf-browser-bar">
          <span className="wf-browser-dot" style={{ background: 'var(--wf-ok-ink)' }} />
          <span className="wf-browser-dot" />
          <span className="wf-browser-dot" />
          <div className="wf-browser-url">
            {node.toolName ? t('chat.flowNode.toolNeedsManualOperation', { toolName: formatToolDisplayName(node.toolName) }) : t('chat.flowNode.needsManualOperation')}
          </div>
        </div>
        <div className="wf-browser-stage">
          <div className="wf-browser-msg">
            <span>🔐</span>
            <span>{node.reason}</span>
          </div>
          {isWaiting && (
            <div className="wf-browser-actions">
              <button
                className="wf-btn wf-btn-primary"
                onClick={() => cbs.onTakeover?.(node.id)}
              >
                {t('chat.flowNode.takeoverBrowser')}
              </button>
              <button
                className="wf-btn"
                onClick={() => cbs.onSkipAttention?.(node.id)}
              >
                {t('chat.flowNode.skipContinue')}
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="wf-attention-card">
      <div className="wf-attention-stage">
        <div className="wf-attention-msg">
          <span>
            {subtype === 'clarify' ? '💬' : subtype === 'auth' ? '🔑' : '⚠️'}
          </span>
          <span>{node.reason}</span>
        </div>
        {node.prompt && (
          <div style={{ fontSize: 12, color: 'var(--wf-mut)' }}>{node.prompt}</div>
        )}
        {/* 2026-08-04 反问入口收敛（与审批同一决策）：浮动操作栏为唯一操作入口，
            脊柱卡只留痕——等待中仅提示去向，不再渲染第二套选项 chips。 */}
        {subtype === 'clarify' && isWaiting && (
          <div style={{ fontSize: 12, color: 'var(--wf-mut)', marginTop: 8 }}>
            {t('chat.flowNode.waitingAnswerHint')}
          </div>
        )}
        {/* 2026-07-31 审批入口收敛：浮动审批栏为唯一操作入口（用户拍板），
            脊柱卡转为只读留痕——等待中仅提示去向，不再放第二套批准/拒绝按钮。 */}
        {subtype === 'approval' && isWaiting && node.toolCallId && (
          <div style={{ fontSize: 12, color: 'var(--wf-warn-ink)', marginTop: 8 }}>
            {t('chat.flowNode.waitingApprovalHint')}
          </div>
        )}
        {/* 2026-07-31 决策留痕：终态 attention 显示解决备注（拒绝理由/超时/中断） */}
        {!isWaiting && node.resolutionNote && (
          <div style={{ fontSize: 12, color: 'var(--wf-mut)', marginTop: 6 }}>
            {t(
              node.status === 'resolved'
                ? subtype === 'clarify'
                  ? 'chat.flowNode.statusAnswered'
                  : 'chat.flowNode.statusApproved'
                : node.status === 'timeout'
                  ? 'chat.flowNode.statusTimedOut'
                  : node.status === 'cancelled'
                    ? 'chat.flowNode.statusInterrupted'
                    : 'chat.flowNode.statusSkipped'
            )}
            {node.resolutionNote ? `: ${node.resolutionNote}` : ''}
          </div>
        )}
      </div>
    </div>
  )
}

function AnswerBody({ node }: { node: AnswerNode }) {
  if (!node.content) return null
  return (
    <div className="text-sm text-[var(--wf-sub)] whitespace-pre-wrap">
      {node.content.slice(0, 300)}
      {node.content.length > 300 && '…'}
    </div>
  )
}

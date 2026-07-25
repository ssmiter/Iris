import { memo, useState, useCallback, useEffect, type ReactNode } from 'react'
import type { RenderNode, ThinkingNode, ToolNode, AttentionNode, AnswerNode } from '@/types/chat'
import { cn } from '@/utils'
import { InlineTable, extractTableRows } from './InlineTable'
import { ClampController } from './ClampController'
import { useTextReveal } from './useTextReveal'

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
  /** 澄清选项被选中时的回调 */
  onClarifyPick?: (nodeId: string, value: string) => void
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
  onClarifyPick,
  onTakeover,
  onSkipAttention,
  onApprove,
  onReject,
  promotedToolCallIds,
}: FlowNodeProps) {
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
      className={cn('wf-node', cls, open && 'open', born && 'born', isLastInFlow && 'wf-node-last')}
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
          <span className="wf-node-label">{nodeLabel(node)}</span>
          <span className="wf-node-meta">{nodeMeta(node)}</span>
          <span className="wf-node-toggle">▾</span>
        </button>
        <div className="wf-node-body">
          <div className="wf-node-body-inner">
            <div className="wf-node-body-pad">
              {nodeBody(node, { onClarifyPick, onTakeover, onSkipAttention, onApprove, onReject, promotedToolCallIds })}
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
    if (node.status === 'queued') return 'queued'
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
  // ── 运行时节点：始终展开 ──
  if (node.type === 'tool' && (node.status === 'queued' || node.status === 'running')) return true
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

function nodeLabel(node: RenderNode): string {
  switch (node.type) {
    case 'thinking':
      return node.role === 'verify' ? '验证' : '思考'
    case 'tool':
      return node.toolName
    case 'attention':
      return node.toolName || '需要你的操作'
    case 'artifact':
      return node.title
    case 'answer':
      return '回答'
  }
}

function nodeMeta(node: RenderNode): string {
  if (node.type === 'thinking') {
    if (node.durationMs != null) return `${(node.durationMs / 1000).toFixed(1)}s`
    return node.status === 'running' ? '思考中…' : ''
  }
  if (node.type === 'tool') {
    const parts: string[] = []
    if (node.status === 'queued') parts.push('排队中…')
    else if (node.status === 'running') parts.push('运行中…')
    else if (node.status === 'error') parts.push('失败')
    else if (node.status === 'cancelled') parts.push('已取消')
    if (node.durationMs != null) parts.push(`${(node.durationMs / 1000).toFixed(1)}s`)
    if (node.summary && node.status !== 'running') {
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
      return `等待中… ${elapsed}s`
    }
    return ''
  }
  if (node.type === 'answer') {
    if (node.status === 'streaming') return '输出中…'
    if (node.status === 'stopped') return '已停止'
    if (node.status === 'error') return '出错'
    return ''
  }
  return ''
}

// ── body dispatch ────────────────────────────────────

interface BodyCallbacks {
  onClarifyPick?: (nodeId: string, value: string) => void
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
  // TextReveal chars 模式：用 reveal hook 逐字流出思考内容
  // 仅在 running 时启用动画，done 后直接全量显示
  return (
    <ThinkingReveal text={node.content} isActive={node.status === 'running'} />
  )
}

/** 思考内容的流式 reveal 包装器 */
function ThinkingReveal({ text, isActive }: { text: string; isActive: boolean }) {
  const { revealed, tailWindow } = useTextReveal(text, { mode: 'chars', enabled: isActive })
  const displayText = isActive ? revealed : text
  const steps = displayText.split('\n').filter(Boolean)
  if (steps.length === 0) return null

  return (
    <ClampController maxHeight={148}>
      <div className="wf-think-stream">
        {steps.map((s, i) => (
          <div key={i} className="wf-step">
            {s}
          </div>
        ))}
        {/* 尾部窗口：最新 ~12 字逐字淡入 */}
        {isActive && tailWindow && tailWindow.length > 0 && (
          <span className="wf-step">
            {tailWindow.map((ch, j) => (
              <span key={j} className="wf-reveal-ch" style={{ animationDelay: `${Math.min(j * 12, 3200)}ms` }}>
                {ch}
              </span>
            ))}
          </span>
        )}
      </div>
    </ClampController>
  )
}

/** 从 ToolNode id 中提取 toolCallId（id 格式: prefix:tool:<toolCallId>:seq） */
function extractToolCallId(nodeId: string): string | undefined {
  const m = nodeId.match(/:tool:(.+?):\d+$/)
  return m?.[1]
}

function ToolBody({ node, promotedToolCallIds }: { node: ToolNode; promotedToolCallIds?: Set<string> }) {
  const errorLines = node.status === 'error' && node.summary
    ? node.summary.split('\n').filter(Boolean)
    : []
  const errorMain = errorLines[0] || ''
  const errorHint = errorLines.slice(1).join(' ') || undefined

  const promoted = promotedToolCallIds?.has(extractToolCallId(node.id) || '')
  const rows = node.status === 'done' && node.result && !promoted
    ? extractTableRows(node.result)
    : null

  return (
    <>
      {node.args && (
        <div className="wf-args-line">
          {node.toolName}({node.args.length > 120 ? node.args.slice(0, 120) + '…' : node.args})
        </div>
      )}
      {node.executionLog && (
        <ClampController maxHeight={160}>
          <div className="wf-log">{node.executionLog}</div>
        </ClampController>
      )}
      {/* 停滞提示（watchdog 30s 无进展） */}
      {node.status === 'running' && node.executionLog?.includes('等待较久') && (
        <div className="wf-stalled-banner">
          <span>⏳ 等待较久，仍在执行或可能已卡住</span>
        </div>
      )}
      {node.status === 'error' && (
        <div className="wf-err-box">
          <div className="wf-err-title">⛔ 执行失败</div>
          <div>{errorMain || node.summary}</div>
          {errorHint && (
            <div className="wf-err-hint">小模型解释：{errorHint}</div>
          )}
        </div>
      )}
      {promoted && (
        <div style={{ fontSize: 12.5, color: '#8b8b90', padding: '4px 0' }}>
          结果已在产物区展示
        </div>
      )}
      {rows && rows.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <InlineTable rows={rows} />
        </div>
      )}
      {node.status === 'done' && node.summary && !node.executionLog && !rows && !promoted && (
        <div style={{ fontSize: 13, color: '#475569' }}>{node.summary}</div>
      )}
    </>
  )
}

function AttentionBody({ node, cbs }: { node: AttentionNode; cbs: BodyCallbacks }) {
  const subtype = node.subtype || 'approval'
  const isWaiting = node.status === 'waiting'
  const [busy, setBusy] = useState(false)

  const handleApprove = useCallback(() => {
    if (!node.toolCallId || busy) return
    setBusy(true)
    cbs.onApprove?.(node.toolCallId)
  }, [cbs.onApprove, node.toolCallId, busy])

  const handleReject = useCallback(() => {
    if (!node.toolCallId || busy) return
    setBusy(true)
    cbs.onReject?.(node.toolCallId)
  }, [cbs.onReject, node.toolCallId, busy])

  if (subtype === 'takeover') {
    return (
      <div className="wf-browser-card">
        <div className="wf-browser-bar">
          <span className="wf-browser-dot" style={{ background: '#16a34a' }} />
          <span className="wf-browser-dot" />
          <span className="wf-browser-dot" />
          <div className="wf-browser-url">
            {node.toolName ? `${node.toolName} 需要人工操作` : '需要人工操作'}
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
                接管浏览器
              </button>
              <button
                className="wf-btn"
                onClick={() => cbs.onSkipAttention?.(node.id)}
              >
                跳过，继续后续步骤
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
          <div style={{ fontSize: 12, color: '#64748b' }}>{node.prompt}</div>
        )}
        {subtype === 'clarify' && node.options && node.options.length > 0 && isWaiting && (
          <div className="wf-chip-row">
            {node.options.map((opt) => (
              <button
                key={opt}
                className="wf-chip"
                onClick={() => cbs.onClarifyPick?.(node.id, opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        )}
        {subtype === 'approval' && isWaiting && node.toolCallId && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              className="wf-btn wf-btn-primary"
              disabled={busy}
              onClick={handleApprove}
            >
              {busy ? '处理中…' : '批准执行'}
            </button>
            <button
              className="wf-btn"
              disabled={busy}
              onClick={handleReject}
            >
              {busy ? '处理中…' : '拒绝'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function AnswerBody({ node }: { node: AnswerNode }) {
  if (!node.content) return null
  return (
    <div className="text-sm text-surface-600 whitespace-pre-wrap">
      {node.content.slice(0, 300)}
      {node.content.length > 300 && '…'}
    </div>
  )
}

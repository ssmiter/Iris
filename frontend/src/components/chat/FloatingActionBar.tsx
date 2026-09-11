import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { AttentionNode, ChatMessage } from '@/types/chat'
import { useChatStore } from '@/stores/chatStore'
import { isSqlWriteOperation } from '@/agent/pipelines/approvalExplain/sqlClassifier'
import { ASK_USER_DEFER_VALUE } from '@/agent/tools/askUserTool'
import { DiffView, extractWriteDiff } from '@/components/chat/DiffView'
import { formatToolDisplayName } from '@/utils/toolDisplayNames'

type PendingApprovalItem = ReturnType<typeof useChatStore.getState>['pendingApprovals'][number]

/** 审批卡"来自子 Agent"标签的任务摘要截断（sourceTask 在 chatStore 已截 80 字，卡上再收一档） */
function shortSourceTask(task: string): string {
  const one = task.replace(/\s+/g, ' ').trim()
  return one.length > 18 ? one.slice(0, 18) + '…' : one
}

/**
 * 浮动操作栏（审批 + ask_user 反问，2026-08-04 重设计）。
 *
 * 定位：absolute 放进 ChatView 的 relative 根——与 .wf-input-bar 同一包含块、
 * 同一宽度公式，天然与 composer 同中线；不再走 Portal/fixed，也就不需要
 * sidebar/dock 的视口补偿（历史上两次错位 BUG 的根源）。
 *
 * 设计：无边界排版——毛玻璃底托 + 细分隔线，不用色点/色块/图标按钮；
 * 风险与状态全部用措辞表达，交互元素统一为文字按钮（wf-text-btn）。
 *
 * 瀑布里的 attention 卡只留痕，这里是非浏览器接管类干预的唯一操作入口。
 */
export function FloatingActionBar({ messages }: { messages: ChatMessage[] }) {
  const { t } = useTranslation()
  const pendingApprovals = useChatStore((s) => s.pendingApprovals)
  const approveToolCall = useChatStore((s) => s.approveToolCall)
  const rejectToolCall = useChatStore((s) => s.rejectToolCall)
  const requestSqlExplain = useChatStore((s) => s.requestSqlExplain)
  const resolveAttention = useChatStore((s) => s.resolveAttention)

  const activeApprovals = pendingApprovals.filter((a) => a.status === 'pending')
  const [approvalBusy, setApprovalBusy] = useState<Set<string>>(new Set())
  const [expandedParams, setExpandedParams] = useState<Set<string>>(new Set())
  const [explainingIds, setExplainingIds] = useState<Set<string>>(new Set())

  const toggleParams = useCallback((id: string) => {
    setExpandedParams((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleSqlExplain = useCallback(
    (id: string) => {
      if (explainingIds.has(id)) return
      setExplainingIds((prev) => new Set(prev).add(id))
      void requestSqlExplain(id).finally(() => {
        setExplainingIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      })
    },
    [explainingIds, requestSqlExplain]
  )

  // 决定（批准/拒绝）立即生效，但该条不瞬消——原地淡化 500ms 后才收拢高度，
  // 其余条目在此时平滑补位；淡化期间布局完全不动，视线不用追任何元素。
  interface ApprovalGhost {
    approval: PendingApprovalItem
    decision: 'approved' | 'rejected'
    collapsing: boolean
  }
  const [approvalGhosts, setApprovalGhosts] = useState<Map<string, ApprovalGhost>>(new Map())

  const decideApproval = useCallback(
    (
      approval: PendingApprovalItem,
      decision: 'approved' | 'rejected',
      remember?: 'conversation' | 'longterm'
    ) => {
      const id = approval.toolCallId
      if (approvalBusy.has(id)) return
      setApprovalBusy((prev) => new Set(prev).add(id))
      setApprovalGhosts((prev) => {
        const next = new Map(prev)
        next.set(id, { approval, decision, collapsing: false })
        return next
      })
      if (decision === 'approved') approveToolCall(id, undefined, remember)
      else rejectToolCall(id)
      setTimeout(() => {
        setApprovalGhosts((prev) => {
          const g = prev.get(id)
          if (!g) return prev
          const next = new Map(prev)
          next.set(id, { ...g, collapsing: true })
          return next
        })
      }, 500)
      setTimeout(() => {
        setApprovalGhosts((prev) => {
          if (!prev.has(id)) return prev
          const next = new Map(prev)
          next.delete(id)
          return next
        })
        setApprovalBusy((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, 850)
    },
    [approvalBusy, approveToolCall, rejectToolCall]
  )

  const handleApprove = useCallback(
    (toolCallId: string) => {
      const a = activeApprovals.find((x) => x.toolCallId === toolCallId)
      if (a) decideApproval(a, 'approved')
    },
    [activeApprovals, decideApproval]
  )

  // 审批挂起期间 Tab = 快速批准第一项（模态语义，claude-code 式快捷键）。
  // window capture 阶段拦截，避免与输入框/斜杠菜单的 Tab 语义冲突。
  useEffect(() => {
    if (activeApprovals.length === 0) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.shiftKey || e.isComposing) return
      const first = activeApprovals[0]
      if (!first) return
      e.preventDefault()
      e.stopPropagation()
      handleApprove(first.toolCallId)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [activeApprovals, handleApprove])

  // 显示顺序稳定：live + ghost 按首次出现位置排列，新审批追加在底部（最靠近对话框）。
  const approvalOrderRef = useRef<string[]>([])
  const liveIds = activeApprovals.map((a) => a.toolCallId)
  const approvalDisplayOrder = useMemo(() => {
    const ghostIds = new Set(approvalGhosts.keys())
    const alive = new Set([...liveIds, ...ghostIds])
    const kept = approvalOrderRef.current.filter((id) => alive.has(id))
    const appended = [...liveIds, ...ghostIds].filter((id) => !kept.includes(id))
    const order = [...kept, ...appended]
    approvalOrderRef.current = order
    return order
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIds.join(','), approvalGhosts])

  // 反问（ask_user clarify）：waiting 的 clarify attention 节点从瀑布里提到 composer 上方——
  // 瀑布卡可能折叠在摘要节点里，用户不该为了点个选项去翻轮次。
  const waitingClarifies = useMemo(() => {
    const out: AttentionNode[] = []
    for (const m of messages) {
      if (m.role !== 'assistant' || !m.renderNodes) continue
      for (const n of m.renderNodes) {
        if (n.type === 'attention' && n.subtype === 'clarify' && n.status === 'waiting') out.push(n)
      }
    }
    return out
  }, [messages])

  interface ClarifyGhost {
    node: AttentionNode
    value: string
    collapsing: boolean
  }
  const [clarifyGhosts, setClarifyGhosts] = useState<Map<string, ClarifyGhost>>(new Map())
  const [clarifyBusy, setClarifyBusy] = useState<Set<string>>(new Set())

  const pickClarify = useCallback(
    (node: AttentionNode, value: string) => {
      const id = node.id
      if (clarifyBusy.has(id)) return
      setClarifyBusy((prev) => new Set(prev).add(id))
      setClarifyGhosts((prev) => {
        const next = new Map(prev)
        next.set(id, { node, value, collapsing: false })
        return next
      })
      resolveAttention(id, value)
      setTimeout(() => {
        setClarifyGhosts((prev) => {
          const g = prev.get(id)
          if (!g) return prev
          const next = new Map(prev)
          next.set(id, { ...g, collapsing: true })
          return next
        })
      }, 500)
      setTimeout(() => {
        setClarifyGhosts((prev) => {
          if (!prev.has(id)) return prev
          const next = new Map(prev)
          next.delete(id)
          return next
        })
        setClarifyBusy((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, 850)
    },
    [clarifyBusy, resolveAttention]
  )

  const clarifyOrderRef = useRef<string[]>([])
  const clarifyLiveIds = waitingClarifies.map((n) => n.id)
  const clarifyDisplayOrder = useMemo(() => {
    const ghostIds = new Set(clarifyGhosts.keys())
    const alive = new Set([...clarifyLiveIds, ...ghostIds])
    const kept = clarifyOrderRef.current.filter((id) => alive.has(id))
    const appended = [...clarifyLiveIds, ...ghostIds].filter((id) => !kept.includes(id))
    const order = [...kept, ...appended]
    clarifyOrderRef.current = order
    return order
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clarifyLiveIds.join(','), clarifyGhosts])

  if (approvalDisplayOrder.length === 0 && clarifyDisplayOrder.length === 0) return null

  return (
    <div className="wf-action-bar">
      <div className="wf-action-panel">
        {clarifyDisplayOrder.map((id) => {
          const live = waitingClarifies.find((n) => n.id === id)
          if (live) {
            return (
              <ClarifyItem
                key={id}
                node={live}
                busy={clarifyBusy.has(id)}
                onPick={pickClarify}
              />
            )
          }
          const ghost = clarifyGhosts.get(id)
          if (!ghost) return null
          return (
            <div key={id} className={`wf-action-item ghost${ghost.collapsing ? ' collapse' : ''}`}>
              <span className="g-text">{t('chat.fab.answeredGhost', { reason: ghost.node.reason, value: ghost.value })}</span>
            </div>
          )
        })}
        {approvalDisplayOrder.map((id) => {
          const live = activeApprovals.find((a) => a.toolCallId === id)
          if (live) {
            return (
              <ApprovalItem
                key={id}
                approval={live}
                isFirst={live.toolCallId === activeApprovals[0]?.toolCallId}
                busy={approvalBusy.has(id)}
                paramsExpanded={expandedParams.has(id)}
                explaining={explainingIds.has(id)}
                onDecide={decideApproval}
                onToggleParams={toggleParams}
                onSqlExplain={handleSqlExplain}
              />
            )
          }
          const ghost = approvalGhosts.get(id)
          if (!ghost) return null
          return (
            <div key={id} className={`wf-action-item ghost${ghost.collapsing ? ' collapse' : ''}`}>
              <span className="g-text">
                {formatToolDisplayName(ghost.approval.toolName)} — {ghost.decision === 'approved' ? t('chat.fab.approved') : t('chat.fab.rejected')}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 审批条目：一行文字组织——工具名（重）+ 风险/来源措辞 + 影响说明（灰）+ 文字按钮。
 * 整条点击 = 批准（与 Tab 同语义）；参数面板展开时换行独占。 */
function ApprovalItem({
  approval,
  isFirst,
  busy,
  paramsExpanded,
  explaining,
  onDecide,
  onToggleParams,
  onSqlExplain,
}: {
  approval: PendingApprovalItem
  isFirst: boolean
  busy: boolean
  paramsExpanded: boolean
  explaining: boolean
  onDecide: (
    approval: PendingApprovalItem,
    decision: 'approved' | 'rejected',
    remember?: 'conversation' | 'longterm'
  ) => void
  onToggleParams: (id: string) => void
  onSqlExplain: (id: string) => void
}) {
  const { t } = useTranslation()
  const id = approval.toolCallId
  const paramsText = approval.argumentsSummary
    ?? (approval.rawParams ? JSON.stringify(approval.rawParams, null, 2) : '')
  const isSqlWrite = approval.toolName === 'execute_sql_query'
    && typeof approval.rawParams?.sql === 'string'
    && isSqlWriteOperation(approval.rawParams.sql)

  // 写工具（write_file/str_replace）审批卡直接展示 hunk 级 diff——
  // 批准前"改了什么"即时可见，不用展开原始 JSON 参数脑内重演（2026-09-01 切片3）
  const writeDiff = useMemo(
    () => (approval.rawParams ? extractWriteDiff(approval.toolName, approval.rawParams) : null),
    [approval.toolName, approval.rawParams]
  )

  return (
    <div
      className="wf-action-item ap"
      role="button"
      tabIndex={-1}
      title={t('chat.fab.clickToApprove')}
      onClick={() => onDecide(approval, 'approved')}
    >
      <div className="ap-row">
        <span className="ap-name">{formatToolDisplayName(approval.toolName)}</span>
        {approval.riskLevel === 'destructive'
          ? <span className="ap-risk">{t('chat.fab.riskDestructive')}</span>
          : approval.riskLevel === 'elevated'
            ? <span className="ap-risk">{t('chat.fab.riskElevated')}</span>
            : null}
        {/* 审批桥冒泡：子 Agent 递的审批单如实标记来源 */}
        {approval.sourceRunId && (
          <span className="ap-src" title={approval.sourceTask}>
            {approval.sourceTask ? t('chat.fab.fromSubAgentTask', { task: shortSourceTask(approval.sourceTask) }) : t('chat.fab.fromSubAgent')}
          </span>
        )}
        <span className="ap-reason" title={approval.impactStatement}>{approval.impactStatement}</span>
        <span className="ap-acts">
          {isSqlWrite && !approval.sqlExplainSummary && (
            <button
              type="button"
              className="wf-text-btn"
              disabled={explaining}
              title={t('chat.fab.explainSqlTitle')}
              onClick={(e) => { e.stopPropagation(); onSqlExplain(id) }}
            >
              {explaining ? t('chat.fab.explaining') : t('chat.fab.explainImpact')}
            </button>
          )}
          {paramsText && (
            <button
              type="button"
              className="wf-text-btn"
              title={paramsExpanded ? t('chat.fab.collapseParams') : t('chat.fab.expandParams')}
              onClick={(e) => { e.stopPropagation(); onToggleParams(id) }}
            >
              {t('chat.fab.params')}{paramsExpanded ? '▴' : '▾'}
            </button>
          )}
          {isFirst && <span className="ap-tab">{t('chat.fab.tabApprove')}</span>}
          <button
            type="button"
            className="wf-text-btn primary"
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); onDecide(approval, 'approved') }}
          >
            {/* 目录授权无"一次性"语义（claude-code "allow reading from X/ during this
                session" 同款）：主按钮即本对话档，chatStore 侧无 remember 时自动沉淀 */}
            {approval.suggestedRule?.kind === 'directory'
              ? t('chat.fab.approveDirectory')
              : approval.suggestedRule
                ? t('chat.fab.approveOnce')
                : t('chat.fab.approve')}
          </button>
          {/* P0-2 权限表：checkPermissions 给了规则建议时提供"不再询问"档。
              命令类：本对话不再询问 / 始终允许（沉淀命令族规则）；
              目录类：主按钮已是本对话档，只补"始终允许"。破坏性命令无此建议。 */}
          {approval.suggestedRule && approval.suggestedRule.kind === 'command' && (
            <button
              type="button"
              className="wf-text-btn"
              disabled={busy}
              title={t('chat.fab.rememberRuleTitle', { label: approval.suggestedRule.label })}
              onClick={(e) => { e.stopPropagation(); onDecide(approval, 'approved', 'conversation') }}
            >
              {t('chat.fab.rememberConversation')}
            </button>
          )}
          {approval.suggestedRule && (
            <button
              type="button"
              className="wf-text-btn"
              disabled={busy}
              title={t('chat.fab.rememberRuleTitle', { label: approval.suggestedRule.label })}
              onClick={(e) => { e.stopPropagation(); onDecide(approval, 'approved', 'longterm') }}
            >
              {t('chat.fab.rememberLongterm')}
            </button>
          )}
          <button
            type="button"
            className="wf-text-btn danger"
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); onDecide(approval, 'rejected') }}
          >
            {t('chat.fab.reject')}
          </button>
        </span>
      </div>
      {approval.sqlExplainSummary && (
        <div className="ap-explain">{approval.sqlExplainSummary}</div>
      )}
      {writeDiff && (
        <div style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
          <DiffView
            path={writeDiff.path}
            oldText={writeDiff.oldText}
            newText={writeDiff.newText}
            mode={writeDiff.mode}
          />
        </div>
      )}
      {paramsExpanded && paramsText && (
        <pre className="ap-params" onClick={(e) => e.stopPropagation()}>
          {paramsText}
        </pre>
      )}
    </div>
  )
}

/** 反问条目（ask_user）：问题 + 编号选项行（claude-code 式列表）+ "其他…"内联输入 + "由你决定"逃生口。
 * 提交走 resolveAttention → clarifyGate，settle 幂等。 */
function ClarifyItem({
  node,
  busy,
  onPick,
}: {
  node: AttentionNode
  busy: boolean
  onPick: (node: AttentionNode, value: string) => void
}) {
  const { t } = useTranslation()
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherText, setOtherText] = useState('')

  const submitOther = () => {
    const text = otherText.trim()
    if (!text) return
    onPick(node, text)
  }

  return (
    <div className="wf-action-item cq">
      <div className="cq-question">{node.reason}</div>
      <div className="cq-opts">
        {(node.options ?? []).map((opt, i) => {
          const hint = node.optionHints?.[i]
          return (
            <button
              key={opt}
              type="button"
              className="cq-opt"
              disabled={busy}
              onClick={() => onPick(node, opt)}
            >
              <span className="n">{i + 1}</span>
              <span className="t">{opt}</span>
              {hint ? <span className="h">{hint}</span> : null}
            </button>
          )
        })}
      </div>
      <div className="cq-foot">
        <button
          type="button"
          className="wf-text-btn"
          disabled={busy}
          onClick={() => setOtherOpen((v) => !v)}
        >
          {t('chat.fab.other')}
        </button>
        <button
          type="button"
          className="wf-text-btn"
          disabled={busy}
          title={t('chat.fab.deferToAiTitle')}
          onClick={() => onPick(node, ASK_USER_DEFER_VALUE)}
        >
          {t('chat.fab.deferToAi')}
        </button>
      </div>
      {otherOpen && (
        <div className="cq-other">
          <input
            autoFocus
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitOther()
            }}
            placeholder={t('chat.fab.answerPlaceholder')}
          />
          <button
            type="button"
            className="wf-text-btn primary"
            onClick={submitOther}
            disabled={!otherText.trim() || busy}
          >
            {t('chat.fab.submit')}
          </button>
        </div>
      )}
    </div>
  )
}

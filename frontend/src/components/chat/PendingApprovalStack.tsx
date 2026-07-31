import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AttentionAction, AttentionNode } from '@/domain/chat/models'
import { Badge, Button } from '@/components/ui'
import { cn } from '@/lib/cn'

/**
 * 待审批浮动条（docs/24 §7）。
 *
 * 与过程链内的 attention 卡是同一批 attentionId 事实的两个 selector：
 * 链内卡保留历史陈述，浮动条承接"现在需要你决定"。
 *
 * 两阶段退场：决定/后端收敛 → 原位淡化 500ms（布局纹丝不动，其余条目不补位）
 * → 收拢 350ms（余项此时平滑上移）。顺序按首次出现位置稳定，
 * 新审批追加在最靠近 composer 一侧。Tab 快速批准首项
 * （window capture 拦截，IME 组合与输入框内不生效）。
 */

const FADE_MS = 500
const COLLAPSE_MS = 350
const ACTING_RESET_MS = 4000

type ExitPhase = 'live' | 'fading' | 'collapsing'

interface StackItem {
  node: AttentionNode
  phase: ExitPhase
}

interface PendingApprovalStackProps {
  /** 当前分支投影内所有 waiting 的 approval 节点（父级按 createdAt 排序） */
  nodes: AttentionNode[]
  onDecide: (node: AttentionNode, action: AttentionAction) => void
}

const riskTone = {
  read_only: 'success',
  standard: 'neutral',
  elevated: 'warning',
  destructive: 'danger',
} as const

const riskLabel = {
  read_only: '只读',
  standard: '标准',
  elevated: '提权',
  destructive: '破坏性',
} as const

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

function expiryText(
  expiresAt: string | undefined,
  now: number,
): { text: string; urgent: boolean } | null {
  if (!expiresAt) return null
  const remaining = new Date(expiresAt).getTime() - now
  if (Number.isNaN(remaining)) return null
  if (remaining <= 0) return { text: '已过期', urgent: true }
  if (remaining < 60_000) return { text: '不足 1 分钟后过期', urgent: true }
  return { text: `约 ${Math.round(remaining / 60_000)} 分钟后过期`, urgent: false }
}

export function PendingApprovalStack({
  nodes,
  onDecide,
}: PendingApprovalStackProps) {
  const [items, setItems] = useState<StackItem[]>([])
  const [actingById, setActingById] = useState<Record<string, string>>({})
  // 顺序稳定：attentionId → 首次出现序号，重排与重挂载都不改位次
  const seqByIdRef = useRef(new Map<string, number>())
  const nextSeqRef = useRef(0)
  const itemsRef = useRef<StackItem[]>(items)
  itemsRef.current = items

  // 事实同步：waiting 集合是权威。新出现的追加；仍在 waiting 的更新快照；
  // 不再是 waiting 的（无论本地决定还是他端收敛）进入两阶段退场。
  // 节点在 store 中是不可变引用，浅比较即可保证流式高频更新时不产生无效 set。
  useEffect(() => {
    setItems((current) => {
      const waitingById = new Map(
        nodes.map((node) => [node.attentionId, node]),
      )
      let changed = false
      const next: StackItem[] = current.map((item) => {
        const fresh = waitingById.get(item.node.attentionId)
        if (fresh && item.phase === 'live') {
          if (fresh === item.node) return item
          changed = true
          return { ...item, node: fresh }
        }
        if (!fresh && item.phase === 'live') {
          changed = true
          return { ...item, phase: 'fading' }
        }
        return item
      })
      for (const node of nodes) {
        if (next.some((item) => item.node.attentionId === node.attentionId)) {
          continue
        }
        if (!seqByIdRef.current.has(node.attentionId)) {
          seqByIdRef.current.set(node.attentionId, ++nextSeqRef.current)
        }
        changed = true
        next.push({ node, phase: 'live' })
      }
      if (!changed) return current
      next.sort(
        (a, b) =>
          (seqByIdRef.current.get(a.node.attentionId) ?? 0)
          - (seqByIdRef.current.get(b.node.attentionId) ?? 0),
      )
      return next
    })
  }, [nodes])

  // 淡化 500ms → 收拢；收拢 350ms → 移除
  useEffect(() => {
    if (!items.some((item) => item.phase === 'fading')) return
    const timer = window.setTimeout(() => {
      setItems((current) =>
        current.map((item) =>
          item.phase === 'fading' ? { ...item, phase: 'collapsing' } : item,
        ),
      )
    }, FADE_MS)
    return () => window.clearTimeout(timer)
  }, [items])

  useEffect(() => {
    if (!items.some((item) => item.phase === 'collapsing')) return
    const timer = window.setTimeout(() => {
      setItems((current) =>
        current.filter((item) => item.phase !== 'collapsing'),
      )
    }, COLLAPSE_MS)
    return () => window.clearTimeout(timer)
  }, [items])

  const decide = useCallback(
    (item: StackItem, action: AttentionAction) => {
      if (item.phase !== 'live') return
      setActingById((current) => ({
        ...current,
        [item.node.attentionId]: action.id,
      }))
      onDecide(item.node, action)
    },
    [onDecide],
  )

  // 提交期间防重：决议未收敛前按钮禁用；4s 未收敛视为提交失败，恢复可点
  useEffect(() => {
    if (Object.keys(actingById).length === 0) return
    const timer = window.setTimeout(
      () => setActingById({}),
      ACTING_RESET_MS,
    )
    return () => window.clearTimeout(timer)
  }, [actingById])

  // Tab 快速批准首项：capture 阶段拦截；输入框、IME 组合中不生效
  const hasLive = items.some((item) => item.phase === 'live')
  useEffect(() => {
    if (!hasLive) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.isComposing) return
      const target = event.target as HTMLElement | null
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"]',
        )
      ) {
        return
      }
      const first = itemsRef.current.find((item) => item.phase === 'live')
      const approve = first?.node.actions.find(
        (action) => action.id === 'approve',
      )
      if (!first || !approve) return
      event.preventDefault()
      decide(first, approve)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [decide, hasLive])

  const visible = items.length > 0
  const label = useMemo(
    () => `${items.filter((item) => item.phase === 'live').length} 项操作待决定`,
    [items],
  )

  if (!visible) return null

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-full z-10 mb-2 flex flex-col items-center px-[var(--page-gutter)]"
      role="group"
      aria-label={label}
    >
      <div className="w-full max-w-conversation px-[var(--conversation-pad)]">
        {items.map((item) => (
          <div
            key={item.node.attentionId}
            className={cn(
              'grid',
              item.phase === 'live' && 'grid-rows-[1fr]',
              item.phase === 'fading' &&
                'grid-rows-[1fr] opacity-0 transition-opacity duration-[500ms] ease-standard motion-reduce:transition-none',
              item.phase === 'collapsing' &&
                'grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-[350ms] ease-exit motion-reduce:transition-none',
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="pb-1.5">
                <ApprovalCard
                  item={item}
                  actingActionId={actingById[item.node.attentionId]}
                  onDecide={decide}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ApprovalCard({
  item,
  actingActionId,
  onDecide,
}: {
  item: StackItem
  actingActionId: string | undefined
  onDecide: (item: StackItem, action: AttentionAction) => void
}) {
  const { node } = item
  const acting = actingActionId != null
  // 后端快照默认 5 分钟 TTL（部分工具 30 秒）：30s 粒度刷新剩余时间，
  // 仅挂载期间计时，足够传达紧迫感而不至秒级跳动。
  const now = useNow(30_000)
  const expiry = expiryText(node.approval?.expiresAt, now)

  return (
    <div className="pointer-events-auto animate-node-enter rounded-md border border-warning/30 bg-surface-raised px-3.5 py-3 shadow-floating motion-reduce:animate-none">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {node.approval && (
            <p className="text-caption text-ink-muted">
              {node.approval.toolName}
              {expiry && (
                <span className={expiry.urgent ? 'text-warning' : undefined}>
                  {' · '}{expiry.text}
                </span>
              )}
            </p>
          )}
          <p className="mt-0.5 text-small font-medium text-ink">
            {node.impact}
          </p>
        </div>
        {node.approval && (
          <Badge tone={riskTone[node.approval.riskLevel]}>
            {riskLabel[node.approval.riskLevel]}
          </Badge>
        )}
      </div>
      <div
        className={cn(
          'mt-2.5 flex flex-wrap items-center gap-2 transition-opacity duration-fast motion-reduce:transition-none',
          acting && 'opacity-60',
        )}
      >
        {node.actions.map((action) => (
          <Button
            key={action.id}
            size="sm"
            variant={action.tone}
            disabled={acting}
            isLoading={actingActionId === action.id}
            onClick={() => onDecide(item, action)}
          >
            {action.label}
          </Button>
        ))}
        {!acting && (
          <span className="text-caption text-ink-muted">
            Tab 快速批准首项
          </span>
        )}
      </div>
    </div>
  )
}

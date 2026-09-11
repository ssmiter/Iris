import { useMemo } from 'react'
import type { WorkflowDoc, WorkflowEdge } from '@/types/workflow'

/**
 * 工作流投影：WorkFlow JSON → 示意化地铁图（只读）。
 *
 * 布局规则（参照蓝图 v18 的示意化取舍，不用力导/通用布局——近线性主链
 * 用通用优化目标会蛇形漂移）：
 *   脊柱=从 start 出发的最长链（前向边），定中栏纵排；
 *   回边（含自环）走左侧走廊，按跨度嵌套；
 *   支线节点挂右侧，汇合自然落回脊柱；
 *   出口（to=null）画右侧短桩。
 * 语义：图是投影，JSON 是事实——本组件不改文档，不做编辑。
 */

const DY = 76
const NODE_H = 40
const SPINE_X = 210
const TOP = 36

interface PlacedNode {
  id: string
  x: number
  y: number
  w: number
  onSpine: boolean
}

function nodeWidth(label: string): number {
  return Math.min(220, Math.max(96, (label ?? '').length * 13 + 40))
}

function trunc(s: string, n: number): string {
  if (!s) return '' // 绕行文件可能缺 when/label，宁缺字不崩
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** 圆角正交折线 */
function roundedPath(points: [number, number][], r = 10): string {
  if (points.length < 2) return ''
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1]
    const [cx, cy] = points[i]
    const [nx, ny] = points[i + 1]
    const d1x = cx - px, d1y = cy - py
    const d2x = nx - cx, d2y = ny - cy
    const l1 = Math.hypot(d1x, d1y) || 1
    const l2 = Math.hypot(d2x, d2y) || 1
    const rr = Math.min(r, l1 / 2, l2 / 2)
    d += ` L ${cx - (d1x / l1) * rr} ${cy - (d1y / l1) * rr}`
    d += ` Q ${cx} ${cy} ${cx + (d2x / l2) * rr} ${cy + (d2y / l2) * rr}`
  }
  const [lx, ly] = points[points.length - 1]
  d += ` L ${lx} ${ly}`
  return d
}

interface Layout {
  placed: Map<string, PlacedNode>
  spineIds: string[]
  backEdges: WorkflowEdge[]
  selfLoops: WorkflowEdge[]
  exits: WorkflowEdge[]
  forwardEdges: WorkflowEdge[]
  backLaneX: Map<WorkflowEdge, number>
  width: number
  height: number
}

function layout(doc: WorkflowDoc): Layout {
  const nodeIds = new Set(doc.nodes.map((n) => n.id))
  const forward = doc.edges.filter((e) => e.to != null && e.from !== e.to && nodeIds.has(e.from) && nodeIds.has(e.to))
  const selfLoops = doc.edges.filter((e) => e.to != null && e.from === e.to)
  const exits = doc.edges.filter((e) => e.to == null)

  // 回边识别：DFS 染色（指向灰节点=回边）
  const color = new Map<string, number>() // 0=white 1=gray 2=black
  const backEdges: WorkflowEdge[] = []
  const forwardOnly: WorkflowEdge[] = []
  const adj = new Map<string, WorkflowEdge[]>()
  for (const e of forward) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from)!.push(e)
  }
  const startId = nodeIds.has(doc.start) ? doc.start : doc.nodes[0]?.id
  const dfs = (u: string) => {
    color.set(u, 1)
    for (const e of adj.get(u) ?? []) {
      const v = e.to!
      const c = color.get(v) ?? 0
      if (c === 1) {
        backEdges.push(e)
      } else {
        forwardOnly.push(e)
        if (c === 0) dfs(v)
      }
    }
    color.set(u, 2)
  }
  if (startId) dfs(startId)
  // 起点不可达的子图（校验闸会拦，这里兜底全部展开防渲染丢节点）
  for (const n of doc.nodes) {
    if ((color.get(n.id) ?? 0) === 0) dfs(n.id)
  }

  // 脊柱=最长链（前向 DAG 上记忆化 DFS）
  const fwdAdj = new Map<string, WorkflowEdge[]>()
  for (const e of forwardOnly) {
    if (!fwdAdj.has(e.from)) fwdAdj.set(e.from, [])
    fwdAdj.get(e.from)!.push(e)
  }
  const memo = new Map<string, number>()
  const chainLen = (u: string): number => {
    const hit = memo.get(u)
    if (hit !== undefined) return hit
    memo.set(u, 1) // 防环兜底
    let best = 1
    for (const e of fwdAdj.get(u) ?? []) {
      best = Math.max(best, 1 + chainLen(e.to!))
    }
    memo.set(u, best)
    return best
  }
  const spineIds: string[] = []
  if (startId) {
    let cur: string | undefined = startId
    const seen = new Set<string>()
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      spineIds.push(cur)
      const outs: WorkflowEdge[] = (fwdAdj.get(cur) ?? []).filter((e) => !seen.has(e.to!))
      if (outs.length === 0) break
      outs.sort((a: WorkflowEdge, b: WorkflowEdge) => chainLen(b.to!) - chainLen(a.to!))
      cur = outs[0].to!
    }
  }

  // 层级：前向 DAG 上距 start 的最长入边距离（定侧支节点纵坐标）
  const level = new Map<string, number>()
  const predEdges = new Map<string, WorkflowEdge[]>()
  for (const e of forwardOnly) {
    if (!predEdges.has(e.to!)) predEdges.set(e.to!, [])
    predEdges.get(e.to!)!.push(e)
  }
  const calcIn = (u: string, stack: Set<string>): number => {
    const hit = level.get(u)
    if (hit !== undefined) return hit
    if (stack.has(u)) return 0
    stack.add(u)
    let best = u === startId ? 0 : 0
    for (const e of predEdges.get(u) ?? []) {
      best = Math.max(best, calcIn(e.from, stack) + 1)
    }
    stack.delete(u)
    level.set(u, best)
    return best
  }
  for (const n of doc.nodes) calcIn(n.id, new Set())

  // 脊柱行号压缩：脊柱节点按链序占连续行；非脊柱节点按入边层级插行
  const spineRow = new Map<string, number>()
  spineIds.forEach((id, i) => spineRow.set(id, i))
  const placed = new Map<string, PlacedNode>()
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]))

  const spineMaxW = Math.max(96, ...spineIds.map((id) => nodeWidth(nodeById.get(id)?.label ?? id)))
  spineIds.forEach((id) => {
    placed.set(id, {
      id,
      x: SPINE_X,
      y: TOP + spineRow.get(id)! * DY,
      w: nodeWidth(nodeById.get(id)?.label ?? id),
      onSpine: true,
    })
  })

  // 侧支节点：行=max(自身层级, 最近脊柱前驱行+0)? ——取入边前驱的最大行，与脊柱共享行轴
  const sideX = SPINE_X + spineMaxW / 2 + 110
  const rowUse = new Map<number, number>() // row → 已占列数
  for (const n of doc.nodes) {
    if (spineRow.has(n.id)) continue
    let row = 0
    for (const e of predEdges.get(n.id) ?? []) {
      const pred = placed.get(e.from)
      if (pred) row = Math.max(row, Math.round((pred.y - TOP) / DY))
    }
    row = Math.max(row, Math.min(level.get(n.id) ?? 0, spineIds.length - 1))
    const col = rowUse.get(row) ?? 0
    rowUse.set(row, col + 1)
    const w = nodeWidth(n.label)
    placed.set(n.id, { id: n.id, x: sideX + col * (w + 40), y: TOP + row * DY, w, onSpine: false })
  }

  // 回边走廊：按跨度（行差）从长到短分配车道，长跨走外车道
  const backLaneX = new Map<WorkflowEdge, number>()
  const corridorBase = SPINE_X - spineMaxW / 2 - 26
  const sortedBack = [...backEdges].sort((a, b) => {
    const span = (e: WorkflowEdge) =>
      Math.abs(((placed.get(e.to!)?.y ?? 0) - (placed.get(e.from)?.y ?? 0)) / DY)
    return span(b) - span(a)
  })
  sortedBack.forEach((e, j) => backLaneX.set(e, corridorBase - 20 - j * 20))

  const maxRow = Math.max(0, ...[...placed.values()].map((p) => (p.y - TOP) / DY))
  const sideMaxX = Math.max(0, ...[...placed.values()].filter((p) => !p.onSpine).map((p) => p.x + p.w / 2))
  const minLaneX = sortedBack.length > 0 ? Math.min(...[...backLaneX.values()]) : corridorBase
  const width = Math.max(sideMaxX + 150, SPINE_X + spineMaxW / 2 + 120)
  const shift = Math.max(0, 30 - minLaneX) // 走廊越界时整体右移

  if (shift > 0) {
    for (const p of placed.values()) p.x += shift
  }
  return {
    placed,
    spineIds,
    backEdges,
    selfLoops,
    exits,
    forwardEdges: forwardOnly,
    backLaneX,
    width: width + shift,
    height: TOP + maxRow * DY + 70,
  }
}

export function WorkflowGraph({
  doc,
  errors,
  compact = false,
}: {
  doc: WorkflowDoc
  errors?: string[]
  compact?: boolean
}) {
  // 防御：doc 可能缺席或结构不完整——校验闸只守后端保存通道，文件原语绕行的
  // 文件与"校验未过的呈现"都可能把残缺 doc 送到这里；渲染崩溃无 ErrorBoundary
  // 兜底（全屏空白），宁可画不出也不崩。
  const safeDoc = doc && Array.isArray(doc.nodes) && Array.isArray(doc.edges) ? doc : null
  const L = useMemo(() => (safeDoc ? layout(safeDoc) : null), [safeDoc])
  const nodeById = useMemo(
    () => new Map((safeDoc?.nodes ?? []).map((n) => [n.id, n])),
    [safeDoc]
  )
  if (!safeDoc || !L) {
    return (
      <div className="text-xs" style={{ color: '#94a3b8', padding: compact ? 4 : 12 }}>
        工作流结构不可用（文档缺失或不完整）
      </div>
    )
  }

  const summarizeWhen = (n: (typeof safeDoc.nodes)[number]): string => {
    // 判据字段全部按 Array.isArray 收窄：绕行文件可能把 has_field 等写成单字符串，
    // 直接 .join 会崩（.length 对字符串同样为真，?.,length 挡不住）
    const parts: string[] = []
    if (n.purpose) parts.push(`职责：${n.purpose}`)
    if (n.done_when) {
      const d: string[] = []
      if (n.done_when.receipt_status) d.push(`status=${n.done_when.receipt_status}`)
      if (Array.isArray(n.done_when.receipt_status_in) && n.done_when.receipt_status_in.length)
        d.push(`status ∈ ${n.done_when.receipt_status_in.join('/')}`)
      if (Array.isArray(n.done_when.has_field) && n.done_when.has_field.length)
        d.push(`有字段 ${n.done_when.has_field.join(',')}`)
      if (d.length) parts.push(`走完标志：${d.join(' 且 ')}`)
    }
    if (n.fail_when) {
      const f: string[] = []
      if (Array.isArray(n.fail_when.reason_in) && n.fail_when.reason_in.length)
        f.push(`reason ∈ ${n.fail_when.reason_in.join('/')}`)
      if (Array.isArray(n.fail_when.receipt_status_in) && n.fail_when.receipt_status_in.length)
        f.push(`status ∈ ${n.fail_when.receipt_status_in.join('/')}`)
      if (f.length) parts.push(`失败信号：${f.join(' 或 ')}`)
    }
    if (n.see) parts.push(`判断细节：${n.see}`)
    return parts.join('\n')
  }

  return (
    <div className={compact ? 'w-full overflow-hidden' : 'w-full overflow-auto'}>
      {errors && errors.length > 0 && (
        <div
          className="mb-2 rounded-lg px-3 py-2 text-xs"
          style={{ background: 'rgba(217,119,6,.10)', color: '#b45309', border: '1px solid rgba(217,119,6,.35)' }}
        >
          <div className="font-medium mb-1">结构待修（校验闸未通过，投影按现状渲染）：</div>
          {errors.map((e, i) => (
            <div key={i}>· {e}</div>
          ))}
        </div>
      )}
      <svg
        viewBox={`0 0 ${L.width} ${L.height}`}
        width={compact ? '100%' : L.width}
        height={compact ? undefined : L.height}
        style={compact ? { height: 'auto', maxHeight: 160 } : undefined}
        role="img"
        aria-label={doc.name}
      >
        <defs>
          <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
          </marker>
          <marker id="wf-arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#d97706" />
          </marker>
        </defs>

        {/* 前向边 */}
        {L.forwardEdges.map((e, i) => {
          const a = L.placed.get(e.from)
          const b = L.placed.get(e.to!)
          if (!a || !b) return null
          const spineStraight =
            a.onSpine && b.onSpine && Math.abs(a.x - b.x) < 1 && b.y > a.y
          const d = spineStraight
            ? `M ${a.x} ${a.y + NODE_H / 2} L ${b.x} ${b.y - NODE_H / 2}`
            : roundedPath([
                [a.x + a.w / 2, a.y],
                [b.x - b.w / 2 - 14, a.y],
                [b.x - b.w / 2 - 14, b.y],
                [b.x - b.w / 2, b.y],
              ])
          const labeled = e.when !== 'done'
          const labelX = spineStraight ? a.x + 10 : b.x - b.w / 2 - 14
          const labelY = spineStraight ? (a.y + b.y) / 2 - 6 : (a.y + b.y) / 2 - 10
          return (
            <g key={`f${i}`}>
              <path d={d} fill="none" stroke="#94a3b8" strokeWidth={1.6} markerEnd="url(#wf-arrow)" />
              {labeled && (
                <EdgeLabel x={labelX} y={labelY} text={e.when} title={e.note} />
              )}
            </g>
          )
        })}

        {/* 回边（左走廊，虚线=循环语义） */}
        {L.backEdges.map((e, i) => {
          const a = L.placed.get(e.from)
          const b = L.placed.get(e.to!)
          if (!a || !b) return null
          const lane = (L.backLaneX.get(e) ?? 40)
          const d = roundedPath([
            [a.x - a.w / 2, a.y],
            [lane, a.y],
            [lane, b.y],
            [b.x - b.w / 2, b.y],
          ])
          return (
            <g key={`b${i}`}>
              <path d={d} fill="none" stroke="#d97706" strokeWidth={1.4} strokeDasharray="5 4" markerEnd="url(#wf-arrow-back)" />
              <EdgeLabel x={lane - 4} y={(a.y + b.y) / 2 - 8} text={trunc(e.when, 16)} title={e.note} anchor="end" accent />
            </g>
          )
        })}

        {/* 自环（轮询）：节点左侧小环 */}
        {L.selfLoops.map((e, i) => {
          const a = L.placed.get(e.from)
          if (!a) return null
          const cx = a.x - a.w / 2 - 18
          return (
            <g key={`s${i}`}>
              <circle cx={cx} cy={a.y} r={9} fill="none" stroke="#d97706" strokeWidth={1.4} strokeDasharray="4 3" />
              <text x={cx} y={a.y + 3} fontSize={9} textAnchor="middle" fill="#d97706">⟳</text>
              <title>{`轮询循环：${e.when}${e.note ? `\n${e.note}` : ''}`}</title>
            </g>
          )
        })}

        {/* 出口（to=null）：右侧短桩 */}
        {L.exits.map((e, i) => {
          const a = L.placed.get(e.from)
          if (!a) return null
          const x1 = a.x + a.w / 2
          const x2 = x1 + 44
          return (
            <g key={`x${i}`}>
              <path d={`M ${x1} ${a.y + 8} L ${x2} ${a.y + 8}`} fill="none" stroke="#94a3b8" strokeWidth={1.4} strokeDasharray="2 3" />
              <EdgeLabel x={x2 + 6} y={a.y + 4} text={`出口 · ${trunc(e.when, 14)}`} title={e.note} dim />
            </g>
          )
        })}

        {/* 节点 */}
        {[...L.placed.values()].map((p) => {
          const n = nodeById.get(p.id)
          if (!n) return null
          const isStart = p.id === doc.start
          return (
            <g key={p.id}>
              <rect
                x={p.x - p.w / 2}
                y={p.y - NODE_H / 2}
                width={p.w}
                height={NODE_H}
                rx={10}
                fill="var(--wf-bg-elevated, #ffffff)"
                stroke={isStart ? 'var(--wf-accent, #4f46e5)' : 'var(--wf-border, #cbd5e1)'}
                strokeWidth={isStart ? 2 : 1.2}
              />
              <text
                x={p.x}
                y={p.y - 2}
                fontSize={12.5}
                textAnchor="middle"
                fill="var(--wf-text, #0f172a)"
                style={{ fontWeight: 500 }}
              >
                {trunc(n.label, 14)}
              </text>
              <text x={p.x} y={p.y + 13} fontSize={9} textAnchor="middle" fill="#94a3b8" style={{ fontFamily: 'ui-monospace, monospace' }}>
                {trunc(n.tool, 26)}
              </text>
              <title>{`${n.label}（${n.tool}）\n${summarizeWhen(n)}`}</title>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function EdgeLabel({
  x,
  y,
  text,
  title,
  anchor = 'start',
  accent = false,
  dim = false,
}: {
  x: number
  y: number
  text: string
  title?: string
  anchor?: 'start' | 'end'
  accent?: boolean
  dim?: boolean
}) {
  const w = text.length * 10 + 12
  const rx = anchor === 'end' ? x - w : x
  const color = accent ? '#d97706' : dim ? '#94a3b8' : '#64748b'
  return (
    <g>
      <rect
        x={rx}
        y={y - 8}
        width={w}
        height={16}
        rx={8}
        fill="var(--wf-bg-elevated, #ffffff)"
        stroke={color}
        strokeWidth={0.8}
        opacity={0.95}
      />
      <text x={anchor === 'end' ? x - 6 : x + 6} y={y + 4} fontSize={9.5} fill={color} textAnchor={anchor}>
        {text}
      </text>
      {title && <title>{title}</title>}
    </g>
  )
}

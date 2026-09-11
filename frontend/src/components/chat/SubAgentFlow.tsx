import { memo, useMemo, useRef, useState, useCallback, createContext, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import type { RenderNode, ToolNode } from '@/types/chat'
import { useSubAgentRunStore, type SubAgentRunRecord } from '@/stores/subAgentRunStore'
import { EXPLORE_AGENT_TOOL_NAME } from '@/agent/tools/exploreAgentRun'
import { AGENT_TOOL_NAME } from '@/agent/tools/agentTool'
import { FlowNode, ToolBody, type TurnPhase } from './FlowNode'

/**
 * 子 Agent 嵌套瀑布（2026-08-01，方向 A·递归同款）。
 *
 * 形态：父节点 = 瀑布上的子 Agent 派遣节点（统一 agent 工具 / 历史 explore_agent），展开后节点体内嵌一套同构子瀑布——
 * 同一个 FlowNode 渲染器、同一套脊柱点线与状态色，层级只靠「缩进一档 + 轨道淡化 + ↳ 徽记」
 * 区分（CSS 承担，无新视觉语言）。未来子 Agent 再派生子 Agent = 再嵌一层，
 * SubAgentDepthContext 深度 +1、轨道淡化梯度自动跟随。
 *
 * 懒渲染：本组件由 FlowNode 仅在父节点展开时挂载（折叠时子瀑布 DOM 不存在）。
 * 默认闭合：父节点在 FlowNode.shouldAutoOpen 特判恒折叠（含运行中），围观靠手动展开。
 *
 * 与 FlowNode 存在相互 import（FlowNode ↔ SubAgentFlow）：两边模块体都只定义组件、
 * 引用发生在渲染期而非模块初始化期，无 TDZ 风险——不要提升到模块顶层调用。
 *
 * 数据接缝（递归预留）：深度≥2 时子节点由 toolEvents 合成，尚无 args/childRunId——
 * 届时逻辑车道给 SubAgentToolEvent 补一个字段即可，组件结构已就位。
 */

/** 嵌套深度：0=主瀑布第一层子 Agent；子再派生子时 +1（轨道淡化梯度随深度） */
export const SubAgentDepthContext = createContext(0)

/** 从父节点 id 提取 toolCallId（与 FlowNode.extractToolCallId 同规则，小函数就地复制避免导出纠缠） */
function parentToolCallId(nodeId: string): string | undefined {
  const m = nodeId.match(/:tool:(.+?):\d+$/)
  return m?.[1]
}

/** 父节点 args 中解析任务文本（agent/explore_agent 入参均含 { task }） */
function parseTask(args?: string): string | undefined {
  if (!args) return undefined
  try {
    const parsed = JSON.parse(args) as { task?: unknown }
    return typeof parsed.task === 'string' ? parsed.task : undefined
  } catch {
    return undefined
  }
}

/**
 * 父工具节点 ↔ 子运行记录挂靠（三级降级，不动逻辑车道一行代码）：
 * ① 记录带 parentToolCallId（并行多 Agent 任务未来一行可补的显式接缝）→ 精确；
 * ② 完成后工具结果自带 runId（ExploreAgentOutput.runId）→ 精确；
 * ③ 运行中：任务文本相关（task 自足且唯一）+ 不早于父节点开始 10s，取最近一条。
 * 已知边界：同一轮并行两个任务文本完全相同的调用会挂靠到同一条记录（概率极低，最坏=同卡展示两次）。
 */
function findRunForNode(
  node: ToolNode,
  runs: Record<string, SubAgentRunRecord>,
  order: string[]
): SubAgentRunRecord | undefined {
  const callId = parentToolCallId(node.id)
  if (callId) {
    for (const id of order) {
      const r = runs[id]
      if ((r as SubAgentRunRecord & { parentToolCallId?: string }).parentToolCallId === callId) return r
    }
  }
  const resultRunId = (node.result as { runId?: unknown } | null | undefined)?.runId
  if (typeof resultRunId === 'string' && runs[resultRunId]) return runs[resultRunId]
  const task = parseTask(node.args)
  if (!task) return undefined
  let best: SubAgentRunRecord | undefined
  for (const id of order) {
    const r = runs[id]
    if (r.task !== task) continue
    if (r.queuedAt < node.startedAt - 10_000) continue
    if (!best || r.queuedAt > best.queuedAt) best = r
  }
  return best
}

function formatDur(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 1000).toFixed(0)}s`
}

/** toolEvents → 轻量 RenderNode：复用 FlowNode 全部折叠/状态机/耗时展示（SubAgentView 同用） */
export function toolEventsToNodes(run: SubAgentRunRecord): RenderNode[] {
  return run.toolEvents.map((ev) => ({
    id: `sub:${run.runId}:${ev.toolCallId}`,
    type: 'tool' as const,
    toolName: ev.name,
    status: ev.status,
    summary: ev.summary ?? '',
    startedAt: ev.at,
    durationMs: ev.endedAt != null ? Math.max(0, ev.endedAt - ev.at) : undefined,
  }))
}

/** 子瀑布节点列表：自带手动覆盖集合（与主瀑布同规则：状态变化不碰折叠，只有点击碰） */
export const SubAgentNodeList = memo(function SubAgentNodeList({
  nodes,
  turnPhase,
}: {
  nodes: RenderNode[]
  turnPhase: TurnPhase
}) {
  const overridesRef = useRef<Set<string>>(new Set())
  const [, setOverridesVersion] = useState(0)
  const handleNodeToggle = useCallback((nodeId: string) => {
    const set = overridesRef.current
    if (set.has(nodeId)) set.delete(nodeId)
    else set.add(nodeId)
    setOverridesVersion((v) => v + 1)
  }, [])

  return (
    <>
      {nodes.map((child, i) => {
        const prev = i > 0 ? nodes[i - 1] : null
        const segFlowed =
          prev != null && prev.type === 'tool'
            ? prev.status === 'done' || prev.status === 'error' || prev.status === 'cancelled'
            : false
        return (
          <FlowNode
            key={child.id}
            node={child}
            turnPhase={turnPhase}
            segFlowed={segFlowed}
            isOverridden={overridesRef.current.has(child.id)}
            isLastInFlow={i === nodes.length - 1}
            onToggle={handleNodeToggle}
          />
        )
      })}
    </>
  )
})

/** 报告落盘路径：无边界文字按钮，点击复制全路径（引用回跳属后续接缝，先给可追溯的最小动作） */
export function ReportChip({ path }: { path: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    try {
      void navigator.clipboard?.writeText(path)
    } catch {
      /* 剪贴板不可用时静默，title 已承担全路径 */
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }, [path])
  const base = path.split('/').pop() || path
  return (
    <button className="wf-subflow-chip" title={path} onClick={copy}>
      {copied ? t('chat.subAgentFlow.copiedPath') : base}
    </button>
  )
}

const SubAgentRunView = memo(function SubAgentRunView({
  node,
  run,
  depth,
}: {
  node: ToolNode
  run: SubAgentRunRecord
  depth: number
}) {
  const { t } = useTranslation()
  const childNodes = useMemo<RenderNode[]>(() => toolEventsToNodes(run), [run])

  // 运行中的子瀑布给 active 相位（新节点出生淡入、运行节点保持展开）；
  // 终态回顾一律 settled（子节点默认折叠，由用户逐个点开）
  const turnPhase: TurnPhase = run.status === 'running' || run.status === 'queued' ? 'active' : 'settled'

  // 最新进展：异步模式唯一稳定进度源 = runStore.liveLine（逻辑侧直写）；
  // 同步旧记录兜底 = 父节点 executionLog 末行
  const liveLine = useMemo(() => {
    if (run.status !== 'running') return undefined
    if (run.liveLine) return run.liveLine
    if (!node.executionLog) return undefined
    const lines = node.executionLog.split('\n').filter((l) => l.trim().length > 0)
    return lines[lines.length - 1]
  }, [run.status, run.liveLine, node.executionLog])

  const toolCount = run.toolEvents.length
  const discovered = run.discoveredNames.length
  const durationMs =
    run.endedAt != null && run.startedAt != null
      ? run.endedAt - run.startedAt
      : run.startedAt != null
        ? Date.now() - run.startedAt
        : null

  return (
    <SubAgentDepthContext.Provider value={depth + 1}>
      <div className="wf-subflow">
        {/* 任务书：子 Agent 上下文隔离，任务描述就是它的出生证明；类型词（调研/执行）前置 */}
        <div className="wf-subflow-taskbook">
          <b>{run.kind === 'general' ? t('chat.subAgentFlow.taskGeneral') : t('chat.subAgentFlow.taskExplore')}</b>
          {run.task}
        </div>
        {run.status === 'queued' && <div className="wf-subflow-live">▸ {t('chat.subAgentFlow.queued')}</div>}
        {liveLine && <div className="wf-subflow-live">▸ {liveLine}</div>}
        <SubAgentNodeList nodes={childNodes} turnPhase={turnPhase} />
        {/* 页脚：真实终态如实显示（run 出错/中断时父工具节点仍是 done 绿点——
            工具层面"拿到了部分结果"是成功，子 Agent 层面的失败在这里留痕） */}
        <div className="wf-subflow-foot">
          <span>
            {[
              t('chat.subAgentFlow.callCount', { count: toolCount }),
              durationMs != null ? formatDur(durationMs) : null,
              discovered > 0 ? t('chat.subAgentFlow.discovered', { count: discovered }) : null,
              run.touchedFiles.length > 0 ? t('chat.subAgentFlow.wroteFiles', { count: run.touchedFiles.length }) : null,
            ].filter(Boolean).join(' · ')}
          </span>
          {run.conflictNote && (
            <span className="wf-subflow-flag warn" title={run.conflictNote}>{t('chat.subAgentFlow.conflict')}</span>
          )}
          {run.status === 'error' && <span className="wf-subflow-flag err">{t('chat.subAgentFlow.error')}</span>}
          {run.status === 'cancelled' && <span className="wf-subflow-flag warn">{t('chat.subAgentFlow.cancelled')}</span>}
          {run.reportPath && <ReportChip path={run.reportPath} />}
        </div>
        {(run.status === 'error' || run.status === 'cancelled') && run.error && (
          <div className="wf-subflow-errline">{run.error}</div>
        )}
      </div>
    </SubAgentDepthContext.Provider>
  )
})

export const SubAgentFlow = memo(function SubAgentFlow({ node }: { node: ToolNode }) {
  const depth = useContext(SubAgentDepthContext)
  const runs = useSubAgentRunStore((s) => s.runs)
  const order = useSubAgentRunStore((s) => s.order)
  const run = useMemo(() => findRunForNode(node, runs, order), [node, runs, order])

  // as_task 任务会话派遣（2026-09-02 回放断链修复）：任务卡已提升到正文区做常驻锚点，
  // 过程在任务会话里看——父会话不再套嵌套子瀑布（重复且把卡埋进折叠层），
  // 退化为普通工具体。判定双源：结果带 taskConversationId（回执到达后/历史回放）
  // 或派遣参数 as_task=true（回执到达前的运行中窗口）。
  if (isTaskSessionNode(node)) return <ToolBody node={node} />

  // 无运行记录：历史水合后 runStore 不持久化（会话运行态），退化为普通工具体
  // （参数行 + 摘要/结果），与未接子瀑布前的行为完全一致
  if (!run) return <ToolBody node={node} />
  return <SubAgentRunView node={node} run={run} depth={depth} />
})

/** as_task 任务会话派遣节点判定（结果/参数双源，见 SubAgentFlow 注释） */
function isTaskSessionNode(node: ToolNode): boolean {
  if ((node.result as { taskConversationId?: unknown } | null | undefined)?.taskConversationId != null) {
    return true
  }
  if (!node.args) return false
  try {
    return (JSON.parse(node.args) as { as_task?: unknown }).as_task === true
  } catch {
    return false
  }
}

/** FlowNode 判定用：是否为子 Agent 派遣节点（普通 boolean——type predicate 的负分支会把
 *  shouldAutoOpen 里后续的 tool 分支窄化成 never；调用处本就有判别联合窄化，无需守卫）。
 *  2026-08-01：统一 agent 工具收编 explore_agent——两个工具名都认（历史会话里仍有旧节点）。 */
export function isSubAgentToolNode(node: RenderNode): boolean {
  return (
    node.type === 'tool' &&
    (node.toolName === EXPLORE_AGENT_TOOL_NAME || node.toolName === AGENT_TOOL_NAME)
  )
}

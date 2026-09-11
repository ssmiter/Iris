import { create } from 'zustand'

/**
 * 子 Agent 运行记录（explore_agent 等）。
 *
 * 定位：逻辑层唯一事实源——子 Agent 生命周期事件在这里沉淀，
 * 瀑布流/UI 层（专门的前端任务）只读这里做渲染，不在工具执行路径里塞视觉逻辑。
 * 不持久化：记录是本次会话的运行态，对话历史里已有工具结果文本兜底。
 */

export type SubAgentRunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface SubAgentToolEvent {
  toolCallId: string
  name: string
  status: 'running' | 'done' | 'error'
  /** 完成时的一行摘要（结果首行 / 错误首行） */
  summary?: string
  at: number
  /** 终态时间（done/error）；与 at 相减得耗时，供 UI 逐步耗时展示 */
  endedAt?: number
}

export interface SubAgentRunRecord {
  runId: string
  /** 子 Agent 类型：explore（只读探索）；预留 analysis/general 等后续类型 */
  kind: string
  /** 所属会话（UI 按会话过滤，避免跨会话混排） */
  conversationId?: number
  /** 任务会话 id（kind='task' 的 as_task 派遣）：任务会话内实况渲染与胶囊条排除的判别依据 */
  taskConversationId?: number
  /** 发起它的父瀑布工具调用 id（2026-08-01 显式挂靠接缝，SubAgentFlow 挂靠链第①级） */
  parentToolCallId?: string
  /** 触发任务（主 Agent 写给子 Agent 的自足描述） */
  task: string
  thoroughness: string
  status: SubAgentRunStatus
  /** 排队耗时（semaphore 等待），体验问题排查用 */
  queuedAt: number
  startedAt?: number
  endedAt?: number
  toolEvents: SubAgentToolEvent[]
  /** 子 Agent 运行期间新发现（read_capability 加载）的工具名 */
  discoveredNames: string[]
  /** 最新进展一行（2026-08-01：异步模式下父工具节点秒回、executionLog 不再供料，
   *  进度行改由运行体直接写 store——UI"当前在做什么"的稳定数据源，与同步/异步无关） */
  liveLine?: string
  /** 本 run 触碰过的文件路径（写工具包装器在执行前记录，通用 agent 冲突可见用） */
  touchedFiles: string[]
  /** 与同会话其他并行 run 的触碰面交集提示（完成时由运行体计算写入） */
  conflictNote?: string
  report?: string
  /** 报告全文落盘路径（/workspace/outputs/subagent_reports/），可追溯复核 */
  reportPath?: string
  /** 子 loop 轨迹落盘路径（.trace.json），行为漂移/幻觉排查依据；
   *  也是"完整子对话"视图的数据源（按需懒加载，不常驻内存） */
  tracePath?: string
  error?: string
}

interface SubAgentRunState {
  runs: Record<string, SubAgentRunRecord>
  /** 插入顺序（渲染稳定序），最新在尾 */
  order: string[]
  enqueueRun: (rec: Pick<SubAgentRunRecord, 'runId' | 'task' | 'thoroughness'> & { kind?: string; conversationId?: number; parentToolCallId?: string; taskConversationId?: number }) => void
  markRunning: (runId: string) => void
  addToolEvent: (runId: string, ev: SubAgentToolEvent) => void
  updateToolEvent: (runId: string, toolCallId: string, patch: Partial<SubAgentToolEvent>) => void
  addDiscoveredNames: (runId: string, names: string[]) => void
  /** 更新最新进展一行（运行体直写，替代异步模式下缺席的 executionLog 供料） */
  setLiveLine: (runId: string, line: string) => void
  /** 记录本 run 写工具触碰的文件路径（去重；通用 agent 冲突交集数据源） */
  addTouchedFile: (runId: string, path: string) => void
  finishRun: (runId: string, patch: { status: SubAgentRunStatus; report?: string; reportPath?: string; tracePath?: string; error?: string; conflictNote?: string }) => void
}

/** 终态记录 LRU 上限：长会话高频委派时防 runs/order 无界增长（进行中的全保留） */
const MAX_FINISHED_RUNS = 20

const TERMINAL_STATUSES: ReadonlySet<SubAgentRunStatus> = new Set(['done', 'error', 'cancelled'])

export const useSubAgentRunStore = create<SubAgentRunState>()((set) => ({
  runs: {},
  order: [],

  enqueueRun: (rec) =>
    set((s) => ({
      runs: {
        ...s.runs,
        [rec.runId]: {
          kind: 'explore',
          ...rec,
          status: 'queued',
          queuedAt: Date.now(),
          toolEvents: [],
          discoveredNames: [],
          touchedFiles: [],
        },
      },
      order: [...s.order, rec.runId],
    })),

  markRunning: (runId) =>
    set((s) => {
      const rec = s.runs[runId]
      if (!rec) return s
      return { runs: { ...s.runs, [runId]: { ...rec, status: 'running', startedAt: Date.now() } } }
    }),

  addToolEvent: (runId, ev) =>
    set((s) => {
      const rec = s.runs[runId]
      if (!rec) return s
      return { runs: { ...s.runs, [runId]: { ...rec, toolEvents: [...rec.toolEvents, ev] } } }
    }),

  updateToolEvent: (runId, toolCallId, patch) =>
    set((s) => {
      const rec = s.runs[runId]
      if (!rec) return s
      return {
        runs: {
          ...s.runs,
          [runId]: {
            ...rec,
            toolEvents: rec.toolEvents.map((ev) =>
              ev.toolCallId === toolCallId
                ? { ...ev, ...patch, endedAt: patch.status && !ev.endedAt ? Date.now() : (patch.endedAt ?? ev.endedAt) }
                : ev
            ),
          },
        },
      }
    }),

  addDiscoveredNames: (runId, names) =>
    set((s) => {
      const rec = s.runs[runId]
      if (!rec) return s
      const merged = new Set([...rec.discoveredNames, ...names.map((n) => n.toLowerCase())])
      return { runs: { ...s.runs, [runId]: { ...rec, discoveredNames: Array.from(merged) } } }
    }),

  setLiveLine: (runId, line) =>
    set((s) => {
      const rec = s.runs[runId]
      if (!rec) return s
      return { runs: { ...s.runs, [runId]: { ...rec, liveLine: line } } }
    }),

  addTouchedFile: (runId, path) =>
    set((s) => {
      const rec = s.runs[runId]
      if (!rec || rec.touchedFiles.includes(path)) return s
      return { runs: { ...s.runs, [runId]: { ...rec, touchedFiles: [...rec.touchedFiles, path] } } }
    }),

  finishRun: (runId, patch) =>
    set((s) => {
      const rec = s.runs[runId]
      if (!rec) return s
      const runs: SubAgentRunState['runs'] = { ...s.runs, [runId]: { ...rec, ...patch, endedAt: Date.now() } }
      let order = s.order
      const terminalIds = order.filter((id) => {
        const st = runs[id]?.status
        return st != null && TERMINAL_STATUSES.has(st)
      })
      if (terminalIds.length > MAX_FINISHED_RUNS) {
        const drop = new Set(terminalIds.slice(0, terminalIds.length - MAX_FINISHED_RUNS))
        order = order.filter((id) => !drop.has(id))
        for (const id of drop) delete runs[id]
      }
      return { runs, order }
    }),
}))

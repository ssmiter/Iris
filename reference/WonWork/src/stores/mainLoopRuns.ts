import { create } from 'zustand'
import type { AgenticLoopHandle } from '@/agent/agenticLoop'
import type { ChatMessage } from '@/types/chat'

/**
 * 主对话 loop 运行注册表（2026-09-04 会话后台化）。
 *
 * 此前主 loop 是模块级单例（currentLoopHandle 等四个变量），切会话第一步就是
 * stopStreaming() 杀掉它——"切走再回来任务消失"的总根因。本会话化后：
 * - 每个 conversationId 至多一个 run，句柄按会话键控，切视图不动 loop；
 * - 子代理/任务会话早就是这个形态（subAgentManager 自持 controller），本模块把
 *   主对话拉齐到同一语义：进不进会话只是前端渲染差别，agent 逻辑一直跑并落库；
 * - 多会话并行由此自然成立（A 在跑时切到 B 发消息，两个 run 各跑各的）。
 *
 * 句柄不可序列化，存活于模块级 Map；runningIds 是 zustand 镜像，专供 UI 订阅
 * （侧栏"运行中"徽标、isStreaming 派生）。
 */

export interface MainLoopRun {
  conversationId: number
  /** turn 级中断控制器：sendMessage 前置段（loop 句柄未创建）与 loop 期共用同一中断源 */
  turnController: AbortController
  /** loop 启动后回填（startAgenticLoop 返回） */
  handle: AgenticLoopHandle | null
  /** loop 前置段的可取消回调（原 currentAbortController 等价物，如标题生成外的在途请求） */
  preLoopAbort: (() => void) | null
  /** 三路径共用的本轮成果落盘（幂等） */
  persistLoop: (() => Promise<void>) | null
  /** 增量落库（pagehide 兜底用） */
  flushLoop: ((includeCurrent: boolean) => Promise<void>) | null
  startedAt: number
}

const runs = new Map<number, MainLoopRun>()

interface MainLoopRunMirrorState {
  /** 有活跃主 loop 的会话 id 列表（UI 订阅用） */
  runningIds: number[]
}

export const useMainLoopRunStore = create<MainLoopRunMirrorState>(() => ({
  runningIds: [],
}))

function syncMirror(): void {
  useMainLoopRunStore.setState({ runningIds: [...runs.keys()] })
}

/** sendMessage 前置段起点登记（turnController 先于 loop 存在，claude-code REPL 同款语义） */
export function beginMainLoopRun(conversationId: number, turnController: AbortController): MainLoopRun {
  const run: MainLoopRun = {
    conversationId,
    turnController,
    handle: null,
    preLoopAbort: null,
    persistLoop: null,
    flushLoop: null,
    startedAt: Date.now(),
  }
  runs.set(conversationId, run)
  syncMirror()
  return run
}

export function getMainLoopRun(conversationId: number | null | undefined): MainLoopRun | undefined {
  return conversationId == null ? undefined : runs.get(conversationId)
}

export function hasMainLoopRun(conversationId: number | null | undefined): boolean {
  return conversationId != null && runs.has(conversationId)
}

/** 注销 run。返回 false = 已注销过（stop 路径已结算，onDone/onError 应跳过重复结算） */
export function endMainLoopRun(conversationId: number): boolean {
  const existed = runs.delete(conversationId)
  if (existed) syncMirror()
  return existed
}

/**
 * 强制中断并注销（删除会话等无主路径）。正常停止走 chatStore.stopStreaming（含视图结算+落盘）。
 * 2026-09-04 审查修复：abort 前先把已封口的轮次落盘——abort 后 onError 路径仍会调
 * persistLoop 收尾，但那是异步的；删除会话紧随其后（先删后端会话再落库=写进已删会话的
 * 乱序行），故这里同步触发一次 flush 并在调用方 await 后再删。正在流式增长的当前轮
 * 不强行落盘（半截 assistant 消息落库反而污染历史），随 abort 丢弃是诚实语义。
 */
export function abortMainLoopRun(conversationId: number): Promise<void> {
  const run = runs.get(conversationId)
  if (!run) return Promise.resolve()
  const flushPromise = run.flushLoop
    ? run.flushLoop(false).catch((err) => console.warn('[mainLoopRuns] abort 前落盘失败:', err))
    : Promise.resolve()
  try { run.preLoopAbort?.() } catch { /* 结算路径不因单点失败中断 */ }
  try { run.turnController.abort() } catch { /* 同上 */ }
  try { run.handle?.abort() } catch { /* 同上 */ }
  runs.delete(conversationId)
  syncMirror()
  return flushPromise
}

export function listMainLoopRuns(): MainLoopRun[] {
  return [...runs.values()]
}

// ===== 会话视图 stash：后台会话的视图态临时家园 =====

/**
 * 视图切片：随会话走（而非随全局）的 chatStore 字段。
 * 切走时有 run 的会话把这些字段从 store 移入 stash；loop 回调经路由层
 * （chatStore.createConversationViewRouter）在"当前写 store / 后台写 stash"间分流。
 */
export interface ConversationViewSlice {
  messages: ChatMessage[]
  queuedMessages: Array<{ id: string; text: string; kind?: 'user' | 'system' }>
  pendingSupplements: Array<{ id: string; text: string; injected: boolean; kind?: 'user' | 'system' }>
  branches: Record<string, unknown>
  compactBoundaries: unknown[]
  compactProgress: { trigger: 'manual' | 'auto'; startedAt: number } | null
  compactOutcome: 'failed' | 'cancelled' | null
  pendingCompactAfterTurn: string | null
  currentContextTokens: number
  totalTurns: number | null
  error: string | null
}

export function emptyViewSlice(): ConversationViewSlice {
  return {
    messages: [],
    queuedMessages: [],
    pendingSupplements: [],
    branches: {},
    compactBoundaries: [],
    compactProgress: null,
    compactOutcome: null,
    pendingCompactAfterTurn: null,
    currentContextTokens: 0,
    totalTurns: null,
    error: null,
  }
}

const stashes = new Map<number, ConversationViewSlice>()

/** 切走时保存（覆盖式——视图只可能从一个地方离开） */
export function saveViewStash(conversationId: number, slice: ConversationViewSlice): void {
  stashes.set(conversationId, slice)
}

/** 切入时取出并清除（视图接管后 stash 使命完成，回调将直写 store） */
export function takeViewStash(conversationId: number): ConversationViewSlice | undefined {
  const s = stashes.get(conversationId)
  if (s) stashes.delete(conversationId)
  return s
}

/** 后台会话的回调读视图：无 stash 不该发生（run 在必有 stash），兜底给空切片防炸 */
export function peekViewStash(conversationId: number): ConversationViewSlice {
  let s = stashes.get(conversationId)
  if (!s) {
    s = emptyViewSlice()
    stashes.set(conversationId, s)
  }
  return s
}

/** 后台会话的回调写视图：fn 与 store set 同语义（返回 partial 合并） */
export function applyViewStash(
  conversationId: number,
  fn: (view: ConversationViewSlice) => Partial<ConversationViewSlice> | void
): void {
  const s = peekViewStash(conversationId)
  const patch = fn(s)
  if (patch) Object.assign(s, patch)
}

/** 会话被删除时清理（连同 run 一起由调用方先停） */
export function dropViewStash(conversationId: number): void {
  stashes.delete(conversationId)
}

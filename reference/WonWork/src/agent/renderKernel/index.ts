/**
 * renderKernel — 瀑布流渲染内核
 *
 * Phase 1（事件与纯函数）实现了：
 * - RenderEvent 标准化信封
 * - EventLog 事件日志
 * - TurnProjector 纯函数投影器
 * - ProjectedBuilder 兼容层（实现 RenderNodeBuilder 接口）
 *
 * 设计依据：wonwork-render-kernel-design-v2.0.md
 */

export { type RenderEvent, type RawRenderEvent, type NodeEnvelope, type NodeDoneMeta, type ErrorInfo, type ArtifactPayload, type AttentionPayload, eventFactory } from './renderEvent'
export { EventLog } from './eventLog'
export { project, type TurnState, isSettled, computeSegFlowed } from './turnProjector'
export { createProjectedBuilder, type ProjectedBuilder } from './projectedBuilder'
export { plan, applyOps, type RenderOp } from './batchPlanner'
export { RenderScheduler, type SchedulerCallbacks, type SchedulerEventKind } from './renderScheduler'

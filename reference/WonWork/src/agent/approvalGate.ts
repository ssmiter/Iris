import type { ApprovalRequest, ToolRiskLevel } from './types'

/**
 * 审批闸
 *
 * 职责：在工具执行前暂停并等待用户人工确认。
 * - 每个高风险 tool_call 生成一个 ApprovalRequest
 * - 通过 onApprovalRequested 回调把请求和 resolve 函数暴露给 UI
 * - UI 调用 resolve(true/false) 后，对应 Promise 完成，工具执行继续/取消
 *
 * 设计原则：
 * - 不依赖具体 UI 框架，只通过回调通信。
 * - 同一 toolCallId 重复请求时返回同一个 Promise，避免竞态。
 * - abort 时自动 reject 所有 pending approval，防止内存泄漏。
 */

export type ApprovalResolve = (approved: boolean, reason?: string) => void

export interface ApprovalDecision {
  toolCallId: string
  approved: boolean
  reason?: string
}

export interface ApprovalGateCallbacks {
  onApprovalRequested: (request: ApprovalRequest, resolve: ApprovalResolve) => void
}

export interface ApprovalGate {
  requestApproval(request: ApprovalRequest): Promise<boolean>
  resolve(toolCallId: string, approved: boolean, reason?: string): void
  abort(): void
  getDecisions(): ApprovalDecision[]
}

export function createApprovalGate(callbacks: ApprovalGateCallbacks): ApprovalGate {
  const pending = new Map<string, { resolve: ApprovalResolve; rejected: boolean }>()
  const decisions: ApprovalDecision[] = []
  // 同一 toolCallId 的终态决策（含拒绝）。重复请求必须复用终态，
  // 否则"并发重复审批 + 用户拒绝"会让第二路请求错误放行。
  const settled = new Map<string, boolean>()

  function recordDecision(toolCallId: string, approved: boolean, reason?: string): void {
    if (!approved) return
    decisions.push({ toolCallId, approved: true, reason })
  }

  function requestApproval(request: ApprovalRequest): Promise<boolean> {
    const prior = settled.get(request.toolCallId)
    if (prior !== undefined) {
      return Promise.resolve(prior)
    }
    const existing = pending.get(request.toolCallId)
    if (existing) {
      // 同一 toolCallId 已有挂起请求：跟随其终态，绝不自行放行
      return new Promise((resolve) => {
        const check = () => {
          const final = settled.get(request.toolCallId)
          if (final !== undefined) {
            resolve(final)
            return
          }
          if (!pending.has(request.toolCallId)) {
            resolve(false)
            return
          }
          setTimeout(check, 50)
        }
        check()
      })
    }

    return new Promise<boolean>((resolve) => {
      pending.set(request.toolCallId, { resolve, rejected: false })
      callbacks.onApprovalRequested(request, (approved, reason) => {
        const entry = pending.get(request.toolCallId)
        if (!entry) return
        if (!approved) {
          entry.rejected = true
        }
        settled.set(request.toolCallId, approved)
        recordDecision(request.toolCallId, approved, reason)
        entry.resolve(approved, reason)
        pending.delete(request.toolCallId)
      })
    })
  }

  function resolve(toolCallId: string, approved: boolean, reason?: string): void {
    const entry = pending.get(toolCallId)
    if (!entry) return
    if (!approved) {
      entry.rejected = true
    }
    settled.set(toolCallId, approved)
    recordDecision(toolCallId, approved, reason)
    entry.resolve(approved, reason)
    pending.delete(toolCallId)
  }

  function abort(): void {
    for (const [toolCallId, entry] of pending) {
      entry.rejected = true
      settled.set(toolCallId, false)
      entry.resolve(false, '用户中断')
      pending.delete(toolCallId)
    }
  }

  function getDecisions(): ApprovalDecision[] {
    return [...decisions]
  }

  return {
    requestApproval,
    resolve,
    abort,
    getDecisions,
  }
}

/**
 * 判断工具风险等级是否需要人工审批。
 *
 * 当前策略：
 * - read_only / standard：无需审批
 * - elevated / destructive：必须审批
 */
export function requiresApproval(riskLevel: ToolRiskLevel): boolean {
  return riskLevel === 'elevated' || riskLevel === 'destructive'
}

/**
 * 反问闸（clarify gate）
 *
 * 职责：模型调用 ask_user 工具时暂停执行并等待用户作答。
 * - 每次调用生成一个 ClarifyRequest
 * - 通过 onClarifyRequested 回调把请求暴露给 UI（脊柱 clarify attention 卡）
 * - UI 提交答案（点 chip / 内联输入）后，对应 Promise 完成，答案作为 tool result 返回模型
 *
 * 结构逐行镜像 approvalGate.ts：
 * - 不依赖具体 UI 框架，只通过回调通信。
 * - 同一 toolCallId 重复请求时返回同一个终态，避免竞态。
 * - abort 时自动结算所有 pending，防止挂起泄漏（Stop 按钮 / 会话切换同链）。
 */

export interface ClarifyRequest {
  toolCallId: string
  question: string
  options: string[]
  /** 与 options 平行的可选描述数组（chip tooltip / 副行小字） */
  hints?: string[]
}

export interface ClarifyOutcome {
  answered: boolean
  value?: string
  /** 未作答时的原因（如 '用户中断'） */
  reason?: string
}

export interface ClarifyGateCallbacks {
  onClarifyRequested: (request: ClarifyRequest) => void
}

export interface ClarifyGate {
  requestClarify(request: ClarifyRequest): Promise<ClarifyOutcome>
  resolve(toolCallId: string, value: string): void
  abort(): void
  readonly pendingCount: number
}

export function createClarifyGate(callbacks: ClarifyGateCallbacks): ClarifyGate {
  const pending = new Map<string, { resolve: (outcome: ClarifyOutcome) => void }>()
  // 同一 toolCallId 的终态。重复请求必须复用终态，避免重复上卡 / 双重结算。
  const settled = new Map<string, ClarifyOutcome>()

  function settle(toolCallId: string, outcome: ClarifyOutcome): ClarifyOutcome {
    settled.set(toolCallId, outcome)
    return outcome
  }

  function requestClarify(request: ClarifyRequest): Promise<ClarifyOutcome> {
    const prior = settled.get(request.toolCallId)
    if (prior !== undefined) {
      return Promise.resolve(prior)
    }
    const existing = pending.get(request.toolCallId)
    if (existing) {
      // 同一 toolCallId 已有挂起请求：跟随其终态
      return new Promise((resolve) => {
        const check = () => {
          const final = settled.get(request.toolCallId)
          if (final !== undefined) {
            resolve(final)
            return
          }
          if (!pending.has(request.toolCallId)) {
            resolve({ answered: false, reason: '用户中断' })
            return
          }
          setTimeout(check, 50)
        }
        check()
      })
    }

    return new Promise<ClarifyOutcome>((resolve) => {
      pending.set(request.toolCallId, { resolve })
      callbacks.onClarifyRequested(request)
    })
  }

  function resolve(toolCallId: string, value: string): void {
    const entry = pending.get(toolCallId)
    if (!entry) return
    entry.resolve(settle(toolCallId, { answered: true, value }))
    pending.delete(toolCallId)
  }

  function abort(): void {
    for (const [toolCallId, entry] of pending) {
      entry.resolve(settle(toolCallId, { answered: false, reason: '用户中断' }))
      pending.delete(toolCallId)
    }
  }

  return {
    requestClarify,
    resolve,
    abort,
    get pendingCount() {
      return pending.size
    },
  }
}

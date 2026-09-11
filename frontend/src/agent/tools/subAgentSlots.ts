/**
 * 子 Agent 共享并发信号量（2026-08-01 多 Agent 第二步从 exploreAgentRun 提取）。
 *
 * 跨类型（explore/general）跨会话共享同一上限：每个子 Agent 都是一条独立的
 * LLM 流+工具执行链，总池限 3 防资源爆炸（claude-code 无硬上限，
 * 但我们的子 Agent 全部跑在同一前端进程里，必须自我约束）。
 * 排队可被中断（abort 时从等待队列摘除并 reject）。
 */

const MAX_CONCURRENT_SUBAGENTS = 3

let activeCount = 0
const waiters: Array<() => void> = []

export async function acquireSubAgentSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw new Error('已中断')
  if (activeCount >= MAX_CONCURRENT_SUBAGENTS) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        const idx = waiters.indexOf(wake)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(new Error('已中断'))
      }
      waiters.push(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  activeCount++
  let released = false
  return () => {
    if (released) return
    released = true
    activeCount--
    waiters.shift()?.()
  }
}

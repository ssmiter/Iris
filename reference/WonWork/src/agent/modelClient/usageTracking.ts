import { useUsageStore, buildTodayUsageRecord } from '@/stores/usageStore'
import { estimateTextTokens } from '@/utils/tokenEstimator'
import type { ModelClientRequest, ModelClientStreamCallbacks } from './modelClient'

/**
 * 用量统计回调包装（2026-07-31 收敛）：四家 modelClient 共用同一份实现
 * （原先 anthropic/openai/local 各存一份副本，backendProxy 反向 import anthropic 的）。
 * 优先采用流末 chunk 携带的真实 usage；缺失时回退文本估算。
 */
export function createUsageTrackingCallbacks(
  request: ModelClientRequest,
  userCallbacks: ModelClientStreamCallbacks
): {
  callbacks: ModelClientStreamCallbacks
  reportUsage: () => void
} {
  let outputText = ''
  let realTokensIn: number | undefined
  let realTokensOut: number | undefined

  const reportUsage = () => {
    const inputText = request.messages.map((m) => m.content).join('\n')
    const tokensIn = realTokensIn ?? estimateTextTokens(inputText)
    const tokensOut = realTokensOut ?? estimateTextTokens(outputText)
    if (tokensIn > 0 || tokensOut > 0) {
      useUsageStore.getState().report(
        buildTodayUsageRecord({
          tokensIn,
          tokensOut,
          apiCalls: 1,
        })
      )
    }
  }

  const callbacks: ModelClientStreamCallbacks = {
    onChunk: (chunk) => {
      if (chunk.type === 'content') {
        outputText += chunk.content || ''
      } else if (chunk.type === 'usage' && chunk.usage) {
        if (typeof chunk.usage.tokensIn === 'number') realTokensIn = chunk.usage.tokensIn
        if (typeof chunk.usage.tokensOut === 'number') realTokensOut = chunk.usage.tokensOut
      }
      userCallbacks.onChunk(chunk)
    },
    onError: (error) => userCallbacks.onError(error),
    onDone: () => {
      reportUsage()
      userCallbacks.onDone()
    },
  }

  return { callbacks, reportUsage }
}

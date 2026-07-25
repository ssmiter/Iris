import type { PipelineDefinition, PipelineTransportOptions } from '@/agent/pipelineRunner'
import { runPipeline, createPipelineTransport } from '@/agent/pipelineRunner'
import { buildSessionTitlePrompt, type SessionTitleInput } from './prompt'
import { useConversationStore } from '@/stores/conversationStore'
import { isDefaultTitle } from '@/utils/conversationTitle'

/**
 * 会话标题 pipeline
 *
 * 输入：最近消息片段 + 附件名（可选）
 * 输出：{ title: string }
 */
export interface SessionTitlePipelineOutput {
  title: string
}

export const sessionTitlePipeline: PipelineDefinition<SessionTitleInput, SessionTitlePipelineOutput> = {
  name: 'session_title',
  buildPrompt: buildSessionTitlePrompt,
  output: {
    kind: 'json',
    parse: (value) => {
      if (
        value &&
        typeof value === 'object' &&
        'title' in value &&
        typeof (value as Record<string, unknown>).title === 'string'
      ) {
        const title = (value as Record<string, unknown>).title as string
        const trimmed = title.trim().replace(/[，。！？、；：“”‘’（）【】\n\r]/g, '')
        if (trimmed.length >= 2 && trimmed.length <= 12) {
          return { title: trimmed }
        }
      }
      return null
    },
  },
  maxTokens: 256,
  temperature: 0.3,
  maxRetries: 2,
  timeoutMs: 30_000,
}

// conversationId -> AbortController，用于取消在途标题生成
const sessionTitleControllers = new Map<number, AbortController>()

export interface SessionTitleTransportOptions extends Omit<PipelineTransportOptions, 'conversationId'> {
  conversationId: number
}

/**
 * 生成会话标题并写回会话列表。
 *
 * - 失败静默，不影响主对话。
 * - 写回前校验 conversationId 是否仍为当前活跃会话。
 * - 自动生成时（autoOnly=true）只在标题仍为默认标题时才写回。
 */
export async function generateSessionTitle(
  input: SessionTitleInput,
  conversationId: number,
  transportOpts: SessionTitleTransportOptions,
  options?: { autoOnly?: boolean }
): Promise<void> {
  // 1. 取消同一会话的旧请求
  const oldController = sessionTitleControllers.get(conversationId)
  if (oldController && !oldController.signal.aborted) {
    oldController.abort(new Error('新标题请求开始，取消旧请求'))
  }
  const controller = new AbortController()
  sessionTitleControllers.set(conversationId, controller)

  const transport = createPipelineTransport({
    provider: transportOpts.provider,
    apiKey: transportOpts.apiKey,
    baseUrl: transportOpts.baseUrl,
    conversationId: transportOpts.conversationId,
    systemCode: transportOpts.systemCode,
    executionMode: transportOpts.executionMode,
    enableFrontendToolLoop: transportOpts.enableFrontendToolLoop,
  })

  try {
    const result = await runPipeline(sessionTitlePipeline, input, transport, {
      signal: controller.signal,
    })

    if (!result.ok || !result.value) return

    const { title } = result.value

    // 2. 校验仍是当前会话
    const conversationStore = useConversationStore.getState()
    const currentConversationId = conversationStore.currentConversationId
    if (currentConversationId !== conversationId) return

    // 3. 自动生成时，若用户已手动修改标题则不覆盖
    if (options?.autoOnly) {
      const currentConversation = conversationStore.getCurrentConversation()
      if (!currentConversation || !isDefaultTitle(currentConversation.title)) return
    }

    await conversationStore.updateConversationTitle(conversationId, title)
  } catch {
    // pipeline 本身已静默，但这里再兜一次
  } finally {
    sessionTitleControllers.delete(conversationId)
  }
}

/**
 * 取消指定会话在途的标题生成请求。
 */
export function abortSessionTitleGeneration(conversationId: number): void {
  const controller = sessionTitleControllers.get(conversationId)
  if (controller && !controller.signal.aborted) {
    controller.abort(new Error('会话切换或停止生成'))
  }
  sessionTitleControllers.delete(conversationId)
}

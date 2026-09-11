import type { PipelineDefinition, PipelineTransportOptions } from '@/agent/pipelineRunner'
import { runPipeline, createPipelineTransport } from '@/agent/pipelineRunner'
import { buildSessionTitlePrompt, type SessionTitleInput } from './prompt'
import { useConversationStore } from '@/stores/conversationStore'
import { useTitleRefreshStore } from '@/stores/conversationTitleStore'
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
        let trimmed = title.trim().replace(/[，。！？、；：“”‘’（）【】\n\r]/g, '')
        // 与 prompt 的「最长 15 字」对齐（2026-08-14 用户拍板：6-13 为宜）。
        // 超长不判失败——标题是装饰性产物，截断永远优于让一次成功生成被丢弃。
        if (trimmed.length >= 2) {
          if (trimmed.length > 15) trimmed = trimmed.slice(0, 15)
          return { title: trimmed }
        }
      }
      return null
    },
  },
  // 4000（2026-08-14 用户拍板）：推理系模型的思考过程也吃 maxTokens，
  // 小额度会被思考耗光导致正文为空、parse_failed（当天实测踩中）。
  // 标题 JSON 本身只需几十 token，大额度不增加正常路径成本。
  maxTokens: 4000,
  temperature: 0.3,
  maxRetries: 2,
  timeoutMs: 30_000,
}

// conversationId -> AbortController，用于取消在途标题生成
const sessionTitleControllers = new Map<number, AbortController>()

export interface SessionTitleTransportOptions extends Omit<PipelineTransportOptions, 'conversationId'> {
  conversationId: number
}

/** 生成结果：ok=false 时 error 区分原因（调用方据此决定提示口径） */
export interface SessionTitleResult {
  ok: boolean
  /** 'aborted'=被更新的请求取代 | 'skipped'=自动路径主动放弃 | 'circuit_open'=熔断中 | 其他=pipeline 错误 */
  error?: string
}

/**
 * 生成会话标题并写回会话列表。
 *
 * - 失败静默（返回 false，不抛出），不影响主对话；手动刷新场景的失败提示
 *   由调用方（chatStore.refreshConversationTitle manual 分支）负责。
 * - 进行中会登记 useTitleRefreshStore（侧栏标题左侧 spinner 据此渲染）。
 * - 写回前校验（仅自动生成时）：conversationId 仍为当前活跃会话。
 * - 自动生成时（autoOnly=true）只在标题仍为默认标题时才写回。
 */
export async function generateSessionTitle(
  input: SessionTitleInput,
  conversationId: number,
  transportOpts: SessionTitleTransportOptions,
  options?: { autoOnly?: boolean }
): Promise<SessionTitleResult> {
  // 1. 取消同一会话的旧请求
  const oldController = sessionTitleControllers.get(conversationId)
  if (oldController && !oldController.signal.aborted) {
    oldController.abort(new Error('新标题请求开始，取消旧请求'))
  }
  const controller = new AbortController()
  sessionTitleControllers.set(conversationId, controller)
  useTitleRefreshStore.getState().markRefreshing(conversationId)

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

    if (!result.ok || !result.value) {
      // aborted 是被更新的点击取代，属正常；其余原因留痕便于排查
      // （熔断 circuit_open / 超时 / 解析失败都曾表现为"点了没反应"）
      if (result.error && result.error !== 'aborted') {
        console.warn(`[sessionTitle] 生成失败：${result.error}（attempts=${result.attempts}）`)
      }
      return { ok: false, error: result.error ?? 'unknown' }
    }

    const { title } = result.value

    // 2. 自动生成时校验仍是当前会话（用户切走了就不打扰）；
    // 手动刷新（autoOnly=false）按 id 写回目标会话即可——右键菜单可以刷新
    // 非当前会话，此时它本就不是活跃会话，不能因此被丢弃。
    if (options?.autoOnly) {
      const conversationStore = useConversationStore.getState()
      if (conversationStore.currentConversationId !== conversationId) return { ok: false, error: 'skipped' }

      // 若用户已手动修改标题则不覆盖
      const currentConversation = conversationStore.getCurrentConversation()
      if (!currentConversation || !isDefaultTitle(currentConversation.title)) return { ok: false, error: 'skipped' }
    }

    await useConversationStore.getState().updateConversationTitle(conversationId, title)
    return { ok: true }
  } catch (err) {
    // pipeline 本身已静默，但这里再兜一次
    console.warn('[sessionTitle] 生成异常：', err)
    return { ok: false, error: 'exception' }
  } finally {
    // 竞态护栏：本请求可能已被更新的请求 supersede（旧请求 finally 不能清掉
    // 新请求的 controller 登记与 spinner 状态）
    if (sessionTitleControllers.get(conversationId) === controller) {
      sessionTitleControllers.delete(conversationId)
      useTitleRefreshStore.getState().clearRefreshing(conversationId)
    }
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

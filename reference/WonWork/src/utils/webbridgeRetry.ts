import { chatApi } from '@/api/client'
import { useChatStore } from '@/stores/chatStore'
import { getWebBridgeRetryPrompt, extractWebBridgeWorkflowSafe, sanitizeControlCharacters } from '@/utils/webbridgePrompt'
import type { Message } from '@/types/mescli'
import type { BrowserAction } from '@/types/webbridge'

export interface WebBridgeRetryContext {
  error: string
  url: string
  title: string
  text?: string
  screenshot?: string
}

export async function requestWebBridgeRetryWorkflow(
  context: WebBridgeRetryContext
): Promise<{ jsonText: string | null; actions: BrowserAction[] }> {
  const provider = useChatStore.getState().activeProvider
  if (!provider) {
    return { jsonText: null, actions: [] }
  }

  const pageStateText = JSON.stringify(
    {
      url: context.url,
      title: context.title,
      text: context.text ? context.text.slice(0, 3000) : '',
      hasScreenshot: !!context.screenshot,
    },
    null,
    2
  )

  const messages: Message[] = [
    { role: 'system', content: getWebBridgeRetryPrompt() },
    {
      role: 'user',
      content: `错误：${context.error}\n\n当前页面状态：\n\`\`\`json\n${pageStateText}\n\`\`\``,
    },
  ]

  return new Promise((resolve, reject) => {
    let collected = ''
    const abort = chatApi.streamChat(
      {
        provider: provider.provider,
        model: provider.model,
        baseUrl: provider.baseUrl,
        messages,
        saveToHistory: false,
      },
      (chunk) => {
        if (chunk.type === 'content') {
          collected += chunk.content || ''
        } else if (chunk.type === 'error') {
          reject(new Error(chunk.content || '请求失败'))
        }
      },
      (error) => {
        reject(error)
      },
      () => {
        const { jsonText, parseError } = extractWebBridgeWorkflowSafe(collected)
        if (parseError) {
          console.warn('重试工作流 JSON 解析需要清理:', parseError)
        }
        if (!jsonText) {
          resolve({ jsonText: null, actions: [] })
          return
        }
        try {
          const parsed = JSON.parse(sanitizeControlCharacters(jsonText)) as {
            steps?: Array<{ actions?: BrowserAction[] }>
          }
          const actions = parsed.steps?.flatMap((s) => s.actions || []) || []
          resolve({ jsonText, actions })
        } catch {
          resolve({ jsonText, actions: [] })
        }
      }
    )

    setTimeout(() => {
      abort()
      reject(new Error('重试请求超时'))
    }, 30000)
  })
}

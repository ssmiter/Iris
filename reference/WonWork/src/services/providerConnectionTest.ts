import { createBackendProxyModelClient } from '@/agent/modelClient/backendProxyModelClient'

export interface ProviderConnectionTestOptions {
  provider: string
  model: string
  apiKey: string
  baseUrl: string
  timeoutMs?: number
}

/**
 * 通过与正式对话相同的本机后端代理验证 Provider。
 * 生产包不能从浏览器直接请求第三方 Provider，否则会被 CORS 拦截；
 * 同时部分 Coding API（如 Ark Code）并不提供通用的 /models 探测接口。
 */
export function testProviderConnection({
  provider,
  model,
  apiKey,
  baseUrl,
  timeoutMs = 30_000,
}: ProviderConnectionTestOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = createBackendProxyModelClient()
    let settled = false
    let abort = () => {}

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      abort()
      if (error) reject(error)
      else resolve()
    }

    const timer = window.setTimeout(() => {
      finish(new Error('连接测试超时，请检查网络、API Key 和模型名称'))
    }, timeoutMs)

    abort = client.streamChat(
      {
        provider,
        model,
        apiKey,
        baseUrl,
        maxTokens: 8,
        saveToHistory: false,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      },
      {
        onChunk: (chunk) => {
          if (chunk.type === 'error') {
            finish(new Error(chunk.content || 'Provider 返回连接错误'))
            return
          }
          if (
            chunk.type === 'content' ||
            chunk.type === 'reasoning' ||
            chunk.type === 'tool_call'
          ) {
            finish()
          }
        },
        onError: finish,
        onDone: () => finish(),
      }
    )
  })
}

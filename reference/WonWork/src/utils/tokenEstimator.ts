import type { Message, FileAttachmentDto } from '@/types/mescli'

/**
 * 上下文窗口猜测值（2026-07-24 统一为 256K）。
 *
 * 配置来源优先级（全部钉在前端，与 api-key 保险柜同哲学，不依赖后端）：
 *   1. 用户显式覆盖（设置页，modelCapabilityRegistry.userOverride）
 *   2. 400 错误学到的精确上限（windowUpperBound，下行校准）
 *   3. 成功请求实测值（windowLowerBound，上行校准）
 *   4. 本函数的模型名猜测
 *   5. 本默认值 256K——2026 年主流模型（Claude/GPT/Kimi/GLM/Qwen）均在 200K 量级，
 *      猜小了会让自动压缩过早触发、猜大了由 400 下行校准自动收紧，后者体验更好。
 */
const MODEL_CONTEXT_WINDOW = 256000

export function getModelContextWindow(model: string): number {
  const m = model.toLowerCase()
  // 1M 档：显式后缀或命名约定（对齐 claude-code 的 [1m] 后缀语义）
  if (
    m.includes('[1m]') ||
    m.includes('1000k') ||
    m.includes('1m-') ||
    m.endsWith('-1m') ||
    m.endsWith('_1m')
  ) return 1000000
  if (m.includes('256k') || m.includes('kimi-for-coding')) return 256000
  if (m.includes('200k')) return 200000
  if (m.includes('128k')) return 128000
  if (m.includes('64k')) return 65536
  if (m.includes('32k')) return 32768
  if (m.includes('8k')) return 8192
  if (m.includes('gpt-4o') || m.includes('gpt-4-turbo')) return 128000
  if (m.includes('claude-3')) return 200000
  // deepseek-v3.1 及以后均为 128K；更老的 64K 型号若误猜，
  // 由 400 下行校准自动收紧一次即永久修正（modelCapabilityRegistry）
  if (m.includes('deepseek')) return 128000
  return MODEL_CONTEXT_WINDOW
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0

  let englishChars = 0
  let cjkChars = 0
  let otherChars = 0

  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjkChars++
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      englishChars++
    } else {
      otherChars++
    }
  }

  const englishTokens = englishChars / 4
  const cjkTokens = cjkChars / 1.5
  const otherTokens = otherChars / 3.5

  return Math.ceil(englishTokens + cjkTokens + otherTokens)
}

function estimateImageTokens(base64Length: number): number {
  const sizeBytes = base64Length * 0.75
  if (sizeBytes < 100 * 1024) return 300
  if (sizeBytes < 500 * 1024) return 600
  return 1000
}

export function estimateMessageTokens(
  message: Message & { attachments?: FileAttachmentDto[] }
): number {
  let tokens = estimateTextTokens(message.content)

  if (message.attachments) {
    for (const att of message.attachments) {
      if (att.type === 'image') {
        tokens += estimateImageTokens(att.data.length)
      } else {
        tokens += estimateTextTokens(att.data)
      }
    }
  }

  tokens += 4
  return tokens
}

export function estimateContextTokens(
  messages: Array<Message & { attachments?: FileAttachmentDto[] }>,
  systemPrompt?: string,
  contextWindow = MODEL_CONTEXT_WINDOW
): { used: number; percentage: number; color: 'green' | 'yellow' | 'red' } {
  let used = 0
  if (systemPrompt) {
    used += estimateTextTokens(systemPrompt) + 4
  }
  for (const msg of messages) {
    used += estimateMessageTokens(msg)
  }

  const percentage = Math.min(100, Math.round((used / contextWindow) * 100))

  let color: 'green' | 'yellow' | 'red' = 'green'
  if (percentage > 90) color = 'red'
  else if (percentage > 70) color = 'yellow'

  return { used, percentage, color }
}

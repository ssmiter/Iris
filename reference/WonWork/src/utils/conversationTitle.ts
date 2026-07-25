/**
 * 会话标题生成器
 *
 * v6.1 M1.2 前端截断方案 A：
 * - 首条用户消息发送后自动生成标题
 * - 零成本、离线可用
 * - 后端 SSE title 事件/LLM 生成标题作为后续增强
 */

const DEFAULT_TITLES = ['新对话', 'New Conversation', '']

/**
 * 判断当前标题是否为默认新建会话标题。
 */
export function isDefaultTitle(title?: string | null): boolean {
  if (!title) return true
  return DEFAULT_TITLES.includes(title.trim())
}

/**
 * 从用户首条消息生成会话标题。
 *
 * 规则：
 * 1. 取前 30 个字符，去除前后空格
 * 2. /remember 命令取命令后的内容
 * 3. /web 命令标题为 "WebBridge 请求"
 * 4. 空内容返回 "新对话"
 */
export function generateConversationTitle(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) return '新对话'

  if (trimmed.startsWith('/remember ')) {
    const body = trimmed.slice('/remember '.length).trim()
    return truncateTitle(body || '记住的信息')
  }

  if (trimmed.startsWith('/web ')) {
    return 'WebBridge 请求'
  }

  if (trimmed.startsWith('/')) {
    const spaceIndex = trimmed.indexOf(' ')
    const command = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)
    const body = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim()
    if (body) {
      return truncateTitle(`${command} ${body}`)
    }
    return truncateTitle(command)
  }

  return truncateTitle(trimmed)
}

function truncateTitle(text: string, maxLength = 30): string {
  if (text.length <= maxLength) return text
  // 优先在语义边界截断（标点、空格）
  const boundary = text.slice(0, maxLength).lastIndexOf(' ')
  if (boundary > maxLength * 0.6) {
    return text.slice(0, boundary) + '...'
  }
  return text.slice(0, maxLength) + '...'
}

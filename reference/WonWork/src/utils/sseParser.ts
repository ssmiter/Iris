/**
 * WonWork SSE 事件协议解析器
 *
 * v6.1 统一事件协议：
 *   event: chunk
 *   id: 123
 *   data: {"type":"text","content":"..."}
 *
 * 兼容旧格式（无 event 字段）：
 *   data: {"type":"text","content":"..."}
 *
 * 解析器输出 { event, id, data }，由消费方按 event 类型分发。
 */

export interface SSEEvent {
  /** 事件类型，旧格式无 event 字段时默认为 'chunk' */
  event: string
  /** 事件 ID，用于连接层续传（Last-Event-ID） */
  id?: string
  /** 事件数据，已解析为对象或字符串 */
  data: unknown
}

interface ParseState {
  buffer: string
  lastEventId?: string
  currentEvent: Partial<SSEEvent>
}

function createInitialState(): ParseState {
  return {
    buffer: '',
    currentEvent: {},
  }
}

/**
 * 将 SSE 原始文本追加到状态并返回解析出的事件列表。
 * 设计为增量式：每次收到新的 SSE 文本块都调用此方法。
 */
export function parseSSEBuffer(state: ParseState, chunk: string): SSEEvent[] {
  state.buffer += chunk
  const events: SSEEvent[] = []
  const lines = state.buffer.split('\n')

  // 保留最后一行（可能不完整）
  state.buffer = lines.pop() || ''

  for (const line of lines) {
    const trimmed = line.trimEnd()

    // 空行表示一个事件结束
    if (trimmed === '') {
      if (state.currentEvent.data !== undefined) {
        const event: SSEEvent = {
          event: state.currentEvent.event || 'chunk',
          id: state.currentEvent.id || state.lastEventId,
          data: state.currentEvent.data,
        }
        if (event.id) {
          state.lastEventId = event.id
        }
        events.push(event)
      }
      state.currentEvent = {}
      continue
    }

    // 注释行，忽略
    if (trimmed.startsWith(':')) {
      continue
    }

    const colonIndex = trimmed.indexOf(':')
    let field: string
    let value: string

    if (colonIndex === -1) {
      field = trimmed
      value = ''
    } else {
      field = trimmed.slice(0, colonIndex)
      // SSE 规范：字段名后的第一个空格是可选的，应被忽略
      value = trimmed.slice(colonIndex + 1).startsWith(' ')
        ? trimmed.slice(colonIndex + 2)
        : trimmed.slice(colonIndex + 1)
    }

    switch (field) {
      case 'event':
        state.currentEvent.event = value
        break
      case 'id':
        state.currentEvent.id = value
        break
      case 'data':
        // data 字段可以出现多次，用换行连接
        if (state.currentEvent.data === undefined) {
          state.currentEvent.data = value
        } else {
          state.currentEvent.data = (state.currentEvent.data as string) + '\n' + value
        }
        break
      case 'retry':
        // retry 字段暂不消费，由重试策略层处理
        break
      default:
        // 未知字段忽略
        break
    }
  }

  return events
}

/**
 * 刷新剩余 buffer，处理流结束时未以空行结尾的事件。
 */
export function flushSSEBuffer(state: ParseState): SSEEvent[] {
  const events: SSEEvent[] = []

  if (state.buffer.trim() !== '') {
    const remainder = parseSSEBuffer(state, '\n\n')
    events.push(...remainder)
  }

  if (state.currentEvent.data !== undefined) {
    const event: SSEEvent = {
      event: state.currentEvent.event || 'chunk',
      id: state.currentEvent.id || state.lastEventId,
      data: state.currentEvent.data,
    }
    if (event.id) {
      state.lastEventId = event.id
    }
    events.push(event)
    state.currentEvent = {}
  }

  state.buffer = ''
  return events
}

/**
 * 便捷函数：一次性解析完整 SSE 文本（仅用于测试）。
 */
export function parseSSEText(text: string): SSEEvent[] {
  const state = createInitialState()
  const events = parseSSEBuffer(state, text)
  events.push(...flushSSEBuffer(state))
  return events
}

export function createSSEParserState(): ParseState {
  return createInitialState()
}

/**
 * 尝试将 SSE 事件数据解析为 JSON。
 * 解析失败时返回原始字符串。
 */
export function parseSSEData(data: unknown): unknown {
  if (typeof data !== 'string') return data
  const trimmed = data.trim()
  if (trimmed === '') return data
  if (trimmed === '[DONE]') return { done: true }
  try {
    return JSON.parse(trimmed)
  } catch {
    return data
  }
}

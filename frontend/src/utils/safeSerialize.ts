/**
 * 安全序列化工具：避免 JSON.stringify / toLiteral 大对象时阻塞主线程
 */

export interface SafeSerializeOptions {
  maxArrayItems?: number
  maxObjectKeys?: number
  maxStringLength?: number
  maxDepth?: number
  arrayMarker?: boolean
}

function truncateValue(value: unknown, depth: number, options: Required<SafeSerializeOptions>): unknown {
  if (depth > options.maxDepth) return '[...]'
  if (value === undefined) return 'undefined'
  if (value === null) return null
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)

  if (typeof value === 'string') {
    if (value.length <= options.maxStringLength) return value
    return value.slice(0, options.maxStringLength) + '...[截断]'
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return []
    const opts = options as Required<SafeSerializeOptions>
    const head = value.slice(0, opts.maxArrayItems).map((v) => truncateValue(v, depth + 1, opts))
    if ((opts.arrayMarker ?? true) && value.length > opts.maxArrayItems) {
      head.push(`...[还有 ${value.length - opts.maxArrayItems} 项]`)
    }
    return head
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    const result: Record<string, unknown> = {}
    keys.slice(0, options.maxObjectKeys).forEach((k) => {
      result[k] = truncateValue(obj[k], depth + 1, options)
    })
    if (keys.length > options.maxObjectKeys) {
      result['...[更多字段]'] = `共 ${keys.length} 个字段`
    }
    return result
  }

  return String(value)
}

export function safeSerialize(value: unknown, options: SafeSerializeOptions = {}): unknown {
  const opts: Required<SafeSerializeOptions> = {
    maxArrayItems: 20,
    maxObjectKeys: 30,
    maxStringLength: 500,
    maxDepth: 4,
    arrayMarker: true,
    ...options,
  }
  return truncateValue(value, 0, opts)
}

/**
 * 用于模板内联的大对象截断：保留对象结构，但限制数组长度和字符串长度，
 * 避免把海量数据直接塞进 python_code 导致前端主线程阻塞。
 */
export function truncateForInline(
  value: unknown,
  maxArrayItems = 100,
  maxStringLength = 10_000,
  maxDepth = 8
): unknown {
  return truncateValue(value, 0, {
    maxArrayItems,
    maxObjectKeys: Number.MAX_SAFE_INTEGER,
    maxStringLength,
    maxDepth,
    arrayMarker: false,
  })
}

export function safeStringify(value: unknown, maxLength = 2000, options?: SafeSerializeOptions): string {
  try {
    const truncated = safeSerialize(value, options)
    const text = typeof truncated === 'string' ? truncated : JSON.stringify(truncated)
    if (text.length <= maxLength) return text
    return text.slice(0, maxLength) + '\n...[截断]'
  } catch {
    try {
      const text = String(value)
      if (text.length <= maxLength) return text
      return text.slice(0, maxLength) + '\n...[截断]'
    } catch {
      return '[无法序列化]'
    }
  }
}

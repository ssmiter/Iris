import type { ToolCall } from '@/types/mescli'

/**
 * 将各家模型返回的 tool_calls 归一化为 OpenAI wire 形状（2026-07-31 三处副本合一：
 * localModelClient / openaiModelClient / localModelApi 原各自内联一份相同实现）。
 * - id 缺失时合成稳定随机 id
 * - arguments 允许 string 或 object，统一落为 JSON string
 */
export function normalizeToolCalls(raw: unknown[]): ToolCall[] {
  return raw.map((tc: any) => ({
    id: tc.id || `tc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'function' as const,
    function: {
      name: tc.function?.name || '',
      arguments:
        typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments || {}),
    },
  }))
}

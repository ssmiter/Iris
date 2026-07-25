import type { PipelineDefinition } from '@/agent/pipelineRunner'
import { buildCompactSummaryPrompt, type CompactSummaryInput } from './prompt'

/**
 * 长对话压缩 pipeline（compact_summary）
 *
 * 输入：被压缩的消息段；输出：<summary> 标签内的 9 段结构化中文摘要（string）。
 * <analysis> 草稿块由 tagged 输出解析天然剥离（只提取 <summary> 内容）。
 *
 * maxTokens 说明：9 段摘要偏长，runner 默认 1024 远远不够；取 6000（4000-8000 区间中值）。
 * 注意：部分 provider 的 maxTokens 上限更低，runner 暂不做 per-provider clamp
 * （见打磨任务5 讨论点 5），超限时会走 max_retries/修复重试链路，最坏情况静默失败。
 */
export const compactSummaryPipeline: PipelineDefinition<CompactSummaryInput, string> = {
  name: 'compact_summary',
  buildPrompt: buildCompactSummaryPrompt,
  output: { kind: 'tagged', tag: 'summary' },
  maxTokens: 6000,
  temperature: 0.3,
  maxRetries: 2,
  timeoutMs: 120_000,
}

export { buildCompactSummaryPrompt, buildCompactContinuationContent } from './prompt'
export type { CompactSummaryInput } from './prompt'

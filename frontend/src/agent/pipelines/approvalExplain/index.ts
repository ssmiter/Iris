import type { PipelineDefinition, PipelineTransportOptions } from '@/agent/pipelineRunner'
import { runPipeline, createPipelineTransport } from '@/agent/pipelineRunner'
import { buildApprovalExplainPrompt, type ApprovalExplainInput } from './prompt'

/**
 * SQL 写操作影响解释 pipeline
 *
 * 输入：SQL 文本 + systemCode + 最近上下文
 * 输出：{ summary: string }
 */
export interface ApprovalExplainPipelineOutput {
  summary: string
}

export const approvalExplainPipeline: PipelineDefinition<
  ApprovalExplainInput,
  ApprovalExplainPipelineOutput
> = {
  name: 'approval_explain',
  buildPrompt: buildApprovalExplainPrompt,
  output: {
    kind: 'json',
    parse: (value) => {
      if (
        value &&
        typeof value === 'object' &&
        'summary' in value &&
        typeof (value as Record<string, unknown>).summary === 'string'
      ) {
        let summary = ((value as Record<string, unknown>).summary as string).trim()
        // 超长不判失败，截断即可——解释文案是增强而非主链路
        // （2026-08-14 与会话标题同一修法：硬长度上限是 parse_failed 杀手）
        if (summary.length > 0) {
          if (summary.length > 120) summary = summary.slice(0, 120)
          return { summary }
        }
      }
      return null
    },
  },
  // 4000（2026-08-14 与会话标题同一拍板）：推理系模型的思考也吃 maxTokens，
  // 小额度会被耗光导致正文为空、parse_failed。
  maxTokens: 4000,
  temperature: 0.2,
  maxRetries: 2,
  timeoutMs: 30_000,
}

export interface ApprovalExplainTransportOptions extends PipelineTransportOptions {}

/**
 * 生成 SQL 写操作影响解释。
 *
 * 失败返回 undefined，调用方应回落到规则级提示。
 */
export async function generateSqlExplainSummary(
  input: ApprovalExplainInput,
  transportOpts: ApprovalExplainTransportOptions,
  signal?: AbortSignal
): Promise<string | undefined> {
  // 2026-09-04：用户要求关掉（停用不删，几乎不用）。恢复 = 删掉下一行 return，
  // 并取消下方被注释掉的原始实现（pipeline 定义与 prompt.ts 均原样保留）。
  return undefined

  /* eslint-disable -- 停用保留段（取消注释即恢复）
  const transport = createPipelineTransport(transportOpts)

  try {
    const result = await runPipeline(approvalExplainPipeline, input, transport, { signal })
    if (result.ok && result.value) {
      return result.value.summary
    }
  } catch {
    // 静默失败
  }
  return undefined
  */
}

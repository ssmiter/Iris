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
        const summary = ((value as Record<string, unknown>).summary as string).trim()
        if (summary.length > 0 && summary.length <= 120) {
          return { summary }
        }
      }
      return null
    },
  },
  maxTokens: 256,
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
}

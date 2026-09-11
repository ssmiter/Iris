import type { Tool, ToolExecutionContext } from '@/agent/types'
import { killSubAgent } from '@/agent/subAgentManager'

/**
 * cancel_subagent：终止正在后台运行的子 Agent（claude-code TaskStop 对应物）。
 *
 * 2026-08-01 异步化配套：agent 工具默认后台运行后，"你可以终止子 agent 么"
 * 必须有模型可达的答案。kill = abort controller；终态通知由运行体自行补发
 * （带已获得的部分成果——取消不丢已得结果，claude-code killed 通知同款）。
 * 只作用于本进程后台注册表（subAgentManager.active），不影响其他任何状态。
 */

export const CANCEL_SUBAGENT_TOOL_NAME = 'cancel_subagent'

interface CancelSubagentInput {
  runId: string
}

interface CancelSubagentOutput {
  content: string
  runId: string
  killed: boolean
}

export function createCancelSubagentTool(): Tool<CancelSubagentInput, CancelSubagentOutput> {
  return {
    name: CANCEL_SUBAGENT_TOOL_NAME,
    description:
      '终止一个正在后台运行的子 Agent（agent 工具派遣的 runId）。' +
      '用户要求停止/取消某个后台调研时使用；终止后你会收到一条带部分成果的取消通知。' +
      '仅对仍在运行或排队中的 runId 有效；已完成或不存在时返回未生效。' +
      '不要随意使用——仅在用户明确要求终止，或该子 Agent 的任务已失去意义时调用。',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: {
          type: 'string',
          description: '要终止的后台子 Agent 的 runId（agent 工具派遣回执或完成通知中携带）。',
        },
      },
    },
    riskLevel: 'read_only',
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 2000,

    execute: async (input: CancelSubagentInput, _ctx: ToolExecutionContext): Promise<CancelSubagentOutput> => {
      const result = killSubAgent(input.runId)
      if (result === 'killed') {
        return {
          content: `已终止后台子 Agent（runId: ${input.runId}）。它已获得的部分成果将随后经通知送达。`,
          runId: input.runId,
          killed: true,
        }
      }
      return {
        content: `未终止：runId ${input.runId} 没有正在运行或排队中的后台子 Agent（可能已完成、已被终止或从未存在）。`,
        runId: input.runId,
        killed: false,
      }
    },
  }
}

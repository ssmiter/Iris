import type { Tool, ToolExecutionContext } from '@/agent/types'
import { sendToSubAgent } from '@/agent/subAgentManager'

/**
 * message_subagent：向运行中的后台子 Agent 补充消息（claude-code SendMessage 对应物）。
 *
 * 2026-08-01 异步化配套：主 Agent（或用户经主 Agent 转述）可以在子 Agent
 * 运行过程中补充见解、关键点，或请它提前收尾——主子 Agent 的雏形。
 * 消息进子 Agent 的 supplement 队列，在步骤间隙注入其上下文；
 * 未启动（信号量排队中）的暂存，启动后一次性注入。
 * 恢复已结束子 Agent 的续聊 = defer P2（原料在 trace.json）。
 */

export const MESSAGE_SUBAGENT_TOOL_NAME = 'message_subagent'

interface MessageSubagentInput {
  runId: string
  text: string
}

interface MessageSubagentOutput {
  content: string
  runId: string
  delivered: boolean
}

export function createMessageSubagentTool(): Tool<MessageSubagentInput, MessageSubagentOutput> {
  return {
    name: MESSAGE_SUBAGENT_TOOL_NAME,
    description:
      '向一个仍在运行或排队中的后台子 Agent（agent 工具派遣的 runId）补充一条消息。' +
      '用途：补充刚想到的见解或关键点、纠正方向、缩小范围，或请它提前收尾汇报。' +
      '消息会在子 Agent 的步骤间隙进入其上下文，内容要具体明确。' +
      '已完成或不存在的 runId 无法送达（会如实返回）。要求彻底停止请用 cancel_subagent。',
    inputSchema: {
      type: 'object',
      required: ['runId', 'text'],
      properties: {
        runId: {
          type: 'string',
          description: '目标后台子 Agent 的 runId（agent 工具派遣回执或通知中携带）。',
        },
        text: {
          type: 'string',
          description: '要补充给子 Agent 的内容：见解、关键点、方向修正或提前收尾的请求。',
        },
      },
    },
    riskLevel: 'read_only',
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 2000,

    execute: async (input: MessageSubagentInput, _ctx: ToolExecutionContext): Promise<MessageSubagentOutput> => {
      const result = sendToSubAgent(input.runId, input.text)
      if (result === 'not-running') {
        return {
          content: `未送达：runId ${input.runId} 没有正在运行或排队中的后台子 Agent（可能已完成、已被终止或从未存在）。`,
          runId: input.runId,
          delivered: false,
        }
      }
      return {
        content:
          result === 'delivered'
            ? `已送达后台子 Agent（runId: ${input.runId}），将在它的下一步骤间隙进入其上下文。`
            : `已排队：后台子 Agent（runId: ${input.runId}）还在等待启动槽位，补充将在它启动后一次性送达。`,
        runId: input.runId,
        delivered: true,
      }
    },
  }
}

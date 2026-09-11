import type { Tool, ToolExecutionContext } from '@/agent/types'
import { stopCommandTask } from '@/agent/backgroundShellManager'

/**
 * stop_command_task：终止一个后台运行的命令任务（claude-code KillShell/TaskStop 对应物，
 * 2026-09-01 二阶段切片2）。
 *
 * run_command run_in_background 回执落地后，"停掉那个后台构建"必须有模型可达的答案。
 * 终止=后端杀整棵进程树；终态通知（killed=true+尾部输出）由 watcher 收到退出事件后补发——
 * 取消不丢已得输出，输出文件始终可读。
 */

export const STOP_COMMAND_TASK_TOOL_NAME = 'stop_command_task'

interface StopCommandTaskInput {
  task_id: string
}

interface StopCommandTaskOutput {
  content: string
  task_id: string
  stopped: boolean
}

export function createStopCommandTaskTool(): Tool<StopCommandTaskInput, StopCommandTaskOutput> {
  return {
    name: STOP_COMMAND_TASK_TOOL_NAME,
    description:
      '终止一个正在后台运行的命令任务（run_command run_in_background 回执或通知中携带的 task_id）。' +
      '用户要求停止某个后台命令，或后台命令在空转/等待交互输入时使用；终止后你会收到一条带尾部输出的终止通知。' +
      '仅对仍在运行的 task_id 有效；已完成或不存在时返回未生效。' +
      '不要随意使用——仅在用户明确要求终止，或该命令已失去意义时调用。',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: {
          type: 'string',
          description: '要终止的后台命令任务 id（run_command 后台回执或后台命令通知中携带）。',
        },
      },
    },
    riskLevel: 'read_only',
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 2000,

    execute: async (input: StopCommandTaskInput, _ctx: ToolExecutionContext): Promise<StopCommandTaskOutput> => {
      const result = await stopCommandTask(input.task_id)
      if (result === 'stopped') {
        return {
          content: `已终止后台命令任务（task_id: ${input.task_id}）。终止通知（含尾部输出）将随后送达。`,
          task_id: input.task_id,
          stopped: true,
        }
      }
      return {
        content: `未终止：task_id ${input.task_id} 没有正在运行的后台命令任务（可能已完成、已被终止、或后端重启后任务已消失——输出文件仍可用 read_file 读取确认结果）。`,
        task_id: input.task_id,
        stopped: false,
      }
    },
  }
}

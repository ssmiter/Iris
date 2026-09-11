import { workspaceApi } from '@/api/client'
import { ApiError } from '@/api/client'
import { injectSystemEvent } from '@/stores/chatStore'

/**
 * backgroundShellManager —— 后台命令任务的前端 watcher（2026-09-01 二阶段切片2，
 * 对照 claude-code bash 后台任务的完成通知机制）。
 *
 * 定位：run_command run_in_background 回执落地后，这里接管生命周期观察——
 * 长等待 wait 端点（非轮询：有事件即返回，无事件服务端挂起 120s 回 heartbeat），
 * 事件翻译成系统通知注入对话（injectSystemEvent，与子 Agent 完成通知同通道）：
 * - exited → 完成/失败/被终止通知（退出码+输出文件路径+尾部输出）；
 * - stalled → 45s 无输出提醒（末行输出原文给模型，"是否在等交互输入"由模型判断——
 *   后端只报事实，不做 PROMPT_PATTERNS 匹配）；
 * - 404 → 任务丢失通知（后端重启不恢复后台任务，claude-code 本地后台任务同款；
 *   输出文件仍在盘上可读，如实告知）。
 *
 * 进程边界：watcher 是前端内存注册表，页面刷新后任务仍跑在后端（输出文件持续写入），
 * 但通知链断——模型从对话里的回执可重新读输出文件确认结果（回执文本含路径即为此设计）。
 */

export interface CommandTaskWatchInput {
  taskId: string
  /** 命令原文（通知里截断展示） */
  command: string
  /** 输出文件物理路径（通知/终止提示里引用，read_file 可读） */
  outputPath: string
  /** 归属会话（通知路由；子 Agent/任务会话里派遣的后台命令通知落该会话） */
  conversationId?: number
}

interface WatchEntry {
  taskId: string
  command: string
  outputPath: string
  conversationId?: number
  controller: AbortController
}

const watchers = new Map<string, WatchEntry>()

function shortCommand(command: string): string {
  return command.length > 200 ? `${command.slice(0, 200)}…` : command
}

/** 注册并启动 watcher（幂等：同一 taskId 重复注册直接忽略） */
export function watchCommandTask(input: CommandTaskWatchInput): void {
  if (watchers.has(input.taskId)) return
  const entry: WatchEntry = { ...input, controller: new AbortController() }
  watchers.set(input.taskId, entry)
  void waitLoop(entry)
}

async function waitLoop(entry: WatchEntry): Promise<void> {
  const { taskId } = entry
  while (!entry.controller.signal.aborted) {
    let ev
    try {
      ev = await workspaceApi.waitShellTask(taskId, entry.controller.signal)
    } catch (err) {
      if (entry.controller.signal.aborted) return
      if (err instanceof ApiError && err.status === 404) {
        injectSystemEvent(
          entry.conversationId,
          `[后台命令通知] 任务丢失：后端已重启或任务被清理（后台任务不跨重启恢复）。\n` +
            `task_id: ${taskId}\n命令: ${shortCommand(entry.command)}\n` +
            `输出文件仍可读：${entry.outputPath}（read_file 读取确认任务跑到了哪一步）。`
        )
        watchers.delete(taskId)
        return
      }
      // 网络闪断/后端短暂不可达：等 3s 重连（不是轮询——事件通道重建）
      await new Promise((r) => setTimeout(r, 3000))
      continue
    }

    if (ev.type === 'heartbeat') continue

    if (ev.type === 'stalled') {
      injectSystemEvent(
        entry.conversationId,
        `[后台命令提醒] 命令 45 秒无输出（仍在运行）。\n` +
          `task_id: ${taskId}\n命令: ${shortCommand(entry.command)}\n` +
          `最后一行输出: ${ev.last_line || '（无）'}\n` +
          `若它在等待交互输入（密码/确认提示），后台运行不会得到回答——考虑用 stop_command_task 终止后改非交互参数重跑；` +
          `若只是长编译/长测试的正常沉默，忽略本提醒即可。输出文件：${entry.outputPath}`
      )
      continue
    }

    // exited：终态通知（完成/失败/被终止/超限被杀统一形状）
    const ok = ev.exit_code === 0 && !ev.killed
    const statusText = ev.killed
      ? '已被终止'
      : ok
        ? `执行完成（退出码 ${ev.exit_code}）`
        : `执行失败（退出码 ${ev.exit_code ?? '未知'}）`
    const lines = [
      `[后台命令通知] 命令${statusText}。`,
      `task_id: ${taskId}`,
      `命令: ${shortCommand(entry.command)}`,
      `输出文件: ${entry.outputPath}（完整输出用 read_file 读它）`,
    ]
    if (ev.tail?.trim()) {
      lines.push('', '尾部输出:', ev.tail.trim())
    }
    injectSystemEvent(entry.conversationId, lines.join('\n'))
    watchers.delete(taskId)
    return
  }
}

/** 终止后台命令任务（stop_command_task 工具的执行体）。终态通知由退出事件到达后补发。 */
export async function stopCommandTask(taskId: string): Promise<'stopped' | 'not-running'> {
  const entry = watchers.get(taskId)
  try {
    const result = await workspaceApi.stopShellTask(taskId)
    if (!result.stopped) {
      watchers.delete(taskId)
      entry?.controller.abort()
      return 'not-running'
    }
    // 保持 watcher 存活：等后端退出事件（killed=true）到达后统一发终态通知并清理
    return 'stopped'
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      watchers.delete(taskId)
      entry?.controller.abort()
    }
    return 'not-running'
  }
}

/** 某 taskId 是否有活动 watcher（UI 状态/调试） */
export function hasActiveCommandTask(taskId: string): boolean {
  return watchers.has(taskId)
}

/** 活动任务枚举（autoCompact 压缩后重注入用，buildSubAgentStatusMessages 同款存活纪律） */
export function listActiveCommandTasks(): CommandTaskWatchInput[] {
  return [...watchers.values()].map((w) => ({
    taskId: w.taskId,
    command: w.command,
    outputPath: w.outputPath,
    conversationId: w.conversationId,
  }))
}

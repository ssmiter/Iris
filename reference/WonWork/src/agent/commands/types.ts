/**
 * 斜杠命令体系：类型定义
 *
 * 对标 claude-code src/types/command.ts 的三分法（prompt/local/local-jsx），
 * WonWork 简化为两类：
 * - local：前端本地执行，不触发模型请求（导出/记忆/压缩/切换模型等）
 * - prompt：产生一条发给模型的消息（Skill 激活、/web 自然语言任务等）
 *
 * 见 learn/04/workshop/对话框v9实现计划-2026-07-22.md §1
 */

import type { ProviderConfig } from '@/types/mescli'

/** 命令执行上下文：由 chatStore 在 dispatch 时构造，避免 commands → chatStore 循环依赖 */
export interface CommandContext {
  /** 追加一条 assistant 消息（命令回执） */
  appendAssistantMessage: (content: string) => Promise<void>
  /** 切换模型（/model） */
  setActiveProvider: (provider: ProviderConfig) => void
  /** 可用 provider 列表（/model 匹配用） */
  providers: ProviderConfig[]
  /** 新建对话（/clear） */
  createConversation: () => Promise<number | null>
  /** 清空排队与待注入（/clear） */
  clearQueueAndSupplements: () => void
  /** 主动压缩上下文（/compact） */
  compactConversation: (userInstructions?: string) => Promise<void>
  /** WebBridge 命令（/web save|run|list|policy|<自然语言>），逻辑在 chatStore 内（依赖其工作流状态） */
  runWebCommand: (body: string) => Promise<void>
  /** 当前是否正在流式输出 */
  isStreaming: boolean
}

export interface SlashCommand {
  /** 命令名（不含斜杠），如 'compact' */
  name: string
  aliases?: string[]
  /** 菜单中显示的一行描述 */
  description: string
  /** 参数提示，如 '<内容>'、'[任务]'；无参命令为 undefined */
  argumentHint?: string
  /** 菜单分组 */
  group: 'builtin' | 'skill'
  /** local=前端执行；prompt=发消息给模型 */
  type: 'local' | 'prompt'
  /** 流式运行中是否可用（默认 true；/compact 等设为 false） */
  availableWhileStreaming?: boolean
  /** 动态启用条件；返回 false 时菜单隐藏且 dispatch 拒绝 */
  isEnabled?: () => boolean
  run: (args: string, ctx: CommandContext) => void | Promise<void>
}

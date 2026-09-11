/**
 * 斜杠命令统一分发器
 *
 * 对标 claude-code processSlashCommand：一个入口完成解析 → 匹配 → 执行。
 *
 * 见 learn/04/workshop/对话框v9实现计划-2026-07-22.md §1
 */
import { toast } from 'sonner'
import i18n from '@/i18n'
import { getAllCommands, bumpCommandFreq } from './registry'
import type { CommandContext } from './types'

export type DispatchResult = 'handled' | 'keep-input' | false

/**
 * 尝试把输入作为斜杠命令分发。
 * @returns 'handled' = 已处理；'keep-input' = 是命令但需保留输入框内容（如缺参数）；false = 不是斜杠命令
 */
export async function dispatchSlashCommand(text: string, ctx: CommandContext): Promise<DispatchResult> {
  const m = text.match(/^\/([\w\-一-龥]+)(?:\s+([\s\S]+))?$/)
  if (!m) {
    // 裸 "/" 或不合命令格式：拦截并引导，不发给模型
    if (text.trim() === '/') {
      toast.info(i18n.t('chat.toast.slashHint'))
      return 'handled'
    }
    return false
  }

  const name = m[1]
  const args = (m[2] || '').trim()
  const cmd = getAllCommands().find(
    (c) => c.name === name || c.name.toLowerCase() === name.toLowerCase() || c.aliases?.includes(name)
  )

  // 未识别命令：提示而非发给模型（claude-code 哲学：不打"未知命令"的脸，给引导）
  if (!cmd) {
    toast.error(i18n.t('chat.toast.commandNotFound', { name }))
    return 'handled'
  }

  if (ctx.isStreaming && cmd.availableWhileStreaming === false) {
    toast.info(i18n.t('chat.toast.commandWhileStreaming', { name: cmd.name }))
    return 'handled'
  }

  // 需要参数但未提供：保留输入等用户补全
  if (cmd.argumentHint && !args) {
    toast.info(i18n.t('chat.toast.commandNeedsArg', { name: cmd.name, hint: cmd.argumentHint }))
    return 'keep-input'
  }

  bumpCommandFreq(cmd.name)
  try {
    await cmd.run(args, ctx)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    toast.error(i18n.t('chat.toast.commandExecFailed', { name: cmd.name, msg }))
  }
  return 'handled'
}

/**
 * 斜杠命令注册表 + 排序
 *
 * 排序哲学对齐 claude-code commandSuggestions：
 * 精确名 > 别名精确 > 前缀 > 子序列模糊，叠加使用频率加分（localStorage 持久化）。
 *
 * 见 learn/04/workshop/对话框v9实现计划-2026-07-22.md §1
 */
import type { SlashCommand } from './types'
import { useSkillStore } from '@/stores/skillStore'

const FREQ_KEY = 'ww-cmd-freq'

function loadFreq(): Map<string, number> {
  try {
    return new Map(JSON.parse(localStorage.getItem(FREQ_KEY) || '[]'))
  } catch {
    return new Map()
  }
}

/** 命令命中后调用：累加使用频率并持久化 */
export function bumpCommandFreq(name: string): void {
  const freq = loadFreq()
  freq.set(name, (freq.get(name) || 0) + 1)
  try {
    localStorage.setItem(FREQ_KEY, JSON.stringify([...freq]))
  } catch {
    // 隐私模式等写不进去时静默
  }
}

/** 内置命令表（Skill 命令动态生成，见 getAllCommands） */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: 'compact',
    description: '压缩上下文，保留要点继续对话',
    argumentHint: '[摘要指令]',
    group: 'builtin',
    type: 'local',
    // v9.2：运行中可用——排队到本轮结束后自动执行（claude-code 排队语义）
    availableWhileStreaming: true,
    run: async (args, ctx) => {
      await ctx.compactConversation(args || undefined)
    },
  },
  {
    name: 'export',
    description: '导出当前会话为 Markdown',
    group: 'builtin',
    type: 'local',
    run: async () => {
      const { exportConversation } = await import('@/utils/exportConversation')
      const { useConversationStore } = await import('@/stores/conversationStore')
      const { useChatStore } = await import('@/stores/chatStore')
      const convId = useConversationStore.getState().currentConversationId
      const currentConv = useConversationStore.getState().conversations.find((c) => c.id === convId)
      exportConversation(useChatStore.getState().messages, currentConv?.title)
    },
  },
  {
    name: 'remember',
    description: '把事实写入长期记忆',
    argumentHint: '<内容>',
    group: 'builtin',
    type: 'local',
    run: async (args, ctx) => {
      const { useMemoryStore } = await import('@/stores/memoryStore')
      const { useConversationStore } = await import('@/stores/conversationStore')
      const conversationId = useConversationStore.getState().currentConversationId
      await useMemoryStore.getState().remember({
        content: args,
        type: 'note',
        layer: 'semantic',
        priority: 'high',
        conversation_id: conversationId || undefined,
      })
      await ctx.appendAssistantMessage(`✅ 已记住: ${args}`)
    },
  },
  {
    name: 'web',
    description: '本轮使用浏览器自动化（save/run/list/policy/任务）',
    argumentHint: '[任务]',
    group: 'builtin',
    type: 'local',
    run: async (args, ctx) => {
      await ctx.runWebCommand(args)
    },
  },
  {
    name: 'model',
    description: '切换模型',
    argumentHint: '<名称>',
    group: 'builtin',
    type: 'local',
    run: async (args, ctx) => {
      const q = args.trim().toLowerCase()
      if (!q) {
        const list = ctx.providers.map((p) => `• ${p.provider} / ${p.model}`).join('\n')
        await ctx.appendAssistantMessage(
          `可用模型：\n${list || '（无）'}\n\n使用 "/model <名称>" 切换`
        )
        return
      }
      const hit =
        ctx.providers.find((p) => p.provider.toLowerCase() === q) ||
        ctx.providers.find((p) => p.model.toLowerCase() === q) ||
        ctx.providers.find((p) => `${p.provider}/${p.model}`.toLowerCase().includes(q)) ||
        ctx.providers.find((p) => p.provider.toLowerCase().includes(q) || p.model.toLowerCase().includes(q))
      if (!hit) {
        await ctx.appendAssistantMessage(`未找到匹配「${args}」的模型。输入 "/model" 查看可用列表。`)
        return
      }
      ctx.setActiveProvider(hit)
      localStorage.setItem('wonclaw_active_provider', JSON.stringify(hit))
      await ctx.appendAssistantMessage(`✅ 已切换模型：${hit.provider} / ${hit.model}`)
    },
  },
  {
    name: 'clear',
    description: '新开对话，并清空排队与待注入',
    group: 'builtin',
    type: 'local',
    run: async (_args, ctx) => {
      ctx.clearQueueAndSupplements()
      await ctx.createConversation()
    },
  },
  {
    name: 'help',
    description: '查看全部可用命令',
    group: 'builtin',
    type: 'local',
    run: async (_args, ctx) => {
      const lines = getAllCommands().map(
        (c) => `• **/${c.name}**${c.argumentHint ? ` ${c.argumentHint}` : ''} — ${c.description}`
      )
      await ctx.appendAssistantMessage(`可用命令：\n${lines.join('\n')}\n\n输入 "/" 唤起命令菜单，边输入边过滤。`)
    },
  },
]

/** 把启用的 Skill 包装为 prompt 型命令（菜单与内置命令同等待遇） */
function skillCommands(): SlashCommand[] {
  const { skills, activeSkillIds, loadSkill } = useSkillStore.getState()
  return skills
    .filter((s) => s.enabled && !activeSkillIds.includes(s.id))
    .map((s) => ({
      name: s.name,
      description: s.description || '加载此 Skill',
      group: 'skill' as const,
      type: 'prompt' as const,
      run: () => {
        loadSkill(s.id)
      },
    }))
}

/** 全部可用命令（内置 + Skill，过滤 isEnabled） */
export function getAllCommands(): SlashCommand[] {
  return [...BUILTIN_COMMANDS, ...skillCommands()].filter((c) => !c.isEnabled || c.isEnabled())
}

/** 子序列模糊匹配（claude-code fuzzy 同款）：q 的字符按序出现在 name 中 */
function fuzzyMatch(q: string, name: string): boolean {
  if (!q) return false
  let i = 0
  for (const ch of name) if (ch === q[i]) i++
  return i >= q.length
}

/**
 * 命令排序：精确 100 / 别名精确 95 / 前缀 80-0.1·len / 模糊 40，加频率加分。
 * 返回按得分降序的命令数组。
 */
export function rankCommands(query: string, commands: SlashCommand[] = getAllCommands()): SlashCommand[] {
  const q = query.toLowerCase()
  const freq = loadFreq()
  const scored: Array<{ c: SlashCommand; s: number }> = []
  for (const c of commands) {
    let s = -1
    if (c.name.toLowerCase() === q) s = 100
    else if (c.aliases?.some((a) => a.toLowerCase() === q)) s = 95
    else if (c.name.toLowerCase().startsWith(q)) s = 80 - q.length * 0.1
    else if (fuzzyMatch(q, c.name.toLowerCase())) s = 40
    if (s >= 0) scored.push({ c, s: s + Math.min(20, (freq.get(c.name) || 0) * 2) })
  }
  scored.sort((a, b) => s - s)
  return scored.map((x) => x.c)
}

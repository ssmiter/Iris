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
import { useProviderProfileStore } from '@/stores/providerProfileStore'
import { isProfileProviderId, profileIdFromProviderId } from '@/types/providerProfile'
import { toast } from 'sonner'
import i18n from '@/i18n'

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
    description: i18n.t('chat.commands.compact.description'),
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
    description: i18n.t('chat.commands.export.description'),
    argumentHint: '[json]',
    group: 'builtin',
    type: 'local',
    run: async (args) => {
      const { exportConversation, exportConversationJson } = await import(
        '@/utils/exportConversation'
      )
      const { useConversationStore } = await import('@/stores/conversationStore')
      const { useChatStore } = await import('@/stores/chatStore')
      const convId = useConversationStore.getState().currentConversationId
      const currentConv = useConversationStore.getState().conversations.find((c) => c.id === convId)
      const messages = useChatStore.getState().messages
      if (args.trim().toLowerCase() === 'json') {
        exportConversationJson(messages, currentConv?.title, convId)
      } else {
        exportConversation(messages, currentConv?.title)
      }
    },
  },
  {
    name: 'remember',
    description: i18n.t('chat.commands.remember.description'),
    argumentHint: '<内容>',
    group: 'builtin',
    type: 'local',
    run: async (args, ctx) => {
      // 记忆文件化（2026-09-03）：/remember = 快速记一笔，落成 ~/.wonwork/memory/ 下的
      // 无类型速记文件 + 索引行；要 LLM 誊写归类请用划词"收入记忆"。
      const { useFileMemoryStore } = await import('@/stores/fileMemoryStore')
      const ok = await useFileMemoryStore.getState().addQuickNote(args)
      await ctx.appendAssistantMessage(ok ? `✅ 已记住: ${args}` : `❌ 记忆写入失败: ${args}`)
    },
  },
  {
    name: 'memory',
    description: i18n.t('chat.commands.memory.description'),
    group: 'builtin',
    type: 'local',
    run: async (_args, _ctx) => {
      const { useMemoryDockStore } = await import('@/stores/memoryDockStore')
      useMemoryDockStore.getState().open()
    },
  },
  {
    name: 'model',
    description: i18n.t('chat.commands.model.description'),
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
      // 供应商预设库：/model 直选 profile 时同步 activeId（与下拉点选同一事实，
      // 2026-09-07 审计补齐——此前只写激活项不写 activeId，设置页"在用"徽标会指错）
      const pid = isProfileProviderId(hit.provider) ? profileIdFromProviderId(hit.provider) : null
      if (pid) void useProviderProfileStore.getState().setActive(pid)
      await ctx.appendAssistantMessage(`✅ 已切换模型：${hit.provider} / ${hit.model}`)
    },
  },
  {
    name: 'clear',
    description: i18n.t('chat.commands.clear.description'),
    group: 'builtin',
    type: 'local',
    run: async (_args, ctx) => {
      ctx.clearQueueAndSupplements()
      await ctx.createConversation()
    },
  },
  {
    name: 'web',
    description: i18n.t('chat.commands.web.description'),
    argumentHint: '<任务 | save <名> | run <名> | list | policy <预设>>',
    group: 'builtin',
    type: 'local',
    run: async (args, ctx) => {
      await ctx.runWebCommand(args)
    },
  },
  {
    name: 'help',
    description: i18n.t('chat.commands.help.description'),
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

/** 把启用且用户可调用的 Skill 包装为 prompt 型命令（菜单与内置命令同等待遇）。
 *  命令名用 id 而非中文名（2026-08-09 审计修复）：中文名含空格/标点时 SLASH_RE 匹配不到，
 *  id 恒为 kebab-case 可键入；中文名移到描述前缀保持可读。 */
function skillCommands(): SlashCommand[] {
  const { skills, activeSkillIds, loadSkill, recordSkillUsage } = useSkillStore.getState()
  return skills
    .filter((s) => s.enabled && s.userInvocable && !activeSkillIds.includes(s.id))
    .map((s) => ({
      name: s.id,
      description: `${s.name}：${s.description || s.whenToUse || i18n.t('chat.commands.skill.loadThisSkill')}`,
      group: 'skill' as const,
      type: 'prompt' as const,
      run: () => {
        loadSkill(s.id)
        // 用量统计（2026-08-09 第二波）：斜杠加载记入——
        // 管理页"最近使用"排序与斜杠菜单 recency 的数据源
        recordSkillUsage(s.id)
        // 生效回音：/skill 加载后徽标变化不够显眼，补一条 toast 确认
        toast.success(i18n.t('chat.toast.skillLoaded', { name: s.name }))
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
  // 技能命令额外吃用量统计加分（2026-08-09 第二波）：被用过的技能
  // 该浮到菜单前面（recency 加分）
  const usageStats = useSkillStore.getState().usageStats
  const scored: Array<{ c: SlashCommand; s: number }> = []
  for (const c of commands) {
    let s = -1
    if (c.name.toLowerCase() === q) s = 100
    else if (c.aliases?.some((a) => a.toLowerCase() === q)) s = 95
    else if (c.name.toLowerCase().startsWith(q)) s = 80 - q.length * 0.1
    else if (c.aliases?.some((a) => a.toLowerCase().startsWith(q))) s = 76 - q.length * 0.1
    else if (fuzzyMatch(q, c.name.toLowerCase())) s = 40
    else if (c.aliases?.some((a) => fuzzyMatch(q, a.toLowerCase()))) s = 38
    if (s < 0) continue
    let bonus = Math.min(20, (freq.get(c.name) || 0) * 2)
    if (c.group === 'skill') {
      bonus = Math.max(bonus, Math.min(20, (usageStats[c.name]?.count || 0) * 2))
    }
    scored.push({ c, s: s + bonus })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.map((x) => x.c)
}

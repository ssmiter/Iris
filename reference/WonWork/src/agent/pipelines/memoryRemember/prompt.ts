import type { PipelinePrompt } from '@/agent/pipelineRunner'
import type { MemoryRememberInput } from './index'

/**
 * 记忆誊写 prompt（第二稿 2026-07-31：开放 SKIP 判断权；
 * 2026-09-03 重指文件存储：四类型对齐 claude-code memdir，MERGE 目标=文件路径）。
 *
 * 触发入口只剩用户划词"收入记忆"一条（memory_write 工具已随记忆文件化退役——
 * 模型要记东西直接用文件原语写 ~/.wonwork/memory/，不再过本管线）。
 * 本 prompt 的核心职责三件事——
 * 1) 带着上下文把原文改写成一条独立可读的记忆（补全指代、时间、项目归属）
 * 2) 归类（user/feedback/project/reference 四类型）
 * 3) 查重：与近义旧记忆合并（MERGE）而非重复 ADD
 */
const PREMISE = `你是记忆誊写员。用户从对话中亲手选中了一段文字，要求收入长期记忆。

默认相信：用户亲手选中，就是值得记的内容。你的主要任务是让这条记忆**在脱离原对话后依然准确、完整、可读**。但保留一分判断——用户也可能只是随手一圈试探记忆系统：若选中内容明显没有长期价值（随机字符、寒暄客套、一次性噪音、残缺的半句话），输出 SKIP 并附一句给用户看的简短理由（温和、不说教）。还有一类不需要记：能从代码、提交历史、仓库文档里直接看出来的东西（文件在哪、怎么构建、上次改了什么）——记了只是多一份会过期的副本。拿不准时：能推导出来的不记，推导不出来的倾向记住。`

const RULES = `
1. 改写：把内容提炼成一句独立成立的陈述。补全依赖上下文的指代（"这个方法"→具体名字、"下周"→绝对日期、"这里"→所在项目/系统）。只使用上下文中真实存在的信息，**禁止虚构**。
2. 忠实：改写不得改变原意，不得扩大事实范围。拿不准的指代保持原样，不硬解。
3. 归类（四选一）：
   - user：用户是谁——角色、口味、表达/格式要求（"报表用表格""结论先行"）
   - feedback：用户给过的纠正与拍板——以后该怎么做（写清为什么、怎么应用）
   - project：手头项目/业务的进行态事实——目标、约束、决定、来龙去脉
   - reference：外部资源的指针——文档在哪、系统入口、仪表盘地址
4. 查重：若"旧记忆"清单中已有表达同一事实的条目，输出 MERGE 并把新信息并入（以旧条目为基础更新措辞，target_id 填它的文件路径）；只有真正新鲜的内容才 ADD。
5. 精炼：最终 content 不超过 80 字，一句话说清。summary 是 20 字内的速览（会进索引行，要让未来的读者一眼知道这条是什么）。

输出严格 JSON：
{
  "action": "ADD" | "MERGE" | "SKIP",
  "reason": "仅 SKIP 时填：一句简短理由（20 字内）",
  "target_id": "仅 MERGE 时填旧记忆的文件路径",
  "content": "改写后的完整记忆",
  "type": "user|feedback|project|reference",
  "summary": "速览"
}`

export function buildMemoryRememberPrompt(input: MemoryRememberInput): PipelinePrompt {
  const context = input.contextMessages.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.text}`).join('\n')
  const existing =
    input.existingMemories.length > 0
      ? input.existingMemories.map((m) => `- id=${m.id} type=${m.type} ${m.content}`).join('\n')
      : '（空——没有旧记忆，只能 ADD）'

  return {
    system: PREMISE + RULES,
    messages: [
      {
        role: 'user',
        content: `用户选中的文字：
「${input.selectedText}」

这段内容所在的对话上下文（节选，供理解指代）：
${context}

旧记忆（查重依据）：
${existing}

请输出誊写决策 JSON：`,
      },
    ],
  }
}

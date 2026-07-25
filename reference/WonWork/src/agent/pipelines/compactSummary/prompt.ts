import type { Message } from '@/types/mescli'
import type { PipelinePrompt } from '@/agent/pipelineRunner'

/**
 * compact_summary pipeline 的 prompt（对标 claude-code services/compact/prompt.ts，中文化）
 *
 * 关键设计（全部保留）：
 * 1. 9 段摘要结构——尤其第 6 段"用户全部消息"保留原始意图、第 9 段要求 verbatim
 *    引用最近对话防任务漂移；
 * 2. <analysis> 草稿块先组织思路，回写前由 pipeline 输出解析剥离；
 * 3. no-tools 首尾夹击由 pipelineRunner 统一注入（noTools 默认 true）；
 * 4. 压缩后由 buildCompactContinuationContent 生成续接消息（"直接继续，不要寒暄"）。
 */

export interface CompactSummaryInput {
  /** 被压缩的消息段（循环内 currentMessages 的前半部分） */
  messages: Message[]
  /** 手动触发时用户的自定义指令（可选） */
  userInstructions?: string
}

const BASE_COMPACT_PROMPT_ZH = `你的任务是为到目前为止的对话创建一份详细摘要，重点关注用户的明确请求以及你之前采取的行动。
这份摘要必须充分捕捉技术细节、代码模式和架构决策，确保在不丢失上下文的情况下继续开发工作。

在给出最终摘要之前，请先把你的分析过程写在 <analysis> 标签内，用以组织思路并确保覆盖所有要点。分析过程中：

1. 按时间顺序逐段分析对话。对每一段充分识别：
   - 用户的明确请求与意图
   - 你应对这些请求的方法
   - 关键决策、技术概念与代码模式
   - 具体细节，例如：
     - 文件名
     - 关键代码片段
     - 函数签名
     - 文件改动
   - 遇到的错误以及修复方式
   - 特别注意用户的反馈，尤其是用户要求改变做法的地方
2. 复核技术准确性与完整性，逐一确认每个必需要素。

你的摘要必须包含以下小节：

1. 主要请求与意图：详细捕捉用户的全部明确请求与意图
2. 关键技术概念：列出讨论过的所有重要技术概念、技术与框架
3. 文件与代码段落：列举查看、修改或创建的具体文件与代码段落。特别关注最近的消息，在适用处包含关键代码片段，并说明该文件为何重要
4. 错误与修复：列出遇到的所有错误及修复方式。特别注意用户反馈，尤其是用户要求改变做法的地方
5. 问题解决：记录已解决的问题与仍在进行的排查工作
6. 用户全部消息：列出所有非工具结果的用户消息。这些对理解用户反馈与意图变化至关重要
7. 待办任务：列出被明确要求完成但尚未完成的任务
8. 当前工作：详细描述摘要请求前一刻正在进行的工作，特别关注最近的用户与助手消息，在适用处包含文件名与代码片段
9. 可选的下一步：列出与最近工作直接相关的下一步。重要：该步骤必须与用户最近的明确请求、以及你刚才正在做的任务直接一致。如果上一项任务已完成，只有在下一步明确符合用户请求时才列出；未经确认不要开始题外话或早已完成的旧任务。
   若有下一步，请直接引用最近对话中的原文，准确说明当时在做什么、停在哪里。必须逐字引用（verbatim），确保任务理解不漂移。

请按以下结构输出：

<example>
<analysis>
[你的分析过程，确保所有要点都被充分、准确地覆盖]
</analysis>

<summary>
1. 主要请求与意图：
   [详细描述]
2. 关键技术概念：
   - [概念 1] ...
3. 文件与代码段落：
   - [文件名 1]
      - [该文件为何重要]
      - [如有改动，改动摘要]
      - [关键代码片段] ...
4. 错误与修复：
    - [错误 1 的详细描述]：
      - [修复方式]
      - [如有，用户反馈] ...
5. 问题解决：
   [已解决问题与进行中排查的描述]
6. 用户全部消息：
    - [非工具结果的用户消息] ...
7. 待办任务：
   - [任务 1] ...
8. 当前工作：
   [当前工作的精确描述]
9. 可选的下一步：
   [可选的下一步]
</summary>
</example>

请基于到目前为止的对话给出摘要，严格遵循上述结构，确保精确与完整。

如果附带的上下文中包含额外的摘要指令，请一并遵循。`

export function buildCompactSummaryPrompt(input: CompactSummaryInput): PipelinePrompt {
  const trailing = input.userInstructions
    ? `请按照系统提示的结构，输出对以上对话的详细摘要。\n\n附加摘要指令：${input.userInstructions}`
    : '请按照系统提示的结构，输出对以上对话的详细摘要。'

  return {
    system: BASE_COMPACT_PROMPT_ZH,
    messages: [
      ...input.messages,
      { role: 'user', content: trailing },
    ],
  }
}

/**
 * 压缩回写：摘要消息内容（作为 user 消息插入被压缩段的位置）。
 * 对标 claude-code getCompactUserSummaryMessage + autoCompact 续接语。
 */
export function buildCompactContinuationContent(summary: string): string {
  return `本次对话因上下文长度限制进行了自动压缩。以下是此前对话的摘要，覆盖了压缩前的全部内容。

摘要：
${summary}

请直接从摘要中断处继续工作，不要向用户确认、不要复述摘要内容、不要以"我继续"之类的寒暄开头——就像中断从未发生一样，接着完成未完成的任务。`
}

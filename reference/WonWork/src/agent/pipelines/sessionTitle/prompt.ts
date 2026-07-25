import type { Message } from '@/types/mescli'
import type { PipelinePrompt } from '@/agent/pipelineRunner'

/**
 * session_title pipeline 的 prompt
 *
 * 输入：最近用户/助手消息（自动生成时为首条用户消息，手动刷新时取最近对话摘要）
 * 输出：JSON `{ "title": "..." }`，3-10 个汉字，不含标点与寒暄
 */

export interface SessionTitleInput {
  /** 用于生成标题的消息片段 */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  /** 附件文件名（可选，作为用户意图的辅助信号） */
  attachmentNames?: string[]
  /** 当前标题（可选，刷新时作为参考，不强制沿用） */
  previousTitle?: string
}

const BASE_SESSION_TITLE_PROMPT_ZH = `你是一名会话标题生成助手。请根据用户提供的最近对话内容，生成一个简短、贴切、无标点的中文标题。

要求：
1. 标题长度 3-10 个汉字。
2. 不含标点符号、连接词和寒暄用语。
3. 准确概括对话主题或用户核心意图。
4. 如果对话涉及具体技术/业务对象，标题中保留关键词（如 MES、SQL、Python、库存、报工）。
5. 语言：中文。
6. 必须基于实际对话内容生成，不要编造未出现的信息。

输出格式：
只输出 JSON，不要任何解释、道歉或额外文字：
{ "title": "<标题>" }

好例子：
- "库存查询"
- "Python 报错排查"
- "MES 登录配置"
- "原材料入库记录"
- "日报生成"

坏例子：
- "用户问了一个问题"
- "关于库存查询的问题"
- "帮我查一下..."
- "您好，请问有什么可以帮您"
- 任何超过 10 个汉字的标题`

export function buildSessionTitlePrompt(input: SessionTitleInput): PipelinePrompt {
  const contentPreview = input.messages
    .map((m) => {
      const prefix = m.role === 'user' ? '用户' : '助手'
      const text = m.content.slice(0, 1000)
      return `${prefix}：${text}`
    })
    .join('\n\n')

  const attachmentHint =
    input.attachmentNames && input.attachmentNames.length > 0
      ? `\n\n附件文件名：${input.attachmentNames.join('、')}`
      : ''

  const previousTitleHint = input.previousTitle
    ? `\n\n当前标题（仅供参考，可完全抛开）：${input.previousTitle}`
    : ''

  return {
    system: BASE_SESSION_TITLE_PROMPT_ZH,
    messages: [
      {
        role: 'user',
        content: `请为以下对话生成标题：\n\n${contentPreview}${attachmentHint}${previousTitleHint}`,
      },
    ],
  }
}

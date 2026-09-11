import type { Message } from '@/types/mescli'
import type { PipelinePrompt } from '@/agent/pipelineRunner'

/**
 * session_title pipeline 的 prompt
 *
 * 输入：对话中的用户消息组合（自动生成时为首条用户消息；手动刷新时为首条全量
 * + 最近若干条，见 chatStore.refreshConversationTitle）
 * 输出：JSON `{ "title": "..." }`，6-13 个汉字为宜，最长 15 字
 *
 * 2026-08-14 重写：判别标准从「短」换成「在会话列表里一眼认出、能与同类对话
 * 区分」（参照 claude-code 的 recognizable-in-a-list 标准）——区分度优先于
 * 简短，具体对象（系统名/表名/单号/报错关键词/动作）必须进标题。
 */

export interface SessionTitleInput {
  /** 用于生成标题的消息片段（当前调用方只送用户消息） */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  /** 附件文件名（可选，作为用户意图的辅助信号） */
  attachmentNames?: string[]
  /** 当前标题（可选，刷新时作为参考，不强制沿用） */
  previousTitle?: string
}

const BASE_SESSION_TITLE_PROMPT_ZH = `你是一名会话标题生成助手。根据给出的用户消息组合，为这场对话起一个标题：让用户日后在会话列表里一眼认出这是哪次对话，并能与主题相近的其他对话区分开。

要求：
1. 中文，6-13 个汉字为宜，最长不超过 15 字——区分度优先于简短，但不要为了多带信息而冗长。
2. 保留能定位这场对话的具体信息：系统或模块名、表名、报错码、要做的动作。「iris 排产交期异常排查」比「排产问题」好。
3. 但具体≠抄编号：长的产品号、单据号、UUID 这类机器标识不要写进标题——它们不可读也不可记，用户看到一串数字认不出是哪场对话。用类别代替（「某批次产品排产」「出库单异常」）。短的、有语义的标识（如 401、APS）可以保留。
4. 不含标点符号、语气词和寒暄；不要以「关于」「帮助」「请问」开头。
5. 只依据给出的消息内容，不编造未出现的信息。
6. 若消息组合里话题发生过切换，以用户最近关注的话题为准。

输出格式：
只输出 JSON，不要任何解释、道歉或额外文字：
{ "title": "<标题>" }

好例子：
- "iris 排产结果交期异常排查"
- "AIGateway 登录 401 修复"
- "硫化车间日报 SQL 优化"

坏例子：
- "库存查询"（太短，十场库存对话无法区分）
- "产品 10101000000052 排产"（照抄长编号，不可读；写成「某批次产品排产」即可）
- "关于排产问题的咨询"（「关于…的咨询」是占位废话）
- "用户问了一个问题"（没有信息量）
- 任何超过 15 字的标题`

export function buildSessionTitlePrompt(input: SessionTitleInput): PipelinePrompt {
  // 用户消息按时间顺序编号列出；首条是主题锚点给足篇幅，其余各取前 500 字
  const contentPreview = input.messages
    .map((m, i) => {
      const text = m.content.slice(0, i === 0 ? 1000 : 500)
      return `${i + 1}. ${text}`
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
        content: `这场对话中用户发送的消息（按时间顺序）：\n\n${contentPreview}${attachmentHint}${previousTitleHint}`,
      },
    ],
  }
}

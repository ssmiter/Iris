import type { PipelinePrompt } from '@/agent/pipelineRunner'

/**
 * approval_explain pipeline 的 prompt
 *
 * 输入：SQL 写操作文本 + 目标系统 + 最近对话上下文
 * 输出：JSON `{ "summary": "..." }`，一句话说明操作类型、目标表、大致影响
 */

export interface ApprovalExplainInput {
  /** 原始 SQL，已在前端截断到合理长度 */
  sql: string
  /** 目标系统/数据库标识 */
  systemCode?: string
  /** 最近 ≤500 字符的用户/助手消息摘要 */
  recentContext: string
}

const BASE_APPROVAL_EXPLAIN_PROMPT_ZH = `你是一名专门审核 SQL 写操作对目标表影响的专家。请根据用户提供的 SQL 语句和最近对话上下文，用一句话极其简短地解释这条 SQL 的影响，让用户明白写操作的大致意义和后果。

要求：
1. 只说明操作类型、目标表名、影响的数据行数或范围。
2. 不要道歉、不要解释思考过程、不要给出建议、不要写代码。
3. 语言：中文。
4. 总长度控制在 40 个汉字以内。

输出格式：
只输出 JSON，不要任何解释、道歉或额外文字：
{ "summary": "<一句话影响说明>" }

好例子：
- "将向 MES 数据库的 Inventory 表插入一条原材料入库记录，新增 1 行数据。"
- "将更新 MES_User 表的密码字段，影响符合 WHERE 条件的用户记录。"
- "将删除 ProductionOrder 表中状态为废弃的订单记录。"

坏例子：
- "这条 SQL 看起来会修改数据库。"
- "我无法确定影响范围。"
- 任何超过 40 字的解释。`

export function buildApprovalExplainPrompt(input: ApprovalExplainInput): PipelinePrompt {
  const sqlPreview = input.sql.slice(0, 2000).trim()
  const systemHint = input.systemCode ? `目标系统：${input.systemCode}\n` : ''

  return {
    system: BASE_APPROVAL_EXPLAIN_PROMPT_ZH,
    messages: [
      {
        role: 'user',
        content: `${systemHint}最近对话上下文：\n${input.recentContext || '（无）'}\n\n待解释的 SQL：\n\`\`\`sql\n${sqlPreview}\n\`\`\`\n\n请用一句话解释这条 SQL 的影响。`,
      },
    ],
  }
}

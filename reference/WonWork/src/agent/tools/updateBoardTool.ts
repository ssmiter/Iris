import type { Tool, ToolExecutionContext } from '@/agent/types'
import { useBoardStore, formatBoardSnapshot, type BoardModelPatch } from '@/stores/boardStore'

/**
 * update_board：维护本轮对话的进展黑板（目标 / 已确认事实 / 待办）。
 *
 * 2026-08-12 蓝图 v13 黑板板块 + claude-code TodoWrite 语义移植。
 * 定位：对话级「目标 / 已确认 / 待办」三段在模型侧的整段替换式写入口——
 * 提供的段全量覆盖、未提供的段不动（与 boardStore.applyModelUpdate 契约一致，
 * claude-code 同款，避免 diff 地狱）。用户在右侧面板实时看到；用户手改经
 * trailingMeta 附下一条用户消息告知模型，本工具只管模型侧的维护。
 *
 * 防回归要点：
 * ① 成本闸——description 是用户拍板的唯一更新节律（只在计划成形/步骤完成/
 *    事实确认等有意义边界更新，绝不每轮更新；nag 由 boardStore 8 轮一次兜底），
 *    不许改 description；
 * ② 只挂主 Agent Loop——registerBoardTools 只在 chatStore.sendMessage（主 loop
 *    注册序列）调用，子 Agent / DAG 不注册本工具（黑板是"本轮对话"的进展载体，
 *    子环境无会话级面板）；
 * ③ ctx.conversationId 缺失（DAG / 后台无会话上下文）时优雅落空，不抛错；
 * ④ 入参防御性校验——非字符串/非数组的段直接忽略并告知模型该段被拒，
 *    不让坏输入污染黑板。
 */

export const UPDATE_BOARD_TOOL_NAME = 'update_board'

interface UpdateBoardInput {
  /** 整段替换目标；不传则保持不变 */
  goal?: string
  /** 整段替换已确认事实（完整数组）；不传则保持不变 */
  facts?: string[]
  /** 整段替换待办（完整数组）；不传则保持不变 */
  todos?: Array<{
    content: string
    status: 'pending' | 'in_progress' | 'completed'
    activeForm?: string
  }>
}

export const updateBoardTool: Tool<UpdateBoardInput, { content: string }> = {
  name: UPDATE_BOARD_TOOL_NAME,
  description:
    '维护本轮对话的进展黑板（目标 / 已确认事实 / 待办），用户在右侧面板实时看到。' +
    '多步任务主动使用：计划成形时设 goal 并列出 todos；每完成一步把对应 todo 标 completed、下一项标 in_progress；' +
    '用户确认了关键事实就加进 facts。规则：①提供的段整段替换该段（goal 传完整字符串；facts 传完整字符串数组；' +
    'todos 传完整数组，各项 {content, status, activeForm?}，status 取 pending/in_progress/completed，' +
    '同一时刻至多一项 in_progress，activeForm 是进行中形态如"正在整理资料"）；②没提供的段保持不变，不要重复传；' +
    '③不要每轮更新——只在计划成形、步骤完成、事实确认这些有意义的边界调用；' +
    '④任务收尾时把剩余待办全部标 completed（或清空 todos）；⑤简单问答不要用这个工具。',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: '整段替换目标；不传则保持不变',
      },
      facts: {
        type: 'array',
        items: { type: 'string' },
        description: '整段替换已确认事实（完整数组）；不传则保持不变',
      },
      todos: {
        type: 'array',
        items: {
          type: 'object',
          required: ['content', 'status'],
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string' },
          },
        },
        description: '整段替换待办（完整数组）；不传则保持不变',
      },
    },
  },
  // standard：写状态但非破坏性；confirm 模式下仍会确认（合理——黑板也是用户可见的写）
  riskLevel: 'standard',
  isReadOnly: false,
  isConcurrencySafe: false,
  isDestructive: false,
  alwaysLoad: true,
  maxResultSizeChars: 2000,

  execute: async (input: UpdateBoardInput, ctx: ToolExecutionContext): Promise<{ content: string }> => {
    if (ctx.conversationId == null) {
      // DAG / 后台子环境无会话上下文：黑板不可用，优雅落空
      return { content: '当前环境没有会话上下文，黑板不可用。' }
    }

    // 防御性校验：只收合法段；非法段（非字符串/非数组/结构不对）忽略并告知模型
    const patch: BoardModelPatch = {}
    const rejected: string[] = []
    if (input.goal !== undefined) {
      if (typeof input.goal === 'string') patch.goal = input.goal
      else rejected.push('goal')
    }
    if (input.facts !== undefined) {
      if (Array.isArray(input.facts) && input.facts.every((f) => typeof f === 'string')) {
        patch.facts = input.facts
      } else {
        rejected.push('facts')
      }
    }
    if (input.todos !== undefined) {
      if (
        Array.isArray(input.todos) &&
        input.todos.every(
          (t) => t && typeof t === 'object' && typeof (t as { content?: unknown }).content === 'string'
        )
      ) {
        patch.todos = input.todos as BoardModelPatch['todos']
      } else {
        rejected.push('todos')
      }
    }

    const updated = useBoardStore.getState().applyModelUpdate(String(ctx.conversationId), patch)
    const rejectedNote =
      rejected.length > 0 ? `\n（段 ${rejected.join('、')} 因格式非法被拒收，未更新）` : ''
    return { content: `黑板已更新：\n${formatBoardSnapshot(updated)}${rejectedNote}` }
  },
}

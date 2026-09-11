import type { Tool, ToolExecutionContext } from '@/agent/types'
import { writeFile } from '@/services/fileSystem'
import { useSubAgentRunStore } from '@/stores/subAgentRunStore'
import { useStateKeeperStore } from '@/stores/stateKeeperStore'

/**
 * write_state：状态维护子 Agent（agent 工具 subagent_type=state）的专用写工具。
 *
 * 2026-08-03 用户定调（防回归）：不做结构硬编码——状态怎么组织、每部分怎么用
 * 自然语言写清楚、怎么压缩迭代，都是状态 agent 的认知职责，写在其身份 prompt 里，
 * 代码不管。代码只守两条结构线：
 * ①只写这一个路径（构造时绑定，input 无 path 字段）——状态 agent 是状态文件的
 *   结构性唯一写者，不是发通用 write_file 再靠 prompt 自觉；
 * ②体积预算——状态不能无限增长，超预算拒收逼它压缩（唯一保留的硬约束，
 *   因为"自觉保持简短"对长对话不可靠，且压缩标准在 prompt 里它知道怎么压）。
 */

/** 体积预算（字符）：prompt 引导全文保持一两千字，预算给足余量但封死无限增长 */
const STATE_SIZE_BUDGET = 8000

export const WRITE_STATE_TOOL_NAME = 'write_state'

interface WriteStateInput {
  /** 状态文件的完整新内容（全量覆盖写回，不是追加片段） */
  content: string
}

export function createWriteStateTool(opts: {
  /** 构造时绑定的唯一可写路径（结构性单一写者） */
  statePath: string
  /** 触碰面记录（冲突可见数据源，同其他写工具） */
  runId: string
}): Tool<WriteStateInput, { content: string }> {
  return {
    name: WRITE_STATE_TOOL_NAME,
    description:
      `把更新后的完整状态写回状态文件（${opts.statePath}）。` +
      '全量覆盖写：先 read_file 读出现状（不存在就直接新建）、消化本次同步后整体写回，不要写片段。' +
      '全文自然语言、保持精炼——写回本身就是一次再压缩：删掉已失效条目、旧决策合并成小结，' +
      `超过 ${STATE_SIZE_BUDGET} 字符会被拒收要求压缩。`,
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: {
          type: 'string',
          description: '状态文件的完整新内容（自然语言文本）。',
        },
      },
    },
    // 只写一个固定路径：standard 即可（confirm 模式下仍会确认，合理——状态文件也是写）
    riskLevel: 'standard',
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 2000,

    execute: async (input: WriteStateInput, _ctx: ToolExecutionContext) => {
      const content = input.content?.trim()
      if (!content) {
        return { content: '拒收：内容为空。状态文件必须包含对当前情况的具体描述。' }
      }
      if (content.length > STATE_SIZE_BUDGET) {
        return {
          content:
            `拒收：超出体积预算（${content.length}/${STATE_SIZE_BUDGET} 字符）。` +
            '状态文件要保持精炼——删掉已失效/被推翻的条目，旧决策合并成一段阶段小结，' +
            '同类事实合并；判断标准：主 Agent 以后做决策还用得上吗？用不上就丢。压缩后重新提交。',
        }
      }
      await writeFile(opts.statePath, content + '\n')
      useSubAgentRunStore.getState().addTouchedFile(opts.runId, opts.statePath)
      // 同步协作登记处内容缓存（compact 快照回注的数据源）；仅当该路径是当前活跃状态任务
      useStateKeeperStore.getState().updateContent(opts.statePath, content)
      return {
        content: `状态已写回 ${opts.statePath}（${content.length} 字符）。`,
      }
    },
  }
}

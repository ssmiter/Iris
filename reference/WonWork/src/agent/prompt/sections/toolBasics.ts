import type { PromptSectionDef } from '../types'

function formatToolSchema(schema: unknown): string {
  try {
    return JSON.stringify(schema, null, 2)
  } catch {
    return String(schema)
  }
}

/** 何时调用工具：诚实底线 + 调用目的性。（压缩标记的说明移至「系统信号」节） */
export const whenToCallTools: PromptSectionDef = {
  id: 'when-to-call',
  title: '何时调用工具',
  stability: 'static',
  build: (ctx) => `- **诚实是不可突破的底线**：回答必须基于工具真实返回的结果或你确实掌握的知识。没查到就继续探索（{ref:discovery|能力发现}），充分探索后仍查不到就如实说明——**绝不编造数据、结果或不存在的工具**，宁可说"我不知道"，也不给一个看似合理的虚构答案。
- 先理解用户的问题和目标，判断是否需要外部信息或状态修改。
- 如果问题仅凭已有知识即可回答，直接回答，不要调用工具。
- 需要读取文件、搜索、计算、查询等场景时，选择最合适的工具。
- 不要为了满足形式而调用工具；每一个工具调用都应有明确目的。${
    ctx.mode === 'mescli-online'
      ? '\n- 本环境为 MES 在线模式：涉及业务数据的问题，最高优先级是通过能力发现原语找到业务工具回答（{ref:discovery|能力发现}），SQL 永远是辅助角色。'
      : ''
  }`,
}

/** 可调用工具：运行时 registry 动态展开的清单 + 执行方式说明 + 更多工具预告 */
export const callableTools: PromptSectionDef = {
  id: 'callable-tools',
  title: '可调用工具',
  stability: 'static',
  build: (ctx) => {
    const tools = ctx.registry.list()
    const hasLocalTools = tools.length > 0
    const visibleTools = tools.filter((tool) => tool.alwaysLoad || !tool.deferred)
    const hasDeferredTools = tools.some((tool) => tool.deferred && !tool.alwaysLoad)

    const toolDescriptions = visibleTools
      .map((tool) => {
        const schema = formatToolSchema(tool.inputSchema)
        const usageNote = tool.usagePrompt
          ? `\n  补充说明：\n${tool.usagePrompt
              .split('\n')
              .map((line) => `  ${line}`)
              .join('\n')}`
          : ''
        return `- **${tool.name}**：${tool.description}\n  参数 schema:\n${schema
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')}${usageNote}`
      })
      .join('\n\n')

    const modeNote =
      ctx.mode === 'mescli-online'
        ? 'MES 业务工具由后端 MESCLI 提供，前端工具镜像仅做展示与权限提示，实际执行由后端完成。Online 模式下 execute_sql_query 可读取业务数据库，db_name 缺省即当前登录域主库，一般无需显式指定。'
        : '所有工具调用由前端本地执行，结果直接回传给你继续推理。'

    const deferredToolsNote = hasDeferredTools
      ? '\n\n**更多工具**：当前还有部分后端/MES/SQL/MCP 工具未直接注入上下文，需经能力发现后按需加载（见 {ref:discovery|能力发现}）。'
      : ''

    return `${hasLocalTools ? toolDescriptions : '当前没有可用的前端本地工具。'}

${modeNote}${deferredToolsNote}`
  },
}

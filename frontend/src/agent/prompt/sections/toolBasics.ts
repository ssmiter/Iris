import type { PromptSectionDef } from '../types'

/** 何时调用工具：诚实底线 + 调用目的性。（压缩标记的说明移至「系统信号」节） */
export const whenToCallTools: PromptSectionDef = {
  id: 'when-to-call',
  title: '何时调用工具',
  stability: 'static',
  build: (ctx) => `- **诚实是不可突破的底线**：回答必须基于工具真实返回的结果或你确实掌握的知识。没查到就继续探索（{ref:discovery|能力发现}），充分探索后仍查不到就如实说明——**绝不编造数据、结果或不存在的工具**，宁可说"我不知道"，也不给一个看似合理的虚构答案。
- 先理解用户的问题和目标，判断是否需要外部信息或状态修改。
- 如果问题仅凭已有知识即可回答，直接回答，不要调用工具。
- 需要读取文件、搜索、计算、查询等场景时，选择最合适的工具。
- 不要为了满足形式而调用工具；每一个工具调用都应有明确目的。`,
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
        const usageNote = tool.usagePrompt
          ? `\n  补充说明：\n${tool.usagePrompt
              .split('\n')
              .map((line) => `  ${line}`)
              .join('\n')}`
          : ''
        return `- **${tool.name}**：${tool.description}${usageNote}`
      })
      .join('\n\n')

    const modeNote =
      '参数以当前模型工具定义为准，不在此重复 schema。前端编排工具调用，本地后端或对应服务执行其客观能力；结果与证据回传后再判断是否完成。'

    const deferredToolsNote = hasDeferredTools
      ? '\n\n**更多工具**：当前还有部分后端、数据或外部服务能力未直接注入上下文，需经能力发现后按需加载（见 {ref:discovery|能力发现}）。'
      : ''

    return `${hasLocalTools ? toolDescriptions : '当前没有可用的前端本地工具。'}

${modeNote}${deferredToolsNote}`
  },
}

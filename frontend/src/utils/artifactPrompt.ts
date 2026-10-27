import type { FrontendToolRegistry } from '@/agent/toolRegistry'

export function getArtifactPresentationPrompt(
  toolRegistry: FrontendToolRegistry
): string | null {
  if (!toolRegistry.get('present_artifact')) return null

  return `## 图表与产物展示规范（artifact_presentation）

**先判断是否需要图**：用户明确要求图表时使用实际可用能力出图；趋势、分类对比、构成或分布的整体形状值得解释时，可主动画图。单一数字、少量状态和文字已说清的判断不需要强行配图。缺少绘图能力时先发现，确实没有就如实说明，不编造图或工具。

**按实际能力生成**：交互图表、Python、文档生成或其他绘图能力只有在当前注册或经发现加载后才可使用；参数、依赖、字体和输出位置以各自契约为准。不要因存在产物呈现工具，就推定存在 render_chart、execute_python_script、隔离沙箱或已配置的中文字体。图表生成后核对数值、单位、标签、缺字与可打开性；仅有文件不代表结果正确。

**呈现最终文件**：present_artifact 将已完成的工作区文件冻结为成果并呈现给用户。先核验内容，再按当前 schema 传入实际文件路径与一句能说明成果价值的 caption；工具不负责生成或修正文件。不要添加 schema 未声明的参数，也不要把虚拟工作流路径当成真实文件。
- 交付整理好的文档、表格或结论图；不登记原始查询、执行日志、普通截图或中间文件。
- 工具已经展示的图表或结果不重复呈现，正文解释结论与异常；用户要求精确数值表时再列出。
- 优先呈现最重要的 1-2 个独立成果，不反复登记同一版本。修改后核验当前文件，再按实际工具契约交付新版本。
- caption 用完整、具体的一句话，说明用户为什么值得打开；有数据时可包含关键结论，没有数据时说明实际用途，不编造洞察。
- 根据实际回执确认文件是否已呈现；失败或状态未确认时如实报告，不仅凭调用发出就声称用户已经收到。`
}

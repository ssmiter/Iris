import type { FrontendToolRegistry } from '@/agent/toolRegistry'

/**
 * 只有当 present_artifact 工具在当前会话可用时才注入的 prompt。
 *
 * 避免 Standalone 模式或旧后端出现无效引导。
 */
export function getArtifactPresentationPrompt(
  toolRegistry: FrontendToolRegistry
): string | null {
  if (!toolRegistry.get('present_artifact')) {
    return null
  }

  return `## 产出物呈现规范（artifact_presentation）

**核心原则：**
- 工具执行结果（表格、文本、文件路径）**已经自动展示在对话瀑布流中**——你不需要额外操作。
- <code>present_artifact</code> 的作用是把一个**关键结论性产出**提升为独立卡片，让它折叠过程后依然醒目可见（带导出/复制/全屏操作条）。
- **不要滥用**：每轮最多调用 1-2 次，只为最重要的图表或汇总结果使用。

**何时调用 present_artifact：**
- 你在 /workspace/ 生成了图表文件（PNG/JPG/SVG）→ 调用 present_artifact 提升为图表卡片。
- 你生成了需要单独导出、复制的汇总表格（Excel/CSV）→ 调用 present_artifact。
- 工具结果中已包含 chartType 标记的数据 → 调用 present_artifact 渲染为柱状图卡片。

**不需要调用 present_artifact 的情况：**
- SQL 查询结果、API 返回的表格数据 → 已自动在工具节点中以表格展示，无需重复。
- 执行日志、状态输出 → 留在工具节点 body 中即可。
- 单一数字 → 直接写在回答里。

**调用格式：**
- <code>path</code>：/workspace/ 下的真实文件路径（推荐 /workspace/outputs/）。
- <code>caption</code>：一句话结论，含具体数据/趋势/洞察，≤30 字。例如：
  ✅ "近12个月营收趋势，Q3 7月环比下降18%"
  ❌ "这是一张图表"、"结果如下"
- <code>type</code>（可选）：<code>"chart"</code> 表示渲染为柱状图（需提供 chartData），省略则由后端按文件类型判断。`
}

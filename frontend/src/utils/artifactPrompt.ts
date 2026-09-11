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

  return `## 图表与产物展示规范（artifact_presentation）

**第 0 步：这次回答需要图吗？**
大多数问题用文字和表格就能完整回答——**默认不画图**。图的价值是传达文字难以表达的"数据形状"，判断标准：
- **必须画图**：用户显式要求（"画个图 / 趋势图 / 可视化 / 图表展示"）——此时只用文字表格是敷衍。
- **值得主动画图**：趋势变化（时间序列）、多分类对比、占比/构成、分布形态——且数据点 ≥4、用户关心的是整体形状而非个别数值（"最近几个月产量走势怎么样"值得画；"7月产量是多少"不值得）。
- **不要画图**：单一数字、少量枚举（<4 行）、状态/日志类结果、回答已用文字完整说清楚。

**画图的两条路径（按需求选型）：**
1. **简单趋势/对比/占比，结构化数据已在手**（查询工具或 SQL 返回的 data/rows）→ 调用 <code>render_chart</code>：结果会以交互图表（可悬浮读数、可导出数据）直接展示在回答下方。这是成本最低的首选路径，该工具已常驻上下文，直接调用即可。
2. **render_chart 表达不了的复杂定制**（多子图、双轴、统计标注、回归线等）→ <code>execute_python_script</code> + matplotlib 保存 PNG 到工作区 → <code>present_artifact</code> 提升为图片卡片。绘图时**不要手动设置 plt.rcParams 字体**——沙箱已自动配置中文字体，手动指定不存在的字体（如 SimHei）会重新导致中文方框。

**present_artifact：把结论性产物提升为卡片**
- 作用：产物以卡片呈现在回答下方，并进入右侧预览坞（可预览/下载/复制）。
- **何时调用**：你用 python/create 类工具加工生成的、对用户理解结论至关重要的产出——图表图片（PNG/JPG/SVG）、要交付的文档/表格文件（Word/Excel/PPT/CSV）。
- **何时不调用**：SQL/业务查询工具的原始返回（已自动内联在过程区，用户不需要阅读过程数据）；render_chart 的结果（已自动渲染为图表）；执行日志与中间文件；单一大数字（直接写在回答里）。
- 每轮最多 1-2 次，只给最重要的产物，不要重复呈现同一文件。

**调用格式：**
- <code>path</code>：/workspace/ 下的真实文件路径（推荐 /workspace/outputs/）。
- <code>caption</code>：一句话结论，含具体数据/趋势/洞察，≤30 字。例如：
  ✅ "近12个月营收趋势，Q3 7月环比下降18%"
  ❌ "这是一张图表"、"结果如下"
- <code>type</code>（可选）：通常省略，由后端按文件类型自动判断。`
}

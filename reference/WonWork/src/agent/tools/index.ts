import type { Tool } from '@/agent/types'
import { createElement } from 'react'
import type { FrontendToolRegistry } from '@/agent/toolRegistry'
import { evaluateToolFlag } from '@/agent/toolRegistry'
import type { ToolCatalogItem } from '@/types/mescli'
import { webBridgeClient } from '@/api/webbridgeClient'
import { getFileTools } from './fileTools'
import {
  webSearchTool,
  webFetchTool,
  webbridgeNavigateTool,
  webbridgeScreenshotTool,
  webbridgeExtractTool,
  webbridgeLocateTool,
  webbridgeClickTool,
  webbridgeTypeTool,
  webbridgeScrollTool,
  webbridgeWaitTool,
  WebSearchResultRenderer,
  WebSearchThinking,
  WebFetchResultRenderer,
  WebFetchThinking,
  WebBridgePrimitiveResultRenderer,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEBBRIDGE_NAVIGATE_TOOL_NAME,
  WEBBRIDGE_SCREENSHOT_TOOL_NAME,
  WEBBRIDGE_EXTRACT_TOOL_NAME,
  WEBBRIDGE_LOCATE_TOOL_NAME,
  WEBBRIDGE_CLICK_TOOL_NAME,
  WEBBRIDGE_TYPE_TOOL_NAME,
  WEBBRIDGE_SCROLL_TOOL_NAME,
  WEBBRIDGE_WAIT_TOOL_NAME,
} from './web'
import { registerToolRenderer } from './toolRenderRegistry'
import { PresentArtifactRenderer } from '@/components/Chat/PresentArtifactRenderer'
import { ChartRenderer } from '@/components/Chat/ChartRenderer'
import type { ToolResultRendererProps } from './toolRenderRegistry'
import { ApsScheduleResultCard } from '@/features/aps/ApsScheduleResultCard'
import { TaskSessionResultRenderer } from '@/components/Chat/TaskSessionCard'
import { WriteDiffResultRenderer } from '@/components/Chat/DiffView'
import { createToolSearchTool, TOOL_SEARCH_TOOL_NAME, formatToolSearchResult } from './toolSearchTool'
import {
  createListCapabilitiesTool,
  createReadCapabilityTool,
  LIST_CAPABILITIES_TOOL_NAME,
  READ_CAPABILITY_TOOL_NAME,
} from './capabilityDiscoveryTools'
// read_skill/create_skill 已退役并删除（2026-09-03：技能文件在 ~/.wonwork/skills/<id>/SKILL.md，
// 模型用文件原语直读/直写；清单头注入技能目录绝对路径作为定位依据）
// memory_read/memory_write 已退役并删除（2026-09-03：记忆迁文件系统 ~/.wonwork/memory/，
// 模型用文件原语直接管；memoryTools.ts 与旧 memoryStore/SQLite 链路一并移除）
import { registerFactTool, recallFactsTool, forgetFactTool } from './factTools'
import { createAskUserTool } from './askUserTool'
import { updateBoardTool } from './updateBoardTool'
import { setBrowseDirectoryTool } from './setBrowseDirectoryTool'
import { KnowledgeToolResultRenderer } from './knowledgeToolRenderers'

/**
 * 向 ToolRegistry 注册 Standalone 模式下可用的本地工具
 */
export function registerStandaloneTools(
  registry: FrontendToolRegistry,
  systemCode?: string,
  options: { skipExisting?: boolean } = {}
): void {
  const { skipExisting = false } = options

  const tools = getFileTools()
  for (const tool of tools) {
    if (skipExisting && registry.get(tool.name)) continue
    registry.register(tool)
  }

  // L1 能力发现原语：任何模式下都应注册并注入上下文
  registry.register(createListCapabilitiesTool({ systemCode }))
  registry.register(createReadCapabilityTool({ systemCode, registry }))
  // 技能原语已退役（2026-09-03 文件化）：模型用文件原语管 ~/.wonwork/skills/ 下的 SKILL.md
  // tool_search 已 deprecated（v1.6 起发现路径 = grep /capabilities + list_capabilities → read_capability），
  // 不再注册加载；代码保留备查，agenticLoop 中的限次/格式化逻辑为死代码，暂不系统性删除。
  // registry.register(createToolSearchTool({ systemCode, registry }))
}

/**
 * 注册 Web 工具（web_search / web_fetch / 浏览器原语）。
 * 仅当 WebBridge daemon 已连接时才注册；三端（Standalone / MESCLI-Local / MESCLI-Online）统一调用。
 */
export function registerWebTools(
  registry: FrontendToolRegistry,
  options: { skipExisting?: boolean } = {}
): void {
  const { skipExisting = false } = options

  if (!webBridgeClient.isConnected) {
    return
  }

  if (!skipExisting || !registry.get(WEB_SEARCH_TOOL_NAME)) {
    registry.register(webSearchTool)
  }
  if (!skipExisting || !registry.get(WEB_FETCH_TOOL_NAME)) {
    registry.register(webFetchTool)
  }
  const primitiveTools = [
    webbridgeNavigateTool,
    webbridgeScreenshotTool,
    webbridgeExtractTool,
    webbridgeLocateTool,
    webbridgeClickTool,
    webbridgeTypeTool,
    webbridgeScrollTool,
    webbridgeWaitTool,
  ]
  for (const tool of primitiveTools) {
    if (!skipExisting || !registry.get(tool.name)) {
      registry.register(tool)
    }
  }
}

/**
 * 注册事实原语（register_fact / recall_facts / forget_fact）。
 *
 * 2026-09-03 下限工程：memory_read/memory_write 工具已退役——记忆从 SQLite 迁到
 * 文件系统（~/.wonwork/memory/），模型用文件原语（read_file/write_file/str_replace）
 * 直接管文件。本函数只保留事实原语（KV 簿记），与记忆同为前端本地状态、
 * 同走"知道在哪，用时再取"哲学。
 *
 * 子 Agent（generalAgentRun/exploreAgentRun）单独注册 recall_facts 只读件——
 * 查环境坐标（如 SVN 检出路径）是子环境真实需求，事实登记（写件）是用户面向决策不委托。
 */
export function registerMemoryTools(registry: FrontendToolRegistry): void {
  registry.register(registerFactTool)
  registry.register(recallFactsTool)
  registry.register(forgetFactTool)
}

/**
 * 注册交互原语（ask_user）。结构化反问是前端 loop 的通用能力，三端统一注册；
 * 挂起-恢复走 clarifyGate → 脊柱 clarify attention 卡（见 agenticLoop 接线）。
 */
export function registerInteractionTools(registry: FrontendToolRegistry): void {
  registry.register(createAskUserTool())
}

/**
 * 注册进展黑板原语（update_board）。只对主 Agent Loop 注册——调用方（chatStore
 * sendMessage 主 loop 注册序列）与子 Agent 的运行体（generalAgentRun /
 * exploreAgentRun 各自建注册表）是分离的，本函数只在主 loop
 * 侧调用，子 Agent 拿不到该工具（黑板是"本轮对话"的进展载体）。
 */
export function registerBoardTools(registry: FrontendToolRegistry): void {
  registry.register(updateBoardTool)
  // set_browse_directory 与黑板同款纪律：只挂主 Agent Loop（浏览定位是主对话面向
  // 用户的行为），子 Agent（general/explore）与 DAG 各自建注册表、不经本函数。
  registry.register(setBrowseDirectoryTool)
}

/**
 * 注册文件系统原语（read_file / write_file / str_replace / list_files / glob / grep / delete_file）。
 *
 * 2026-07-28：后端模式下不再把 write_file 标记为 elevated（原先导致 auto 模式写 md 也弹审批）。
 * 写工作区与 SQL 写分离：SQL 写有独立 alwaysAsk 链，工作区写由后端 AuthorizeAsync + 登记根目录闸（未登记 409 挑战自愈）+ 工作区外写首问沉淀（directory-write 规则）保底；
 * delete_file 仍为 destructive 必问（在 fileTools 自身声明，不在此处处理）。
 */
export function registerFilePrimitives(
  registry: FrontendToolRegistry,
  isBackendMode = false,
  options: { skipExisting?: boolean } = {}
): void {
  const { skipExisting = false } = options

  for (const tool of getFileTools()) {
    if (skipExisting && registry.get(tool.name)) continue

    registry.register(tool)
  }
}

/**
 * 获取 Standalone 模式下可用的本地工具目录（用于 standaloneToolApi.list）
 */
export function getStandaloneToolCatalog(systemCode?: string): ToolCatalogItem[] {
  const listTool = createListCapabilitiesTool({ systemCode })
  const readTool = createReadCapabilityTool({ systemCode })
  // tool_search 已 deprecated（v1.6），不再进入 Standalone 工具目录
  const primitives: Tool<unknown, unknown>[] = [...getFileTools()]
  if (webBridgeClient.isConnected) {
    primitives.push(
      webSearchTool as Tool<unknown, unknown>,
      webFetchTool as Tool<unknown, unknown>,
      webbridgeNavigateTool as Tool<unknown, unknown>,
      webbridgeScreenshotTool as Tool<unknown, unknown>,
      webbridgeExtractTool as Tool<unknown, unknown>,
      webbridgeLocateTool as Tool<unknown, unknown>,
      webbridgeClickTool as Tool<unknown, unknown>,
      webbridgeTypeTool as Tool<unknown, unknown>,
      webbridgeScrollTool as Tool<unknown, unknown>,
      webbridgeWaitTool as Tool<unknown, unknown>
    )
  }
  const toolsToExpose = [...primitives, listTool, readTool]
  return toolsToExpose.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    riskLevel: tool.riskLevel,
    isReadOnly: evaluateToolFlag(tool.isReadOnly as boolean | ((input: unknown) => boolean) | undefined, {}, false),
    alwaysLoad: tool.alwaysLoad,
  }))
}

// 注册 web 工具专属渲染器（UI 去硬编码入口）
registerToolRenderer(WEB_SEARCH_TOOL_NAME, {
  resultRenderer: WebSearchResultRenderer,
  thinkingRenderer: WebSearchThinking,
})

registerToolRenderer(WEB_FETCH_TOOL_NAME, {
  resultRenderer: WebFetchResultRenderer,
  thinkingRenderer: WebFetchThinking,
})

const primitiveToolNames = [
  WEBBRIDGE_NAVIGATE_TOOL_NAME,
  WEBBRIDGE_SCREENSHOT_TOOL_NAME,
  WEBBRIDGE_EXTRACT_TOOL_NAME,
  WEBBRIDGE_LOCATE_TOOL_NAME,
  WEBBRIDGE_CLICK_TOOL_NAME,
  WEBBRIDGE_TYPE_TOOL_NAME,
  WEBBRIDGE_SCROLL_TOOL_NAME,
  WEBBRIDGE_WAIT_TOOL_NAME,
]
for (const name of primitiveToolNames) {
  registerToolRenderer(name, {
    resultRenderer: WebBridgePrimitiveResultRenderer,
  })
}

registerToolRenderer('present_artifact', {
  resultRenderer: PresentArtifactRenderer,
})

// agent（as_task 派遣回执）：结果提升到正文区渲染为任务会话卡（状态+liveLine+点击进入）——
// 任务卡是长程任务的常驻锚点，必须在正文里直接可见，不能埋进默认折叠的过程区；
// 非任务派遣（普通后台/同步）不提升（promoteResultWhen 判 taskConversationId），
// 渲染器返回 null 时交回默认摘要行。
// 工具名用字面量：agentTool → taskSession → chatStore → 本文件已成环，
// 顶层 const 跨模块引用在生产构建有 TDZ 白屏前科，这里断掉这条边。
registerToolRenderer('agent', {
  resultRenderer: TaskSessionResultRenderer,
  promoteResultWhen: (result) =>
    (result as { taskConversationId?: unknown } | null | undefined)?.taskConversationId != null,
})

// write_file / str_replace：结果留痕渲染为 hunk 级 diff 卡（改了什么一眼可见）。
// 两侧内容从 argsText（模型原始参数，已随历史持久化）渲染期重建，
// 结果对象不回传文件内容（防模型上下文膨胀）。解析失败渲染器内落回摘要行。
// 工具名用字面量：与上方 agent 注册同款 TDZ 断边纪律。
registerToolRenderer('write_file', {
  resultRenderer: WriteDiffResultRenderer,
})
registerToolRenderer('str_replace', {
  resultRenderer: WriteDiffResultRenderer,
})

// memory_read：工具已退役（2026-09-03 记忆文件化），其水墨卡片渲染器一并删除——
// 旧历史里的 memory_read 调用记录回落到默认结果渲染。

registerToolRenderer('knowledge_search', {
  resultRenderer: KnowledgeToolResultRenderer,
  promoteResult: true,
})

registerToolRenderer('knowledge_read', {
  resultRenderer: KnowledgeToolResultRenderer,
  promoteResult: true,
})

registerToolRenderer('iris_aps_review_result', {
  resultRenderer: ApsScheduleResultCard,
  promoteResult: true,
})

// render_chart（后端工具）：结果提升到回答下方渲染为交互图表（ECharts）。
// 没有此注册时，render_chart 的 {chart, data} 只显示为过程区内联表格，图表不可见。
function RenderChartResultRenderer({ message }: ToolResultRendererProps) {
  return createElement(ChartRenderer, { structuredData: message.structuredData })
}
registerToolRenderer('render_chart', {
  resultRenderer: RenderChartResultRenderer,
  promoteResult: true,
})

export * from './fileTools'
export * from './web'
export * from './toolSearchTool'
export * from './capabilityDiscoveryTools'
export * from './askUserTool'
export * from './updateBoardTool'
export * from './setBrowseDirectoryTool'

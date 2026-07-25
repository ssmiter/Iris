import type { Tool } from '@/agent/types'
import type { FrontendToolRegistry } from '@/agent/toolRegistry'
import { evaluateToolFlag } from '@/agent/toolRegistry'
import type { ToolCatalogItem } from '@/types/mescli'
import { webBridgeClient } from '@/api/webbridgeClient'
import { getFileTools } from './fileTools'
import {
  webSearchTool,
  webFetchTool,
  webbridgeExecuteTool,
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
  WebBridgeExecuteResultRenderer,
  WebBridgePrimitiveResultRenderer,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEBBRIDGE_EXECUTE_TOOL_NAME,
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
import { ApsScheduleResultCard } from '@/features/aps/ApsScheduleResultCard'
import { createToolSearchTool, TOOL_SEARCH_TOOL_NAME, formatToolSearchResult } from './toolSearchTool'
import {
  createListCapabilitiesTool,
  createReadCapabilityTool,
  LIST_CAPABILITIES_TOOL_NAME,
  READ_CAPABILITY_TOOL_NAME,
} from './capabilityDiscoveryTools'

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
  // tool_search 保留作为辅助发现手段
  registry.register(createToolSearchTool({ systemCode, registry }))
}

/**
 * 注册 Web 工具（web_search / web_fetch / webbridge_* 原语 / webbridge_execute）。
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
 * 注册文件系统原语（read_file / write_file / str_replace / list_files / glob / grep / delete_file）。
 *
 * 在 MESCLI 模式下调用时，写/删工具会被标记为 elevated/destructive，从而进入前端审批流，
 * 因为实际写操作会通过后端 Workspace API 落盘。
 */
export function registerFilePrimitives(
  registry: FrontendToolRegistry,
  isBackendMode = false,
  options: { skipExisting?: boolean } = {}
): void {
  const { skipExisting = false } = options

  for (const tool of getFileTools()) {
    if (skipExisting && registry.get(tool.name)) continue

    if (isBackendMode && tool.name === 'write_file') {
      registry.register({ ...tool, riskLevel: 'elevated' })
    } else {
      registry.register(tool)
    }
  }
}

/**
 * 获取 Standalone 模式下可用的本地工具目录（用于 standaloneToolApi.list）
 */
export function getStandaloneToolCatalog(systemCode?: string): ToolCatalogItem[] {
  const listTool = createListCapabilitiesTool({ systemCode })
  const readTool = createReadCapabilityTool({ systemCode })
  const searchTool = createToolSearchTool({ systemCode })
  const primitives: Tool<unknown, unknown>[] = [...getFileTools()]
  if (webBridgeClient.isConnected) {
    primitives.push(
      webSearchTool as Tool<unknown, unknown>,
      webFetchTool as Tool<unknown, unknown>,
      webbridgeExecuteTool as Tool<unknown, unknown>,
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
  const toolsToExpose = [...primitives, listTool, readTool, searchTool]
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

registerToolRenderer(WEBBRIDGE_EXECUTE_TOOL_NAME, {
  resultRenderer: WebBridgeExecuteResultRenderer,
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

registerToolRenderer('iris_aps_review_result', {
  resultRenderer: ApsScheduleResultCard,
  promoteResult: true,
})

export * from './fileTools'
export * from './web'
export * from './toolSearchTool'
export * from './capabilityDiscoveryTools'

export { webSearchTool } from './search/webSearchTool'
export { webFetchTool } from './fetch/webFetchTool'
export type {
  WebSearchOptions,
  WebSearchResult,
  WebSearchHit,
  WebSearchProgress,
  WebFetchOptions,
  WebFetchResult,
} from './types'
export { WEB_SEARCH_TOOL_NAME, getWebSearchPrompt } from './search/prompt'
export { WEB_FETCH_TOOL_NAME, getWebFetchPrompt } from './fetch/prompt'
export {
  resolveSearchAdapter,
  resolveFetchAdapter,
  WebBridgeSearchAdapter,
  WebBridgeFetchAdapter,
  HttpSearchAdapter,
  HttpFetchAdapter,
} from './adapters'
export type { HttpSearchConfig } from './adapters'
export { WebSearchResult as WebSearchResultRenderer } from './search/WebSearchResult'
export { WebSearchThinking } from './search/WebSearchThinking'
export { WebFetchResult as WebFetchResultRenderer } from './fetch/WebFetchResult'
export { WebFetchThinking } from './fetch/WebFetchThinking'

// WebBridge 复合工具（降级保留，用于简单 1-3 步任务）
export { webbridgeExecuteTool } from './bridge/webbridgeExecuteTool'
export { WebBridgeExecuteResult as WebBridgeExecuteResultRenderer } from './bridge/WebBridgeExecuteResult'
export type {
  WebBridgeExecuteInput,
  WebBridgeExecuteResult as WebBridgeExecuteResultData,
} from './bridge/webbridgeExecuteTool'
export const WEBBRIDGE_EXECUTE_TOOL_NAME = 'webbridge_execute'

// WebBridge Sense-Act-Verify 原语
export { webbridgeNavigateTool, WEBBRIDGE_NAVIGATE_TOOL_NAME } from './bridge/webbridgeNavigateTool'
export { webbridgeScreenshotTool, WEBBRIDGE_SCREENSHOT_TOOL_NAME } from './bridge/webbridgeScreenshotTool'
export { webbridgeExtractTool, WEBBRIDGE_EXTRACT_TOOL_NAME } from './bridge/webbridgeExtractTool'
export { webbridgeLocateTool, WEBBRIDGE_LOCATE_TOOL_NAME } from './bridge/webbridgeLocateTool'
export { webbridgeClickTool, WEBBRIDGE_CLICK_TOOL_NAME } from './bridge/webbridgeClickTool'
export { webbridgeTypeTool, WEBBRIDGE_TYPE_TOOL_NAME } from './bridge/webbridgeTypeTool'
export { webbridgeScrollTool, WEBBRIDGE_SCROLL_TOOL_NAME } from './bridge/webbridgeScrollTool'
export { webbridgeWaitTool, WEBBRIDGE_WAIT_TOOL_NAME } from './bridge/webbridgeWaitTool'
export { WebBridgePrimitiveResult as WebBridgePrimitiveResultRenderer } from './bridge/WebBridgePrimitiveResult'

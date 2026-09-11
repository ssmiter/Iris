import { createTool } from '@/agent/toolFactory'
import type { ToolExecutionContext } from '@/agent/types'
import type { WebBridgePrimitiveResult } from './webbridgePrimitives'
import {
  sendBrowserAction,
  getCurrentPageState,
  buildPrimitiveResult,
} from './webbridgePrimitives'

export const WEBBRIDGE_NAVIGATE_TOOL_NAME = 'webbridge_navigate'

interface WebBridgeNavigateInput {
  url: string
  timeout_ms?: number
}

export const webbridgeNavigateTool = createTool<WebBridgeNavigateInput, WebBridgePrimitiveResult>({
  name: WEBBRIDGE_NAVIGATE_TOOL_NAME,
  description: '用 WebBridge 打开指定 URL 并返回当前页面状态。',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        description: '要打开的网址，例如 https://example.com',
      },
      timeout_ms: {
        type: 'number',
        description: '页面加载超时时间（毫秒），默认 30000',
        default: 30000,
      },
    },
  },
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: false,
  alwaysLoad: true,
  category: 'web',
  usagePrompt: '示例：{"url":"https://example.com"}',
  async execute(input, ctx: ToolExecutionContext): Promise<WebBridgePrimitiveResult> {
    const result = await sendBrowserAction(
      {
        action_type: 'navigate',
        value: input.url,
        timeout_ms: input.timeout_ms || 30000,
        description: `导航到 ${input.url}`,
      },
      ctx
    )

    const pageState = result.page_state_after || (await getCurrentPageState())
    return buildPrimitiveResult(true, pageState, `已打开 ${pageState.url || input.url}`)
  },
})

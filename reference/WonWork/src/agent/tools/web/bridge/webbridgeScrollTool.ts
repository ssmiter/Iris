import { createTool } from '@/agent/toolFactory'
import type { ToolExecutionContext } from '@/agent/types'
import type { WebBridgePrimitiveResult } from './webbridgePrimitives'
import {
  sendBrowserAction,
  getCurrentPageState,
  buildPrimitiveResult,
} from './webbridgePrimitives'

export const WEBBRIDGE_SCROLL_TOOL_NAME = 'webbridge_scroll'

interface WebBridgeScrollInput {
  direction: 'down' | 'up' | 'top' | 'bottom' | 'to'
  amount?: number
  y?: number
}

export const webbridgeScrollTool = createTool<WebBridgeScrollInput, WebBridgePrimitiveResult>({
  name: WEBBRIDGE_SCROLL_TOOL_NAME,
  description: '滚动浏览器页面。',
  inputSchema: {
    type: 'object',
    required: ['direction'],
    properties: {
      direction: {
        type: 'string',
        enum: ['down', 'up', 'top', 'bottom', 'to'],
        description: '滚动方向',
      },
      amount: {
        type: 'number',
        description: 'down/up 时的像素距离，默认 800',
      },
      y: {
        type: 'number',
        description: 'direction=to 时的目标 Y 坐标',
      },
    },
  },
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: false,
  alwaysLoad: true,
  category: 'web',
  usagePrompt: '示例：{"direction":"down"}；回顶部：{"direction":"top"}',
  async execute(input, ctx: ToolExecutionContext): Promise<WebBridgePrimitiveResult> {
    let actionType: 'scroll' | 'scroll_to' | 'scroll_to_top' | 'scroll_to_bottom'
    let amount: number | undefined
    let y: number | undefined

    switch (input.direction) {
      case 'down':
        actionType = 'scroll'
        amount = input.amount || 800
        break
      case 'up':
        actionType = 'scroll'
        amount = -(input.amount || 800)
        break
      case 'top':
        actionType = 'scroll_to_top'
        break
      case 'bottom':
        actionType = 'scroll_to_bottom'
        break
      case 'to':
        actionType = 'scroll_to'
        y = input.y || 0
        break
      default:
        actionType = 'scroll'
        amount = 800
    }

    const result = await sendBrowserAction(
      {
        action_type: actionType,
        amount,
        coordinates: y !== undefined ? [0, y] : undefined,
        description: `滚动：${input.direction}`,
      },
      ctx
    )

    const pageState = result.page_state_after || (await getCurrentPageState())
    return buildPrimitiveResult(
      true,
      pageState,
      `已滚动至 ${pageState.scroll_y || 0}px，当前页面：${pageState.title}`
    )
  },
})

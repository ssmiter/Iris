import { createTool } from '@/agent/toolFactory'
import type { ToolExecutionContext } from '@/agent/types'
import type { WebBridgePrimitiveResult } from './webbridgePrimitives'
import {
  sendBrowserAction,
  getCurrentPageState,
  buildPrimitiveResult,
} from './webbridgePrimitives'

export const WEBBRIDGE_WAIT_TOOL_NAME = 'webbridge_wait'

interface WebBridgeWaitInput {
  condition: 'time' | 'element'
  delay_ms?: number
  selector?: string
}

export const webbridgeWaitTool = createTool<WebBridgeWaitInput, WebBridgePrimitiveResult>({
  name: WEBBRIDGE_WAIT_TOOL_NAME,
  description: '等待固定时间或等待页面上出现某个元素。',
  inputSchema: {
    type: 'object',
    required: ['condition'],
    properties: {
      condition: {
        type: 'string',
        enum: ['time', 'element'],
        description: '等待条件',
      },
      delay_ms: {
        type: 'number',
        description: 'condition=time 时的等待毫秒数，默认 1000',
      },
      selector: {
        type: 'string',
        description: 'condition=element 时的 CSS 选择器',
      },
    },
  },
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: false,
  alwaysLoad: true,
  category: 'web',
  usagePrompt: '等 1 秒：{"condition":"time","delay_ms":1000}；等元素：{"condition":"element","selector":".result"}',
  async execute(input, ctx: ToolExecutionContext): Promise<WebBridgePrimitiveResult> {
    if (input.condition === 'element' && !input.selector) {
      throw new Error('condition=element 时必须提供 selector')
    }

    const result = await sendBrowserAction(
      {
        action_type: input.condition === 'element' ? 'wait_for_element' : 'wait',
        delay_ms: input.delay_ms || 1000,
        selector:
          input.condition === 'element'
            ? { selector_type: 'css', value: input.selector! }
            : undefined,
        description: `等待：${input.condition}`,
      },
      ctx
    )

    const pageState = result.page_state_after || (await getCurrentPageState())
    const summary =
      input.condition === 'element'
        ? `元素 ${input.selector} 已出现`
        : `已等待 ${input.delay_ms || 1000}ms`

    return buildPrimitiveResult(true, pageState, summary)
  },
})

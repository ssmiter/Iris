import { createTool } from '@/agent/toolFactory'
import type { ToolExecutionContext } from '@/agent/types'
import type { WebBridgePrimitiveResult } from './webbridgePrimitives'
import {
  sendBrowserAction,
  getCurrentPageState,
  buildLocateScript,
  buildPrimitiveResult,
  expandEquivalents,
} from './webbridgePrimitives'

export const WEBBRIDGE_LOCATE_TOOL_NAME = 'webbridge_locate'

interface WebBridgeLocateInput {
  target: string
  max_candidates?: number
}

export const webbridgeLocateTool = createTool<WebBridgeLocateInput, WebBridgePrimitiveResult>({
  name: WEBBRIDGE_LOCATE_TOOL_NAME,
  description:
    '在当前页面中定位与目标文本/描述匹配的元素，返回候选选择器列表。' +
    '不确定元素位置时，先用此工具探测，再结合截图验证。',
  inputSchema: {
    type: 'object',
    required: ['target'],
    properties: {
      target: {
        type: 'string',
        description: '要定位的可见文本或元素描述，例如"登录按钮"、"搜索框"',
      },
      max_candidates: {
        type: 'number',
        description: '返回的最大候选数，默认 5',
        default: 5,
      },
    },
  },
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: false,
  alwaysLoad: true,
  category: 'web',
  usagePrompt: '示例：{"target":"登录按钮"}',
  async execute(input, ctx: ToolExecutionContext): Promise<WebBridgePrimitiveResult> {
    const result = await sendBrowserAction(
      {
        action_type: 'evaluate',
        value: buildLocateScript(input.target, input.max_candidates ?? 5, expandEquivalents(input.target)),
        description: `定位：${input.target}`,
      },
      ctx
    )

    const candidates = Array.isArray(result.data)
      ? (result.data as Array<{ selector: string; text: string; tag: string }>)
      : []

    const pageState = result.page_state_after || (await getCurrentPageState())

    if (candidates.length === 0) {
      return buildPrimitiveResult(
        true,
        pageState,
        `未找到与 "${input.target}" 匹配的元素。建议截图或提取页面文本查看当前状态。`,
        { candidates: [] }
      )
    }

    const summary = `找到 ${candidates.length} 个候选元素：\n${candidates
      .map((c, i) => `${i + 1}. <${c.tag}> ${c.selector} — ${c.text.slice(0, 80)}`)
      .join('\n')}`

    return buildPrimitiveResult(true, pageState, summary, { candidates })
  },
})

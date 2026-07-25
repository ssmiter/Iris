import { createTool } from '@/agent/toolFactory'
import type { ToolExecutionContext } from '@/agent/types'
import type { WebBridgePrimitiveResult } from './webbridgePrimitives'
import {
  sendBrowserAction,
  getCurrentPageState,
  buildArtifactPath,
  writeArtifact,
  buildPrimitiveResult,
} from './webbridgePrimitives'

export const WEBBRIDGE_SCREENSHOT_TOOL_NAME = 'webbridge_screenshot'

interface WebBridgeScreenshotInput {
  /** 暂不支持元素截图，保留字段供后续扩展 */
  selector?: string
  full_page?: boolean
}

export const webbridgeScreenshotTool = createTool<WebBridgeScreenshotInput, WebBridgePrimitiveResult>({
  name: WEBBRIDGE_SCREENSHOT_TOOL_NAME,
  description: '对当前浏览器页面截图，返回 PNG 在工作区中的路径。',
  inputSchema: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: '（可选）未来用于截取指定元素；当前仅支持整页截图',
      },
      full_page: {
        type: 'boolean',
        description: '（可选）是否截取完整页面；当前默认整页截图',
        default: true,
      },
    },
  },
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: false,
  alwaysLoad: true,
  category: 'web',
  usagePrompt: '示例：{}',
  async execute(input, ctx: ToolExecutionContext): Promise<WebBridgePrimitiveResult> {
    const fullPage = input.full_page !== false // 默认全页截图

    const result = await sendBrowserAction(
      {
        action_type: 'screenshot',
        description: '截图',
        options: { full_page: fullPage },
      },
      ctx
    )

    const imageBase64 = typeof result.data === 'string' ? result.data : ''
    if (!imageBase64) {
      throw new Error('截图未返回图片数据')
    }

    const path = buildArtifactPath('screenshot', 'png', imageBase64.slice(0, 100))
    await writeArtifact(path, imageBase64, { encoding: 'base64' })

    const pageState = result.page_state_after || (await getCurrentPageState())
    return buildPrimitiveResult(true, pageState, '截图已保存', {
      screenshotPath: path,
    })
  },
})

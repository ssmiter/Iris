import { createTool } from '@/agent/toolFactory'
import type { ToolExecutionContext } from '@/agent/types'
import type { ElementSelector } from '@/types/webbridge'
import type { ActionResult } from '@/types/webbridge'
import type { WebBridgePrimitiveResult } from './webbridgePrimitives'
import {
  sendBrowserAction,
  getCurrentPageState,
  targetToSelector,
  buildArtifactPath,
  writeArtifact,
  buildPrimitiveResult,
  expandEquivalents,
  describeStateChange,
  WebBridgeActionError,
} from './webbridgePrimitives'

export const WEBBRIDGE_CLICK_TOOL_NAME = 'webbridge_click'

interface WebBridgeClickInput {
  target?: string
  selector?: string
  selector_type?: 'css' | 'text' | 'text_exact' | 'xpath' | 'id'
}

function resolveSelector(input: WebBridgeClickInput): ElementSelector {
  if (input.target) {
    return targetToSelector(input.target)
  }
  if (!input.selector) {
    throw new Error('必须提供 target 或 selector 之一')
  }
  return {
    selector_type: input.selector_type || 'css',
    value: input.selector,
  }
}

export const webbridgeClickTool = createTool<WebBridgeClickInput, WebBridgePrimitiveResult>({
  name: WEBBRIDGE_CLICK_TOOL_NAME,
  description: '在浏览器中点击指定元素。支持自然语言 target 或显式 selector。',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: '自然语言目标，例如"登录按钮"、"第一个搜索结果链接"',
      },
      selector: {
        type: 'string',
        description: '显式选择器字符串',
      },
      selector_type: {
        type: 'string',
        enum: ['css', 'text', 'text_exact', 'xpath', 'id'],
        description: 'selector 的类型，默认 css',
      },
    },
  },
  riskLevel: 'standard',
  isReadOnly: false,
  isConcurrencySafe: false,
  alwaysLoad: true,
  category: 'web',
  usagePrompt: '自然语言：{"target":"登录按钮"}；显式 CSS：{"selector":"#submit","selector_type":"css"}',
  validateInput: (input) => {
    const i = input as WebBridgeClickInput
    if (!i.target && !i.selector) {
      return { valid: false, error: '必须提供 target 或 selector 之一' }
    }
    return { valid: true }
  },
  async execute(input, ctx: ToolExecutionContext): Promise<WebBridgePrimitiveResult> {
    const selector = resolveSelector(input)
    const label = input.target || input.selector || ''

    // 语义等价重试：自然语言文本定位失败（element_not_found）时，
    // 按等价词表自动换词再试（"乘"→"×"，"等号"→"="），不再要求模型手动降级
    let actionResult: ActionResult | null = null
    let lastErr: unknown = null
    let matchedVariant: string | null = null
    const variants = selector.selector_type === 'text' ? expandEquivalents(selector.value) : [selector.value]
    for (const variant of variants) {
      try {
        actionResult = await sendBrowserAction(
          {
            action_type: 'click',
            selector: { ...selector, value: variant },
            description: `点击 ${label}`,
          },
          ctx
        )
        matchedVariant = variant
        break
      } catch (err) {
        lastErr = err
        const retryable = err instanceof WebBridgeActionError && err.reason === 'element_not_found'
        if (!retryable) break
      }
    }

    if (!actionResult) {
      const pageState = await getCurrentPageState()
      const screenshotResult = await sendBrowserAction(
        { action_type: 'screenshot', description: '点击失败后截图' },
        ctx
      )
      const imageBase64 = screenshotResult.success && typeof screenshotResult.data === 'string' ? screenshotResult.data : ''
      let screenshotPath: string | undefined
      if (imageBase64) {
        screenshotPath = buildArtifactPath('click_error', 'png', imageBase64.slice(0, 100))
        await writeArtifact(screenshotPath, imageBase64, { encoding: 'base64' })
      }
      const errorMessage = lastErr instanceof Error ? lastErr.message : String(lastErr)
      const reason = lastErr instanceof WebBridgeActionError ? lastErr.reason : undefined
      const details = lastErr instanceof WebBridgeActionError ? lastErr.details : undefined
      return buildPrimitiveResult(
        false,
        pageState,
        `点击 ${label} 失败：${errorMessage}${details ? `\n建议：${details}` : ''}`,
        { screenshotPath, error: errorMessage, reason }
      )
    }

    // 给页面短暂时间完成导航/渲染，再获取状态和截图
    await new Promise((resolve) => setTimeout(resolve, 400))

    const pageState = await getCurrentPageState()

    // 点击后自动截图，给模型客观反馈
    const screenshotResult = await sendBrowserAction(
      { action_type: 'screenshot', description: '点击后截图' },
      ctx
    )
    const imageBase64 =
      screenshotResult.success && typeof screenshotResult.data === 'string'
        ? screenshotResult.data
        : ''
    let screenshotPath: string | undefined
    if (imageBase64) {
      screenshotPath = buildArtifactPath('click_after', 'png', imageBase64.slice(0, 100))
      await writeArtifact(screenshotPath, imageBase64, { encoding: 'base64' })
    }

    const variantNote = matchedVariant && matchedVariant !== label ? `（等价词 "${matchedVariant}" 命中）` : ''
    return buildPrimitiveResult(
      true,
      pageState,
      `已点击 ${label}${variantNote}，当前页面：${pageState.title}（${pageState.url}）${describeStateChange(actionResult.state_change)}`,
      { screenshotPath, stateChange: actionResult.state_change }
    )
  },
})

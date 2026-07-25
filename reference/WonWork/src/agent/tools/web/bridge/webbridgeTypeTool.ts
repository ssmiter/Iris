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

export const WEBBRIDGE_TYPE_TOOL_NAME = 'webbridge_type'

interface WebBridgeTypeInput {
  target?: string
  selector?: string
  selector_type?: 'css' | 'text' | 'text_exact' | 'xpath' | 'id'
  value: string
  submit?: boolean
}

function resolveSelector(input: WebBridgeTypeInput): ElementSelector {
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

export const webbridgeTypeTool = createTool<WebBridgeTypeInput, WebBridgePrimitiveResult>({
  name: WEBBRIDGE_TYPE_TOOL_NAME,
  description: '在浏览器输入框中输入文本。支持自然语言 target 或显式 selector。',
  inputSchema: {
    type: 'object',
    required: ['value'],
    properties: {
      target: {
        type: 'string',
        description: '自然语言目标，例如"用户名输入框"',
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
      value: {
        type: 'string',
        description: '要输入的文本',
      },
      submit: {
        type: 'boolean',
        description: '输入后是否按 Enter 提交（例如搜索框）',
        default: false,
      },
    },
  },
  riskLevel: 'standard',
  isReadOnly: false,
  isConcurrencySafe: false,
  alwaysLoad: true,
  category: 'web',
  usagePrompt: '自然语言：{"target":"搜索框","value":"Claude Code","submit":true}；显式 CSS：{"selector":"input[name=q]","value":"Claude Code"}',
  validateInput: (input) => {
    const i = input as WebBridgeTypeInput
    if (!i.target && !i.selector) {
      return { valid: false, error: '必须提供 target 或 selector 之一' }
    }
    if (typeof i.value !== 'string') {
      return { valid: false, error: '必须提供 value' }
    }
    return { valid: true }
  },
  async execute(input, ctx: ToolExecutionContext): Promise<WebBridgePrimitiveResult> {
    const selector = resolveSelector(input)
    const label = input.target || input.selector || ''

    // 语义等价重试：与 click 同理，文本定位失败时自动换等价词再试
    let actionResult: ActionResult | null = null
    let lastErr: unknown = null
    const variants = selector.selector_type === 'text' ? expandEquivalents(selector.value) : [selector.value]
    for (const variant of variants) {
      try {
        actionResult = await sendBrowserAction(
          {
            action_type: 'type',
            selector: { ...selector, value: variant },
            value: input.value,
            description: `在 ${label} 输入文本`,
            options: { submit: input.submit === true },
          },
          ctx
        )
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
        { action_type: 'screenshot', description: '输入失败后截图' },
        ctx
      )
      const imageBase64 = screenshotResult.success && typeof screenshotResult.data === 'string' ? screenshotResult.data : ''
      let screenshotPath: string | undefined
      if (imageBase64) {
        screenshotPath = buildArtifactPath('type_error', 'png', imageBase64.slice(0, 100))
        await writeArtifact(screenshotPath, imageBase64, { encoding: 'base64' })
      }
      const errorMessage = lastErr instanceof Error ? lastErr.message : String(lastErr)
      const reason = lastErr instanceof WebBridgeActionError ? lastErr.reason : undefined
      const details = lastErr instanceof WebBridgeActionError ? lastErr.details : undefined
      return buildPrimitiveResult(
        false,
        pageState,
        `在 ${label} 输入失败：${errorMessage}${details ? `\n建议：${details}` : ''}`,
        { screenshotPath, error: errorMessage, reason }
      )
    }

    await new Promise((resolve) => setTimeout(resolve, 300))

    const pageState = await getCurrentPageState()

    const screenshotResult = await sendBrowserAction(
      { action_type: 'screenshot', description: '输入后截图' },
      ctx
    )
    const imageBase64 =
      screenshotResult.success && typeof screenshotResult.data === 'string'
        ? screenshotResult.data
        : ''
    let screenshotPath: string | undefined
    if (imageBase64) {
      screenshotPath = buildArtifactPath('type_after', 'png', imageBase64.slice(0, 100))
      await writeArtifact(screenshotPath, imageBase64, { encoding: 'base64' })
    }

    return buildPrimitiveResult(
      true,
      pageState,
      `已在 ${label} 输入 "${input.value}"，当前页面：${pageState.title}${describeStateChange(actionResult.state_change)}`,
      { screenshotPath, stateChange: actionResult.state_change }
    )
  },
})

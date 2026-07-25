import { createTool } from '@/agent/toolFactory'
import type { ToolExecutionContext } from '@/agent/types'
import { webBridgeClient } from '@/api/webbridgeClient'
import { chatApi, userConfigApi } from '@/api/client'
import { useWebBridgeStore, inferActionsFromText } from '@/stores/webbridgeStore'
import { useAuthStore } from '@/stores/authStore'
import { writeFile } from '@/services/fileSystem'
import { safeStringify } from '@/utils/safeSerialize'
import { sanitizeControlCharacters, extractWebBridgeWorkflowSafe } from '@/utils/webbridgePrompt'
import { getFormattingPrompt } from '@/utils/formattingPrompt'
import { buildCapabilityRegistry } from '@/utils/capabilityRegistry'
import { getRuntimeMode } from '@/utils/runtimeMode'
import type { Message } from '@/types/mescli'
import type {
  BrowserAction,
  WorkflowStep,
  WorkflowType,
} from '@/types/webbridge'

export const WEBBRIDGE_EXECUTE_TOOL_NAME = 'webbridge_execute'

const INTERACTIVE_ACTION_TYPES = new Set<BrowserAction['action_type']>([
  'click',
  'double_click',
  'right_click',
  'hover',
  'type',
  'clear',
  'select',
  'check',
  'upload',
  'new_tab',
  'switch_tab',
  'close_tab',
  'evaluate',
  'export_table',
])

function nowTimestamp(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
}

function simpleHash(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0
  }
  return Math.abs(hash).toString(36).slice(0, 6)
}

function sanitizeKey(input: string): string {
  return input
    .replace(/[\\/:*?"()<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 60)
    .replace(/^_+|_+$/g, '')
}

function isWorkflowReadOnly(workflow: Record<string, unknown>): boolean {
  const steps = workflow.steps as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(steps)) return false
  for (const step of steps) {
    const actions = step.actions as BrowserAction[] | undefined
    if (!Array.isArray(actions)) continue
    for (const action of actions) {
      if (INTERACTIVE_ACTION_TYPES.has(action.action_type)) return false
    }
  }
  return true
}

function truncateText(text: string, max = 2000): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…（已省略 ${text.length - max} 字符）`
}

function isComplexInstruction(text: string): boolean {
  const complexMarkers = [
    /如果|若|when\s+if\b/i,
    /循环|重复|foreach|while\b/i,
    /工作流|workflow\b/i,
    /多步|多个|批量|批量|all\s+pages\b/i,
  ]
  return complexMarkers.some((m) => m.test(text))
}

export interface WebBridgeExecuteInput {
  instruction: string
  /** 内部兜底参数：供 agenticLoop 将 <webbridge> JSON 直接转工作流执行，不暴露在模型 schema 中 */
  workflow?: Record<string, unknown>
}

export interface WebBridgeExecuteResult {
  success: boolean
  workflow_name: string
  success_count: number
  total_actions: number
  summary: string
  screenshot_paths: string[]
  results: Array<{
    step: number
    action: string
    success: boolean
    data_summary: string
    error?: string
  }>
}

function validateWorkflowJson(json: Record<string, unknown>): { valid: boolean; error?: string } {
  if (typeof json.name !== 'string' || json.name.trim().length === 0) {
    return { valid: false, error: '工作流缺少 name 字段' }
  }
  if (!Array.isArray(json.steps) || json.steps.length === 0) {
    return { valid: false, error: '工作流缺少 steps 数组或数组为空' }
  }
  for (let i = 0; i < json.steps.length; i++) {
    const step = json.steps[i] as Record<string, unknown>
    if (!Array.isArray(step.actions) || step.actions.length === 0) {
      return { valid: false, error: `步骤 ${i + 1} 缺少 actions 数组` }
    }
  }
  return { valid: true }
}

async function generateWorkflowFromInstruction(instruction: string): Promise<Record<string, unknown>> {
  const { useChatStore } = await import('@/stores/chatStore')
  const provider = useChatStore.getState().activeProvider
  if (!provider) {
    throw new Error('未选择 LLM 提供商，无法将自然语言指令转换为 WebBridge 工作流')
  }
  const providerName = provider.provider
  const model = provider.model
  const baseUrl = provider.baseUrl

  let apiKey: string | undefined
  try {
    const keyResult = await userConfigApi.getApiKey(providerName)
    apiKey = keyResult.apiKey
  } catch {
    // 让后端使用默认配置
  }

  const registry = buildCapabilityRegistry({
    mode: getRuntimeMode(),
    webBridgeStatus: useWebBridgeStore.getState().status,
    isMesLoggedIn: useAuthStore.getState().isMesLoggedIn,
  })

  const availabilityNote = registry.webBridge.isAvailable
    ? 'WebBridge 已连接，请直接生成可执行工作流。'
    : `注意：WebBridge 当前未连接（状态：${registry.webBridge.status}），生成的工作流如果执行会报错。`

  const systemPrompt = `你是一名浏览器自动化专家。${availabilityNote}
请把用户的自然语言需求转换为合法的 WebBridge 工作流 JSON。

**输出要求**：
- 只输出一个合法 JSON 对象，不要 Markdown 代码块、不要解释、不要 <webbridge> 标签。
- 必须包含字段：name（简短名称）、description（描述）、workflow_type（data_extraction / form_automation / monitoring / research / comparison / custom）、steps（数组）。
- 每个 step 必须包含：step_id（字符串）、description（描述）、actions（动作数组）、on_error（"stop" / "skip" / "retry"）。
- 常用 action_type：navigate（value=URL）、screenshot、extract_text、extract_html、extract_table、click（selector）、type（selector + value）、wait（delay_ms）、evaluate（value=JS）。
- 如不确认元素选择器，先用 navigate + screenshot + extract_text 探索页面。
- 字符串中的换行使用 \\n 转义。

**示例工作流**：
{"name":"查看示例页面","description":"打开示例页面并截图","workflow_type":"data_extraction","steps":[{"step_id":"1","description":"打开页面","actions":[{"action_type":"navigate","value":"https://example.com"}],"on_error":"stop"},{"step_id":"2","description":"截图","actions":[{"action_type":"screenshot"}],"on_error":"stop"}]}`

  const messages: Message[] = [
    { role: 'system', content: systemPrompt + '\n\n' + getFormattingPrompt() },
    { role: 'user', content: instruction },
  ]

  async function tryGenerate(errorHint?: string): Promise<Record<string, unknown>> {
    const promptMessages = errorHint
      ? [
          ...messages,
          { role: 'assistant', content: '' },
          { role: 'user', content: `之前生成的工作流校验失败：${errorHint}。请修正并重新输出完整合法的工作流 JSON，只输出 JSON。` },
        ]
      : messages

    return new Promise((resolve, reject) => {
      let collected = ''
      const abort = chatApi.streamChat(
        {
          provider: providerName,
          model,
          baseUrl,
          apiKey,
          messages: promptMessages,
          saveToHistory: false,
        } as any,
        (chunk) => {
          if (chunk.type === 'content') {
            collected += chunk.content || ''
          } else if (chunk.type === 'error') {
            reject(new Error(chunk.content || '工作流生成失败'))
          }
        },
        (error) => reject(error),
        () => {
          let jsonText: string | undefined
          // 模型可能仍包裹 <webbridge>，兜底提取
          const extracted = extractWebBridgeWorkflowSafe(collected)
          jsonText = extracted.jsonText || collected

          // 去除可能的 markdown 代码块
          jsonText = jsonText
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim()

          if (!jsonText) {
            reject(new Error('未从模型响应中提取到工作流 JSON'))
            return
          }

          try {
            resolve(JSON.parse(sanitizeControlCharacters(jsonText)) as Record<string, unknown>)
          } catch (err) {
            reject(new Error(err instanceof Error ? err.message : '工作流 JSON 解析失败'))
          }
        }
      )

      setTimeout(() => {
        abort()
        reject(new Error('生成工作流超时'))
      }, 30000)
    })
  }

  let workflow = await tryGenerate()
  let validation = validateWorkflowJson(workflow)
  if (!validation.valid) {
    workflow = await tryGenerate(validation.error)
    validation = validateWorkflowJson(workflow)
    if (!validation.valid) {
      throw new Error(`无法生成合法工作流：${validation.error}`)
    }
  }

  return workflow
}

function buildWorkflowFromInferredActions(
  instruction: string,
  actions: BrowserAction[]
): Record<string, unknown> {
  const steps: WorkflowStep[] = []
  let currentStepActions: BrowserAction[] = []
  let currentDescription = ''

  const flushStep = () => {
    if (currentStepActions.length === 0) return
    steps.push({
      step_id: `step-${steps.length + 1}`,
      description: currentDescription || `执行 ${currentStepActions.map((a) => a.action_type).join('、')}`,
      actions: currentStepActions,
      on_error: 'stop',
    })
    currentStepActions = []
    currentDescription = ''
  }

  for (const action of actions) {
    // navigate 通常作为新步骤起点
    if (action.action_type === 'navigate') {
      flushStep()
      currentStepActions.push(action)
      currentDescription = action.description || `导航到 ${action.value}`
      flushStep()
      continue
    }
    currentStepActions.push(action)
    if (!currentDescription) currentDescription = action.description || ''
  }
  flushStep()

  const hasInteractive = actions.some((a) => INTERACTIVE_ACTION_TYPES.has(a.action_type))

  return {
    name: '自动推断：' + instruction.slice(0, 30),
    description: instruction,
    workflow_type: 'custom' as WorkflowType,
    ...(hasInteractive ? {} : { security_policy: { security_level: 'read_only' } }),
    steps,
  }
}

export const webbridgeExecuteTool = createTool<WebBridgeExecuteInput, WebBridgeExecuteResult>({
  name: WEBBRIDGE_EXECUTE_TOOL_NAME,
  description:
    '通过自然语言执行简单的浏览器自动化任务（1-3 个动作）。' +
    '只适合简单场景，例如"打开 example.com 并截图"。' +
    '多步、需要精确控制或需要反复验证的任务，请使用 webbridge_navigate / screenshot / extract / locate / click / type / scroll / wait 等显式原语。',
  inputSchema: {
    type: 'object',
    required: ['instruction'],
    properties: {
      instruction: {
        type: 'string',
        description:
          '自然语言描述要执行的浏览器自动化任务，例如："打开 https://www.tianqi.com/qingdao/，截图并提取今日天气"。系统会自动转换为工作流并执行。',
      },
    },
  },
  category: 'web',
  usagePrompt: `用法示例：
1. 截图：{"instruction":"打开 https://example.com 并截图"}
2. 提取数据：{"instruction":"访问 https://example.com，提取文章正文"}

注意：多步任务请拆解为 webbridge_navigate / screenshot / extract / click / type 等原语。`,
  riskLevel: 'standard',
  isReadOnly: false,
  isConcurrencySafe: false,
  isDestructive: false,
  alwaysLoad: true,
  maxResultSizeChars: 100_000,
  validateInput: (input) => {
    const typed = input as WebBridgeExecuteInput
    if (typed.workflow && typeof typed.workflow === 'object') {
      return { valid: true }
    }
    if (typeof typed.instruction !== 'string' || typed.instruction.trim().length === 0) {
      return { valid: false, error: '必须提供 instruction' }
    }
    return { valid: true }
  },
  checkPermissions: (_input, context) => {
    if (context.mode === 'bypass' || context.canBypass) {
      return { allowed: true, behavior: 'allow' }
    }
    return {
      allowed: false,
      behavior: 'ask',
      reason: '该 WebBridge 任务可能包含点击、输入等交互操作，需要人工确认',
    }
  },
  async execute(input, ctx: ToolExecutionContext): Promise<WebBridgeExecuteResult> {
    if (!webBridgeClient.isConnected) {
      throw new Error('WebBridge daemon 未连接，无法执行浏览器自动化')
    }

    if (ctx.abortSignal?.aborted) {
      throw new Error('Request aborted')
    }

    let workflowJson: Record<string, unknown>

    const typedInput = input as WebBridgeExecuteInput

    if (typedInput.workflow && typeof typedInput.workflow === 'object') {
      workflowJson = typedInput.workflow
    } else {
      const instruction = typedInput.instruction.trim()

      // 优先用确定性规则推断简单动作序列
      const inferredActions = inferActionsFromText(instruction)
      if (inferredActions.length > 0 && !isComplexInstruction(instruction)) {
        workflowJson = buildWorkflowFromInferredActions(instruction, inferredActions)
      } else {
        ctx.onProgress?.({
          toolCallId: '',
          toolName: WEBBRIDGE_EXECUTE_TOOL_NAME,
          status: 'running',
          message: '正在将指令转换为 WebBridge 工作流...',
        })
        workflowJson = await generateWorkflowFromInstruction(instruction)
      }
    }

    const validation = validateWorkflowJson(workflowJson)
    if (!validation.valid) {
      throw new Error(validation.error)
    }

    ctx.onProgress?.({
      toolCallId: '',
      toolName: WEBBRIDGE_EXECUTE_TOOL_NAME,
      status: 'running',
      message: `正在执行工作流：${workflowJson.name || '未命名'}`,
    })

    const { workflow, results, summary } = await useWebBridgeStore
      .getState()
      .executeWorkflowFromJson(workflowJson, {
        maxRetries: 1,
        screenshotOnFailure: true,
        onStep: (state) => {
          ctx.onProgress?.({
            toolCallId: '',
            toolName: WEBBRIDGE_EXECUTE_TOOL_NAME,
            status: 'running',
            message: `步骤 ${state.stepIndex + 1}/${state.totalSteps}${state.lastAction ? `：${state.lastAction}` : ''}`,
          })
        },
      })

    const screenshotPaths: string[] = []
    const processedResults = []
    const safeName = sanitizeKey(String(workflow.name || 'webbridge'))
    const timestamp = nowTimestamp()

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const action = result.action
      const stepIndex = Math.min(i, (workflow.steps?.length || 1) - 1)

      let dataSummary = ''
      if (action.action_type === 'screenshot' && typeof result.data === 'string') {
        const path = `/workspace/scratch/web_cache/webbridge/${safeName}_screenshot_${i}_${timestamp}_${simpleHash(result.data.slice(0, 100))}.png`
        await writeFile(path, result.data, { encoding: 'base64' })
        screenshotPaths.push(path)
        dataSummary = `截图已保存到 ${path}`
      } else if (
        (action.action_type === 'extract_text' ||
          action.action_type === 'extract_html' ||
          action.action_type === 'extract_table') &&
        typeof result.data === 'string' &&
        result.data.length > 5000
      ) {
        const ext =
          action.action_type === 'extract_html' ? 'html' : action.action_type === 'extract_table' ? 'json' : 'txt'
        const path = `/workspace/scratch/web_cache/webbridge/${safeName}_${action.action_type}_${i}_${timestamp}.${ext}`
        await writeFile(path, result.data)
        dataSummary = `${action.action_type} 结果较大，已保存到 ${path}，可用 read_file 读取`
      } else {
        const dataText = typeof result.data === 'string' ? result.data : safeStringify(result.data, 1000)
        dataSummary = truncateText(dataText)
      }

      processedResults.push({
        step: stepIndex + 1,
        action: action.action_type,
        success: result.success,
        data_summary: dataSummary,
        ...(result.error_message ? { error: result.error_message } : {}),
      })
    }

    const successCount = results.filter((r) => r.success).length
    const success = results.length > 0 && results.every((r) => r.success)

    return {
      success,
      workflow_name: workflow.name,
      success_count: successCount,
      total_actions: results.length,
      summary,
      screenshot_paths: screenshotPaths,
      results: processedResults,
    }
  },
})

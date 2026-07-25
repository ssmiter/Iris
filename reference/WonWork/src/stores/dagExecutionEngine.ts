/**
 * DAG 工作流执行引擎
 * 与 Agent Swarm 解耦的通用 DAG 运行时
 */

import type { Message } from '@/types/mescli'
import type {
  DagNode,
  DagNodeType,
  DagWorkflow,
  DagExecutionContext,
  DagExecutionOptions,
  DagExecutionLog,
  NodeExecutor,
  NodePosition,
} from '@/types/dagWorkflow'
import { loadWebBridgePreset, type BrowserAction } from '@/types/webbridge'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { useChatStore } from '@/stores/chatStore'
import { useUsageStore, buildTodayUsageRecord } from '@/stores/usageStore'
import { executeSwarm } from '@/stores/agentSwarmEngine'
import { useAgentSwarmStore } from '@/stores/agentSwarmStore'
import { useSkillStore } from '@/stores/skillStore'
import { useMemoryStore } from '@/stores/memoryStore'
import type { SkillManifest } from '@/types/skill'
import { webBridgeClient } from '@/api/webbridgeClient'
import { attachmentApi, chatApi, fetchApi, IS_STANDALONE } from '@/api/client'
import type { FileAttachmentDto, FileAttachmentType } from '@/types/mescli'
import { buildWavesFromEdges, getUpstreamNodes } from '@/utils/dagTopology'
import { requestWebBridgeRetryWorkflow } from '@/utils/webbridgeRetry'
import { buildWebBridgeResultSummary } from '@/utils/webbridgePrompt'
import { truncateForInline } from '@/utils/safeSerialize'

export interface DagExecutionResumeContext {
  runId?: string
  inputs?: Record<string, unknown>
  variables?: Record<string, unknown>
  nodeOutputs?: Record<string, unknown>
  logs?: DagExecutionContext['logs']
  status?: DagExecutionContext['status']
  startTime?: number
  endTime?: number
  error?: string
  currentNodeIds?: string[]
}

export interface DagExecutionEngineOptions extends DagExecutionOptions {
  /** 恢复已有的执行上下文（断点续跑） */
  resumeContext?: DagExecutionResumeContext
  /** 已完成的节点 ID 集合 */
  completedNodeIds?: string[]
  /** 工作流显示名称，用于日志 */
  workflowName?: string
  /** 每个执行波次结束后触发，可在此持久化状态 */
  onCheckpoint?: (ctx: DagExecutionContext, completed: string[], pending: string[]) => void
  /** 返回 true 则当前波次结束后进入暂停状态 */
  checkPaused?: () => boolean | Promise<boolean>
  /** 子工作流查找回调 */
  getWorkflowById?: (id: string) => DagWorkflow | undefined
}

function generateId(prefix = 'run'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function dataUrlToBlob(dataUrl: string): Blob {
  const arr = dataUrl.split(',')
  const mime = arr[0].match(/:(.*?);/)?.[1] || 'application/octet-stream'
  const bstr = atob(arr[1] || '')
  let n = bstr.length
  const u8arr = new Uint8Array(n)
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n)
  }
  return new Blob([u8arr], { type: mime })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const dataUrl = reader.result as string
      const base64 = dataUrl.split(',')[1] || ''
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function dataUrlToBase64(dataUrl: string): string {
  return dataUrl.split(',')[1] || ''
}

function textToBase64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)))
}

function base64ToText(base64: string): string {
  return decodeURIComponent(escape(atob(base64)))
}

function toLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (Array.isArray(value)) {
    return `[${value.map(toLiteral).join(', ')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${JSON.stringify(k)}: ${toLiteral(v)}`
    )
    return `{${entries.join(', ')}}`
  }
  return JSON.stringify(value)
}

function convertJsonLiteralsToPython(code: string): string {
  let result = ''
  let i = 0
  let quote: string | null = null

  while (i < code.length) {
    const ch = code[i]

    if (quote === null) {
      // 进入字符串字面量（包含三引号）
      if (ch === '"' || ch === "'") {
        if (ch === code[i + 1] && ch === code[i + 2]) {
          quote = ch + ch + ch
          result += quote
          i += 3
          continue
        }
        quote = ch
        result += ch
        i++
        continue
      }

      // 注释：原样保留到行尾
      if (ch === '#') {
        const end = code.indexOf('\n', i)
        if (end === -1) {
          result += code.slice(i)
          break
        }
        result += code.slice(i, end)
        i = end
        continue
      }

      // 标识符/关键字：检查是否为 JSON 字面量
      if (/[a-zA-Z_]/.test(ch)) {
        const start = i
        while (i < code.length && /[a-zA-Z0-9_]/.test(code[i])) {
          i++
        }
        const token = code.slice(start, i)
        if (token === 'true') {
          result += 'True'
        } else if (token === 'false') {
          result += 'False'
        } else if (token === 'null') {
          result += 'None'
        } else {
          result += token
        }
        continue
      }

      result += ch
      i++
      continue
    }

    // 在字符串字面量内部
    if (quote!.length === 3) {
      if (ch === quote![0] && code[i + 1] === quote![0] && code[i + 2] === quote![0]) {
        result += quote
        i += 3
        quote = null
        continue
      }
    } else {
      if (ch === '\\' && i + 1 < code.length) {
        result += ch
        result += code[i + 1]
        i += 2
        continue
      }
      if (ch === quote) {
        result += ch
        i++
        quote = null
        continue
      }
    }

    result += ch
    i++
  }

  return result
}

/**
 * 转义 Python 字符串字面量内部的实际控制字符（CR/LF）。
 *
 * 背景：LLM 常在 python_code 中嵌入 JSON 字符串字面量，例如
 *   result = json.loads('{"data":"...\\r\\n..."}')
 * 当这段代码作为 tool args 的 JSON 字符串值被 JSON.parse 后，\\r\\n 会被解码成真正的 CR/LF 字节；
 * 随后 Python 执行该代码时，单引号字符串内部出现真正的换行，导致 json.loads 报
 * "Invalid control character"。
 *
 * 该函数在保持字符串值语义不变的前提下，把字符串字面量内部真正的 CR/LF 重新写成
 * Python 转义序列 \\r / \\n，使下游 json.loads 收到合法的 JSON 字符串。
 */
export function escapeControlCharsInPythonStringLiterals(code: string): string {
  const MAX_CODE_LENGTH = 1_000_000
  if (code.length > MAX_CODE_LENGTH) {
    throw new Error(
      `python_code 长度超过 ${MAX_CODE_LENGTH} 字符（当前 ${code.length}），请使用 \${steps.<节点ID>} 占位符引用上游数据，不要内联全部数据。`
    )
  }

  // 没有真实控制字符时直接返回，避免对超大代码逐字符扫描
  if (!/[\r\n]/.test(code)) return code

  let result = ''
  let i = 0
  let quote: string | null = null
  let triple = false

  while (i < code.length) {
    const ch = code[i]

    if (quote === null) {
      if (ch === '"' || ch === "'") {
        if (ch === code[i + 1] && ch === code[i + 2]) {
          triple = true
          quote = ch
          result += ch + ch + ch
          i += 3
          continue
        }
        triple = false
        quote = ch
        result += ch
        i++
        continue
      }
      result += ch
      i++
      continue
    }

    // 在字符串字面量内部
    if (!triple && ch === '\\' && i + 1 < code.length) {
      // 保留已有的转义序列，避免重复转义
      result += ch
      i++
      result += code[i]
      i++
      continue
    }

    if (triple) {
      if (ch === quote && code[i + 1] === quote && code[i + 2] === quote) {
        quote = null
        result += ch + ch + ch
        i += 3
        continue
      }
    } else {
      if (ch === quote) {
        quote = null
        result += ch
        i++
        continue
      }
    }

    if (ch === '\r') {
      result += '\\r'
      i++
    } else if (ch === '\n') {
      result += '\\n'
      i++
    } else {
      result += ch
      i++
    }
  }

  return result
}

/**
 * 为 python_code 中的 json.loads 调用增加安全包装。
 *
 * 背景：LLM 常在 python_code 里写
 *   data = json.loads('{"success":true,"data":"...\\r\\n..."}')
 * 当 tool args 经过 JSON.parse 后，\\r\\n 被解码成真实 CR/LF；Python 执行该代码时
 * 单引号字符串内部出现真实换行，json.loads 报 Invalid control character。
 *
 * 该函数在 python_code 顶部注入 _safe_json_loads，它会把字符串中的真实控制字符
 * 先替换成 JSON 转义序列，再交给 json.loads，从而兼容 LLM 生成的含换行文本。
 * 同时保留原有的 escapeControlCharsInPythonStringLiterals 作为第一道防线。
 */
function makePythonJsonLoadsSafe(code: string): string {
  if (!code.includes('json.loads(')) return code
  const helper = `import json\n_safe_json_loads = lambda s: json.loads(s.replace('\\r\\n', '\\\\r\\\\n').replace('\\n', '\\\\n').replace('\\r', '\\\\r'))\n`
  // 避免重复注入
  if (code.includes('_safe_json_loads')) return code
  const body = code.replace(/\bjson\.loads\s*\(/g, '_safe_json_loads(')
  return helper + body
}

function resolveWorkspaceRelativePath(inputPath: string, defaultSubdir = 'downloads'): string {
  const normalized = inputPath.replace(/\\/g, '/').replace(/^[/]+/, '')
  if (!normalized) return `${defaultSubdir}/file.txt`
  const firstSegment = normalized.split('/')[0]
  const allowedSubdirs = ['downloads', 'snapshots', 'exports', 'recordings']
  if (allowedSubdirs.includes(firstSegment)) return normalized
  return `${defaultSubdir}/${normalized}`
}

function ensureWebBridgeDaemon(): void {
  if (!webBridgeClient.isConnected && !webBridgeClient.isMock) {
    throw new Error('文件操作需要 WebBridge Daemon 已连接。请先启动 WonWork 或 WebBridge Daemon。')
  }
}

function getFileAttachmentType(mimeType: string): FileAttachmentType {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('text/')) return 'text'
  if (mimeType === 'application/pdf' || mimeType.includes('document') || mimeType.includes('word')) return 'document'
  return 'unknown'
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function parseJsonTemplate(text: string, ctx: DagExecutionContext): Record<string, unknown> {
  const interpolated = interpolateTemplate(text || '{}', ctx)
  try {
    return JSON.parse(interpolated)
  } catch {
    throw new Error('JSON 格式不正确')
  }
}

function interpolateJsonValue(value: unknown, ctx: DagExecutionContext, strict: boolean): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    const singleExprMatch = trimmed.match(/^\$\{([^}]+)\}$/)
    if (singleExprMatch) {
      const expr = singleExprMatch[1].trim()
      try {
        const result = evaluateExpression(expr, ctx)
        if (result === undefined || result === null) {
          if (strict) {
            throw new Error(`变量 \${${expr}} 未提供值，无法生成有效 JSON 参数。请确认工作流输入或上游步骤输出已正确设置。`)
          }
          return null
        }
        return result
      } catch (err) {
        if (strict) throw err
        return null
      }
    }

    const MAX_INLINE_JSON_LENGTH = 200_000

    return value.replace(/\$\{([^}]+)\}/g, (_, rawExpr) => {
      const expr = rawExpr.trim()
      try {
        const result = evaluateExpression(expr, ctx)
        if (result === undefined || result === null) {
          if (strict) {
            throw new Error(`变量 \${${expr}} 未提供值，无法生成有效 JSON 参数。请确认工作流输入或上游步骤输出已正确设置。`)
          }
          return ''
        }
        if (typeof result === 'string') return result
        if (typeof result === 'number' || typeof result === 'boolean') return String(result)
        let text = JSON.stringify(result)
        if (text.length > MAX_INLINE_JSON_LENGTH) {
          console.warn(`[dagExecutionEngine] 变量 \${${expr}} 的内联 JSON 过大（${text.length}），已自动截断数组/字符串以避免阻塞前端。`)
          text = JSON.stringify(truncateForInline(result))
        }
        return text
      } catch (err) {
        if (strict) throw err
        return ''
      }
    })
  }

  if (Array.isArray(value)) {
    return value.map((v) => interpolateJsonValue(v, ctx, strict))
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = interpolateJsonValue(v, ctx, strict)
    }
    return result
  }

  return value
}

function interpolateJsonTemplate(json: unknown, ctx: DagExecutionContext, strict = true): unknown {
  return interpolateJsonValue(json, ctx, strict)
}

function toNodeOutputsObject(map: Map<string, unknown>): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  map.forEach((value, key) => {
    obj[key] = value
  })
  return obj
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Date) return `'${value.toISOString().slice(0, 19).replace('T', ' ')}'`
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  // array/object 在 SQL 中通常不应作为字面量出现，转成 JSON 字符串字面量
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`
}

export function interpolateTemplate(template: string, ctx: DagExecutionContext, options?: { strict?: boolean; sql?: boolean }): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, rawExpr) => {
    const expr = rawExpr.trim()
    try {
      const result = evaluateExpression(expr, ctx)
      if (result === undefined || result === null) {
        if (options?.strict) {
          throw new Error(`变量 \${${expr}} 未提供值，无法生成有效 SQL/参数。请确认工作流输入或上游步骤输出已正确设置。`)
        }
        return options?.sql ? 'NULL' : ''
      }
      if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
        return options?.sql ? sqlLiteral(result) : String(result)
      }
      return options?.sql ? sqlLiteral(result) : toLiteral(result)
    } catch (err) {
      if (options?.strict) throw err
      return options?.sql ? 'NULL' : ''
    }
  })
}

function getPathValue(root: unknown, path: string[]): unknown {
  let value: unknown = root
  for (const key of path) {
    if (value && typeof value === 'object') {
      value = (value as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return value
}

export function evaluateExpression(expression: string, ctx: DagExecutionContext): unknown {
  const trimmed = expression.trim()
  const nodeOutputs = toNodeOutputsObject(ctx.nodeOutputs)

  // outputMapping 通常直接填写 step/node id（如 step-2），这类 id 含连字符不是合法 JS 标识符，
  // 若直接 eval 会被解析成减法。优先按 nodeOutputs 的 key 直接查找。
  if (trimmed in nodeOutputs) {
    return nodeOutputs[trimmed]
  }

  // 支持 inputs.xxx、variables.xxx、steps.<id>.<field>（id 可含连字符）
  const stepsMatch = trimmed.match(/^steps\.(.*)$/)
  if (stepsMatch) {
    const rest = stepsMatch[1]
    const ids = Object.keys(nodeOutputs).sort((a, b) => b.length - a.length)
    for (const id of ids) {
      if (rest === id) {
        return nodeOutputs[id]
      }
      if (rest.startsWith(`${id}.`)) {
        const path = rest.slice(id.length + 1).split('.')
        return getPathValue(nodeOutputs[id], path)
      }
    }
    return undefined
  }

  const inputsMatch = trimmed.match(/^inputs(?:\.(.*))?$/)
  if (inputsMatch) {
    if (!inputsMatch[1]) return ctx.inputs
    return getPathValue(ctx.inputs, inputsMatch[1].split('.'))
  }

  const variablesMatch = trimmed.match(/^variables(?:\.(.*))?$/)
  if (variablesMatch) {
    if (!variablesMatch[1]) return ctx.variables
    return getPathValue(ctx.variables, variablesMatch[1].split('.'))
  }

  // 回退到 JS 表达式求值
  const fn = new Function('variables', 'nodeOutputs', 'inputs', `return (${trimmed})`)
  return fn(ctx.variables, nodeOutputs, ctx.inputs)
}

function createExecutionContext(workflow: DagWorkflow, inputs: Record<string, unknown>): DagExecutionContext {
  return {
    workflowId: workflow.id,
    runId: generateId(),
    inputs,
    variables: {},
    nodeOutputs: new Map(),
    logs: [],
    status: 'running',
    currentNodeIds: [],
    startTime: Date.now(),
  }
}

function createLogEntry(entry: Omit<DagExecutionLog, 'timestamp'>): DagExecutionLog {
  return { ...entry, timestamp: Date.now() }
}

export const executors: Record<DagNodeType, NodeExecutor> = {
  start: async (_node, ctx) => {
    return ctx.inputs
  },

  end: async (_node, ctx) => {
    return toNodeOutputsObject(ctx.nodeOutputs)
  },

  llm: async (node, ctx, options) => {
    const cfg = node.data.llm || {}
    const prompt = interpolateTemplate(cfg.prompt || '', ctx)
    if (!prompt.trim()) {
      return { content: '' }
    }

    const provider = useChatStore.getState().activeProvider
    if (!provider) {
      throw new Error('未选择 LLM 提供商，请在聊天界面选择模型后再执行 DAG')
    }

    const messages: Message[] = []
    if (cfg.systemPrompt) {
      messages.push({ role: 'system', content: cfg.systemPrompt })
    }
    messages.push({ role: 'user', content: prompt })

    let content = ''
    await new Promise<void>((resolve, reject) => {
      const abort = chatApi.streamChat(
        {
          provider: provider.provider,
          model: cfg.model || provider.model,
          baseUrl: provider.baseUrl,
          messages,
          saveToHistory: false,
        },
        (chunk) => {
          if (options.abortSignal.aborted) return
          if (chunk.type === 'content' && chunk.content) {
            content += chunk.content
          }
        },
        (error) => {
          if (options.abortSignal.aborted) return
          reject(error)
        },
        () => {
          if (options.abortSignal.aborted) return
          resolve()
        }
      )

      options.abortSignal.addEventListener(
        'abort',
        () => {
          abort()
          reject(new Error('已取消'))
        },
        { once: true }
      )
    })

    return { content, prompt }
  },

  webbridge: async (node, ctx, options) => {
    const cfg = node.data.webbridge || {}
    const maxRetries = Math.min(node.data.maxRetries || 0, 3)
    const screenshotOnFailure = cfg.screenshotOnFailure ?? true
    const retryDelayMs = Math.max(0, Number(cfg.retryDelayMs) || 0)

    const runActions = async (actions: BrowserAction[]): Promise<unknown> => {
      if (IS_STANDALONE) {
        const store = useWebBridgeStore.getState()
        let policyOverride = undefined
        if (cfg.securityPreset) {
          const preset = loadWebBridgePreset(cfg.securityPreset)
          policyOverride = preset.security_policy
        }
        const results = await store.runActionsOnce(actions, policyOverride)
        const summary = buildWebBridgeResultSummary('WebBridge DAG Node', results)
        return { results, summary }
      }

      // MESCLI 模式：走后端能力网关
      const response = await fetchApi<{ success: boolean; data?: unknown; error?: string }>('/api/dag/node/webbridge/actions', {
        method: 'POST',
        body: JSON.stringify({ actions }),
      })
      if (!response.success) {
        throw new Error(response.error || 'WebBridge 动作执行失败')
      }
      return response.data
    }

    const executeOnce = async (actions: BrowserAction[]): Promise<unknown> => {
      if (cfg.workflowId) {
        if (IS_STANDALONE) {
          await useWebBridgeStore.getState().runWorkflow(cfg.workflowId)
          return { executedWorkflowId: cfg.workflowId }
        }
        const response = await fetchApi<{ success: boolean; data?: unknown; error?: string }>('/api/dag/node/workflow/start', {
          method: 'POST',
          body: JSON.stringify({ workflowCode: cfg.workflowId, inputs: {} }),
        })
        if (!response.success) {
          throw new Error(response.error || '工作流启动失败')
        }
        return response.data
      }

      if (!actions || actions.length === 0) {
        return null
      }

      return runActions(actions)
    }

    let currentActions = cfg.actions || []
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await executeOnce(currentActions)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        options.onLog({
          nodeId: node.id,
          level: 'warn',
          message: `WebBridge 节点 ${node.data.label || node.id} 执行失败（尝试 ${attempt + 1}/${maxRetries + 1}）：${lastError.message}`,
        })

        if (attempt === maxRetries) break

        let screenshot: string | undefined
        let pageContext: { url: string; title: string; text?: string } | undefined
        try {
          if (screenshotOnFailure) {
            screenshot = await useWebBridgeStore.getState().captureScreenshot()
            ctx.nodeOutputs.set(`${node.id}__screenshot`, screenshot)
          }
          pageContext = await useWebBridgeStore.getState().capturePageContext()
        } catch (captureErr) {
          options.onLog({
            nodeId: node.id,
            level: 'warn',
            message: `捕获失败状态截图/页面上下文失败：${captureErr instanceof Error ? captureErr.message : String(captureErr)}`,
          })
        }

        try {
          const corrected = await requestWebBridgeRetryWorkflow({
            error: lastError.message,
            url: pageContext?.url || '',
            title: pageContext?.title || '',
            text: pageContext?.text,
            screenshot,
          })
          if (corrected.actions.length > 0) {
            currentActions = corrected.actions
            options.onLog({
              nodeId: node.id,
              level: 'info',
              message: `LLM 已生成修正后的 WebBridge 动作，准备重试`,
            })
          }
        } catch (retryErr) {
          options.onLog({
            nodeId: node.id,
            level: 'warn',
            message: `请求 LLM 修正失败：${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          })
        }

        if (retryDelayMs > 0) {
          await sleep(retryDelayMs)
        }
      }
    }

    throw lastError
  },

  javascript: async (node, ctx) => {
    const code = node.data.javascript?.code || ''
    if (!code.trim()) return null
    const fn = new Function('variables', 'nodeOutputs', 'inputs', code)
    return fn(ctx.variables, toNodeOutputsObject(ctx.nodeOutputs), ctx.inputs)
  },

  condition: async (node, ctx) => {
    const expr = node.data.condition?.conditionExpression || ''
    if (!expr.trim()) return true
    return Boolean(evaluateExpression(expr, ctx))
  },

  loop: async (_node, _ctx) => {
    // 循环的实际执行在 executeDagWorkflow 主循环中处理
    return { handled: true }
  },

  delay: async (node) => {
    const ms = node.data.delay?.delayMs || 0
    await sleep(Math.max(0, ms))
    return { delayedMs: ms }
  },

  variable: async (node, ctx) => {
    const cfg = node.data.variable || {}
    if (cfg.variableName) {
      const value = interpolateTemplate(cfg.variableValue || '', ctx)
      ctx.variables[cfg.variableName] = value
    }
    return ctx.variables
  },

  merge: async (node, ctx, options) => {
    // merge 节点等待所有上游完成，合并输出
    const incoming = options.workflow.edges.filter(
      (e) => e.target === node.id && options.activeEdges.has(e.id)
    )
    const merged: Record<string, unknown> = {}
    for (const edge of incoming) {
      merged[edge.source] = ctx.nodeOutputs.get(edge.source)
    }
    return merged
  },

  agent_swarm: async (node, ctx, options) => {
    const cfg = node.data.agentSwarm || {}
    const taskDescription = interpolateTemplate(cfg.taskDescription || '', ctx)
    if (!taskDescription.trim()) {
      throw new Error('Agent Swarm 任务描述不能为空')
    }

    const provider = useChatStore.getState().activeProvider
    if (!provider) {
      throw new Error('未选择 LLM 提供商，请在聊天界面选择模型后再执行 Agent Swarm 节点')
    }

    const swarmStore = useAgentSwarmStore.getState()
    const activeAgents = swarmStore.agents.filter((a) => a.isActive)
    if (activeAgents.length === 0) {
      throw new Error('没有激活的 Agent，请先在 Agent Swarm 面板中激活至少一个 Agent')
    }

    const controller = new AbortController()
    const abortHandler = () => controller.abort()
    options.abortSignal.addEventListener('abort', abortHandler, { once: true })

    const nodeLogs: Array<{ agentId: string; content: string; type: string }> = []

    try {
      const result = await executeSwarm(
        swarmStore.swarmConfig,
        activeAgents,
        taskDescription,
        controller.signal,
        {
          addMessage: (msg) => {
            nodeLogs.push({ agentId: msg.agentId, content: msg.content, type: msg.type })
            options.onLog({
              nodeId: node.id,
              level: 'info',
              message: `[${msg.agentName || msg.agentId}] ${msg.type}: ${msg.content.slice(0, 200)}`,
            })
          },
          addTask: (task) => {
            const taskId = `${node.id}-task-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
            options.onLog({
              nodeId: node.id,
              level: 'info',
              message: `Task created: ${task.title} (${task.status})`,
            })
            return taskId
          },
          updateTask: (id, updates) => {
            options.onLog({
              nodeId: node.id,
              level: 'info',
              message: `Task ${id} updated: ${JSON.stringify(updates)}`,
            })
          },
          getProvider: () => provider,
          getSkillPrompts: (task) => {
            try {
              const skillStore = useSkillStore.getState()
              const activeSkills = skillStore.getActiveSkillsForMessage(task)
              const manualSkills = skillStore.activeSkillIds
                .map((id) => skillStore.skills.find((s) => s.id === id))
                .filter(Boolean) as SkillManifest[]
              const merged = [...new Map([...activeSkills, ...manualSkills].map((s) => [s.id, s])).values()]
              return merged.map((s) => `## [Skill: ${s.name}]\n${s.prompt}`)
            } catch {
              return []
            }
          },
          getMemories: (task) => {
            try {
              return useMemoryStore.getState().searchMemories(task, 3).map((m) => m.content)
            } catch {
              return []
            }
          },
        }
      )

      return {
        success: result.status === 'completed',
        status: result.status,
        finalOutput: result.finalOutput,
        taskId: result.taskId,
        totalSteps: result.totalSteps,
        totalExecutionTimeMs: result.totalExecutionTimeMs,
        parallelismDegree: result.parallelismDegree,
        criticalSteps: result.criticalSteps,
        crossVerificationPassed: result.crossVerificationPassed,
        verificationIssues: result.verificationIssues,
        subResults: result.subResults?.map((r) => ({
          agentName: r.agentName,
          agentRole: r.agentRole,
          status: r.status,
          output: r.output,
        })),
        logs: nodeLogs,
      }
    } finally {
      options.abortSignal.removeEventListener('abort', abortHandler)
    }
  },

  http_request: async (node, ctx) => {
    const cfg = node.data.httpRequest || {}
    const url = interpolateTemplate(cfg.url || '', ctx)
    const method = cfg.method || 'GET'
    if (!url.trim()) {
      throw new Error('HTTP 请求 URL 不能为空')
    }

    const headers = parseJsonTemplate(cfg.headers || '{}', ctx)
    const body = interpolateTemplate(cfg.body || '', ctx)
    const timeout = Math.max(1000, cfg.timeout || 30000)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(url, {
        method,
        headers: headers as Record<string, string>,
        body: ['GET', 'HEAD'].includes(method) ? undefined : body,
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      const responseText = await response.text()
      let responseBody: unknown = responseText
      try {
        responseBody = JSON.parse(responseText)
      } catch {
        // 保持文本原样
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      }
    } catch (err) {
      clearTimeout(timeoutId)
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`HTTP 请求超时（${timeout}ms）`)
      }
      throw err
    }
  },

  database_query: async (node, ctx) => {
    const cfg = node.data.databaseQuery || {}
    const query = interpolateTemplate(cfg.query || '', ctx, { strict: true, sql: true })
    if (!query.trim()) {
      throw new Error('数据库查询语句不能为空')
    }

    const parameters = parseJsonTemplate(cfg.parameters || '{}', ctx)

    return fetchApi<unknown[]>('/api/database/query', {
      method: 'POST',
      body: JSON.stringify({
        connection: cfg.connection || undefined,
        query,
        parameters,
      }),
    })
  },

  file_operation: async (node, ctx) => {
    const cfg = node.data.fileOperation || {}
    const action = cfg.action || 'read'
    const path = interpolateTemplate(cfg.path || '', ctx)

    ensureWebBridgeDaemon()

    switch (action) {
      case 'write': {
        const content = interpolateTemplate(cfg.content || '', ctx)
        const relativePath = resolveWorkspaceRelativePath(path, 'downloads')
        const base64 = textToBase64(content)
        const result = await webBridgeClient.writeWorkspaceFile(relativePath, base64)
        return { success: true, action, path: result.relativePath, size: result.size }
      }
      case 'download': {
        const content = interpolateTemplate(cfg.dataUrl || '', ctx)
        if (!content) {
          throw new Error('下载操作需要提供 Data URL')
        }
        const relativePath = resolveWorkspaceRelativePath(path, 'downloads')
        const base64 = content.startsWith('data:') ? dataUrlToBase64(content) : textToBase64(content)
        const result = await webBridgeClient.writeWorkspaceFile(relativePath, base64)
        return { success: true, action, path: result.relativePath, size: result.size }
      }
      case 'read': {
        if (!path) {
          throw new Error('读取操作需要指定工作区文件路径')
        }
        const relativePath = resolveWorkspaceRelativePath(path, 'downloads')
        const result = await webBridgeClient.readWorkspaceFile(relativePath)
        const text = base64ToText(result.base64)
        return { success: true, action, path: result.relativePath, content: text, size: text.length }
      }
      case 'upload': {
        let base64: string
        let fileName: string
        const content = interpolateTemplate(cfg.content || '', ctx)
        if (content.startsWith('data:')) {
          base64 = dataUrlToBase64(content)
          fileName = path || 'upload'
        } else {
          if (!path) {
            throw new Error('上传操作需要指定工作区文件路径，或提供 Data URL 内容')
          }
          const relativePath = resolveWorkspaceRelativePath(path, 'downloads')
          const result = await webBridgeClient.readWorkspaceFile(relativePath)
          base64 = result.base64
          fileName = path.split('/').pop() || 'upload'
        }

        const byteString = atob(base64)
        const mimeType = content.startsWith('data:')
          ? content.split(',')[0].match(/:(.*?);/)?.[1] || 'application/octet-stream'
          : 'application/octet-stream'
        const array = new Uint8Array(byteString.length)
        for (let i = 0; i < byteString.length; i++) {
          array[i] = byteString.charCodeAt(i)
        }
        const blob = new Blob([array], { type: mimeType })
        const dataUrl = content.startsWith('data:') ? content : `data:${mimeType};base64,${base64}`
        const attachment: FileAttachmentDto = {
          id: generateAttachmentId(),
          name: fileName,
          type: getFileAttachmentType(mimeType),
          mimeType,
          size: blob.size,
          data: dataUrl,
          createdAt: new Date().toISOString(),
        }

        // DAG 运行没有对话上下文，使用 0 作为系统附件桶
        await attachmentApi.upload(0, attachment)

        return {
          success: true,
          action,
          id: attachment.id,
          name: attachment.name,
          path: attachment.name,
          size: attachment.size,
          mimeType: attachment.mimeType,
          type: attachment.type,
        }
      }
      default:
        throw new Error(`未知的文件操作类型: ${action}`)
    }
  },

  send_message: async (node, ctx, options) => {
    const cfg = node.data.sendMessage || {}
    const channel = cfg.channel || 'log'
    const title = interpolateTemplate(cfg.title || '', ctx)
    const content = interpolateTemplate(cfg.content || '', ctx)

    if (channel === 'notification') {
      if (typeof window === 'undefined' || !('Notification' in window)) {
        throw new Error('当前环境不支持系统通知')
      }
      if (Notification.permission !== 'granted') {
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') {
          throw new Error('用户未授权系统通知权限')
        }
      }
      new Notification(title || 'WonWork', { body: content })
    }

    options.onLog({
      nodeId: node.id,
      level: 'info',
      message: `[${channel}] ${title ? title + ': ' : ''}${content}`,
    })

    return { delivered: true, channel, title, content }
  },

  tool: async (node, ctx, options) => {
    const cfg = node.data.tool || {}
    const toolName = cfg.toolName || ''
    if (!toolName.trim()) {
      throw new Error('Tool 名称不能为空')
    }

    if (IS_STANDALONE) {
      throw new Error('当前模式不支持 Tool 调用，请在 MESCLI 模式下使用')
    }

    const rawArgsText = cfg.args || '{}'
    let parsedArgs: Record<string, unknown>
    try {
      parsedArgs = JSON.parse(rawArgsText) as Record<string, unknown>
    } catch {
      throw new Error('Tool 参数 JSON 格式不正确')
    }

    // 文档生成节点必须引用上游数据，禁止把大量数据直接内联到 python_code 中
    if (toolName.startsWith('create_') && typeof parsedArgs.python_code === 'string') {
      const code = parsedArgs.python_code as string
      const MAX_DOC_PYTHON_CODE_LENGTH = 50_000
      if (code.length > MAX_DOC_PYTHON_CODE_LENGTH) {
        throw new Error(
          `文档生成节点的 python_code 过长（${code.length} 字符），请使用 \${steps.<节点ID>} 占位符引用上游数据，不要内联全部数据。`
        )
      }
      if (!code.includes('\${steps.') && !code.includes('\${inputs.')) {
        throw new Error(
          `文档生成节点的 python_code 未引用任何上游数据（没有 \${steps.<节点ID>} 或 \${inputs.xxx}）。` +
            `请在代码中通过 \${steps.<上游节点ID>} 读取数据后再生成图表/表格/段落，否则文档会为空。`
        )
      }
    }

    // 对 SQL 类参数使用 SQL 字面量语义进行变量替换，避免日期/字符串被当成算术表达式
    for (const key of Object.keys(parsedArgs)) {
      if ((key === 'sql' || key === 'query') && typeof parsedArgs[key] === 'string') {
        parsedArgs[key] = interpolateTemplate(parsedArgs[key] as string, ctx, { strict: true, sql: true })
      }
    }

    let args: Record<string, unknown>
    try {
      args = interpolateJsonTemplate(parsedArgs, ctx, true) as Record<string, unknown>
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Tool 参数变量替换失败'
      throw new Error(msg)
    }

    // 为文档生成类节点输出诊断信息，便于排查生成内容为空的问题
    if (toolName.startsWith('create_') && typeof args.python_code === 'string') {
      const upstreamIds = options?.workflow?.edges.filter((e) => e.target === node.id).map((e) => e.source) || []
      const upstreamSummary = upstreamIds
        .map((id) => {
          const value = ctx.nodeOutputs.get(id)
          const summary = Array.isArray(value)
            ? `数组[${value.length}]`
            : value && typeof value === 'object'
              ? `对象{${Object.keys(value as Record<string, unknown>).join(', ')}}`
              : String(value).slice(0, 100)
          return `${id}: ${summary}`
        })
        .join('; ')
      options?.onLog?.({
        nodeId: node.id,
        level: 'info',
        message: `[${toolName}] 上游输出摘要：${upstreamSummary || '无上游节点'}`,
      })
    }

    // 自动补全 create_excel_document 等依赖 os 的 python_code
    if (toolName === 'create_excel_document' || (typeof args.python_code === 'string' && args.python_code.includes("os.environ['OUTPUT_PATH']"))) {
      const code = args.python_code as string
      if (typeof code === 'string' && !code.includes('import os')) {
        args.python_code = `import os\n${code}`
      }
    }

    const MAX_PYTHON_CODE_LENGTH = 100_000
    if (typeof args.python_code === 'string' && args.python_code.length > MAX_PYTHON_CODE_LENGTH) {
      throw new Error(
        `python_code 过长（${args.python_code.length} 字符），请将数据引用改为使用 \${steps.<节点ID>} 占位符，不要内联全部上游数据。`
      )
    }

    // 修复 python_code 中嵌套 JSON 字符串字面量因 JSON.parse 解码导致的控制字符问题，
    // 并把 JSON 风格的 true/false/null 转换为 Python 的 True/False/None（字符串内部除外）。
    if (typeof args.python_code === 'string') {
      const code = args.python_code
      args.python_code = makePythonJsonLoadsSafe(
        convertJsonLiteralsToPython(escapeControlCharsInPythonStringLiterals(code))
      )
    }

    // 输出实际发往执行引擎的 python_code 片段，便于排查空内容/数据未引用问题
    if (toolName.startsWith('create_') && typeof args.python_code === 'string') {
      const preview = args.python_code.length > 500 ? args.python_code.slice(0, 500) + '...' : args.python_code
      options?.onLog?.({
        nodeId: node.id,
        level: 'info',
        message: `[${toolName}] 实际执行 python_code（前 500 字符）：\n${preview}`,
      })
    }

    const toolTimeoutMs = Math.max(5000, Number(args.timeout) || 120000)

    try {
      // 使用统一 ToolExecutor 调用后端 DAG 工具端点
      const { createToolExecutor } = await import('@/agent/toolExecutor')
      const { createToolRegistry } = await import('@/agent/toolRegistry')
      const toolRegistry = createToolRegistry()
      const toolExecutor = createToolExecutor(toolRegistry)

      const result = await toolExecutor.execute({
        contextType: 'dag',
        toolName,
        args,
        toolCallId: node.id,
        traceId: `dag-${node.id}-${Date.now()}`,
        timeoutMs: toolTimeoutMs,
        onProgress: (update) => {
          if (update.message) {
            options?.onLog?.({
              nodeId: node.id,
              level: update.status === 'error' ? 'error' : 'info',
              message: `[${toolName}] ${update.message}`,
            })
          }
        },
      })

      if (!result.success) {
        throw new Error(result.error || 'Tool 执行失败')
      }

      if (toolName.startsWith('create_')) {
        const resultSummary = result.output ? JSON.stringify(result.output).slice(0, 300) : '空'
        options?.onLog?.({
          nodeId: node.id,
          level: 'info',
          message: `[${toolName}] 执行结果摘要：${resultSummary}`,
        })
      }

      return result.output
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Tool 执行超时（${toolTimeoutMs}ms），请检查后端是否响应或数据量是否过大`)
      }
      throw err
    }
  },

  sub_workflow: async (node, ctx, options) => {
    const cfg = node.data.subWorkflow || {}
    const workflowId = cfg.workflowId || ''
    if (!workflowId.trim()) {
      throw new Error('Sub Workflow 节点必须指定 workflowId')
    }

    const getWorkflow = options.getWorkflowById
    if (!getWorkflow) {
      throw new Error('当前执行环境未提供子工作流查找能力')
    }

    const subWorkflow = getWorkflow(workflowId)
    if (!subWorkflow) {
      throw new Error(`未找到子工作流：${workflowId}`)
    }

    if (subWorkflow.id === ctx.workflowId) {
      throw new Error('子工作流不能引用自身')
    }

    const inputsText = interpolateTemplate(cfg.inputs || '{}', ctx)
    let inputs: Record<string, unknown>
    try {
      inputs = JSON.parse(inputsText)
    } catch {
      throw new Error('Sub Workflow 的 inputs 不是有效 JSON')
    }

    options.onLog({
      nodeId: node.id,
      level: 'info',
      message: `开始执行子工作流「${subWorkflow.name}」(${workflowId})`,
    })

    const subCtx = await executeDagWorkflow(subWorkflow, inputs, {
      abortSignal: options.abortSignal,
      onLog: (log) =>
        options.onLog({
          nodeId: `${node.id}:${log.nodeId}`,
          level: log.level,
          message: `[子工作流 ${subWorkflow.name}] ${log.message}`,
        }),
      getWorkflowById: getWorkflow,
    })

    if (subCtx.status === 'failed' || subCtx.status === 'cancelled') {
      throw new Error(`子工作流「${subWorkflow.name}」执行失败：${subCtx.error || subCtx.status}`)
    }

    return {
      workflowId,
      workflowName: subWorkflow.name,
      outputs: toNodeOutputsObject(subCtx.nodeOutputs),
    }
  },
}

function getNodeErrorStrategy(node: DagNode): { mode: 'stop' | 'skip' | 'retry'; retries: number } {
  const mode = node.data.onError || 'stop'
  const retries = Math.min(Math.max(0, node.data.maxRetries || 0), 3)
  return { mode, retries }
}

export async function executeDagWorkflow(
  workflow: DagWorkflow,
  inputs: Record<string, unknown> = {},
  options: DagExecutionEngineOptions = {}
): Promise<DagExecutionContext> {
  const {
    abortSignal = new AbortController().signal,
    onNodeStart,
    onNodeComplete,
    onNodeError,
    onLog,
    onCheckpoint,
    checkPaused,
    resumeContext,
    completedNodeIds: initialCompletedNodeIds,
    workflowName,
    getWorkflowById,
    executors: customExecutors,
  } = options

  const nodeExecutors = { ...executors, ...customExecutors }

  const ctx: DagExecutionContext = resumeContext
    ? {
        workflowId: workflow.id,
        runId: resumeContext.runId || generateId(),
        inputs: resumeContext.inputs ?? inputs,
        variables: resumeContext.variables ? { ...resumeContext.variables } : {},
        nodeOutputs: new Map(
          Object.entries(resumeContext.nodeOutputs || {}).map(([k, v]) => [k, v])
        ),
        logs: resumeContext.logs ? [...resumeContext.logs] : [],
        status: resumeContext.status || 'running',
        currentNodeIds: resumeContext.currentNodeIds ? [...resumeContext.currentNodeIds] : [],
        startTime: resumeContext.startTime || Date.now(),
        endTime: resumeContext.endTime,
        error: resumeContext.error,
      }
    : createExecutionContext(workflow, inputs)

  const nodeMap = new Map(workflow.nodes.map((n) => [n.id, n]))
  const activeEdges = new Set(workflow.edges.map((e) => e.id))
  const completed = new Set<string>(initialCompletedNodeIds || [])
  const running = new Set<string>()

  // 恢复已完成的 condition/loop 副作用（边状态）
  for (const nodeId of completed) {
    const node = nodeMap.get(nodeId)
    if (!node) continue
    if (node.type === 'condition') {
      const output = ctx.nodeOutputs.get(nodeId)
      processConditionNode(node, output)
    } else if (node.type === 'loop') {
      // loop 副作用较复杂，断点续跑时重新执行 loop 节点以恢复边状态
      completed.delete(nodeId)
    }
  }

  const log = (entry: Omit<DagExecutionLog, 'timestamp'>) => {
    const full = createLogEntry(entry)
    ctx.logs.push(full)
    onLog?.(full)
  }

  const executorOptions = {
    abortSignal,
    onLog: log,
    activeEdges,
    workflow,
    getWorkflowById,
  }

  function getActiveIncoming(nodeId: string) {
    return workflow.edges.filter((e) => e.target === nodeId && activeEdges.has(e.id))
  }

  function getActiveOutgoing(nodeId: string) {
    return workflow.edges.filter((e) => e.source === nodeId && activeEdges.has(e.id))
  }

  function isReady(nodeId: string): boolean {
    if (completed.has(nodeId) || running.has(nodeId)) return false
    const incoming = getActiveIncoming(nodeId)
    if (incoming.length === 0) {
      const node = nodeMap.get(nodeId)
      return node?.type === 'start' || workflow.nodes.length === 1
    }
    return incoming.every((e) => completed.has(e.source))
  }

  async function executeNodeWithRetry(node: DagNode): Promise<unknown> {
    const { mode, retries } = getNodeErrorStrategy(node)
    const retryDelayMs = Math.max(0, Number(node.data.retryDelayMs) || 0)
    let lastError: Error | undefined
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await nodeExecutors[node.type](node, ctx, executorOptions)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        log({
          nodeId: node.id,
          level: 'warn',
          message: `节点 ${node.data.label || node.id} 执行失败（尝试 ${attempt + 1}/${retries + 1}）：${lastError.message}`,
        })
        if (mode !== 'retry' || attempt === retries) break
        if (retryDelayMs > 0) {
          log({ nodeId: node.id, level: 'info', message: `等待 ${retryDelayMs}ms 后重试...` })
          await sleep(retryDelayMs)
        }
      }
    }
    throw lastError
  }

  function collectLinearChain(startId: string, stopId: string): DagNode[] {
    const chain: DagNode[] = []
    let current = nodeMap.get(startId)
    while (current && current.id !== stopId) {
      chain.push(current)
      const outgoing = workflow.edges.filter(
        (e) => e.source === current!.id && activeEdges.has(e.id)
      )
      if (outgoing.length !== 1) break
      const next = nodeMap.get(outgoing[0].target)
      if (!next || next.id === stopId) break
      current = next
    }
    return chain
  }

  async function processLoopNode(loopNode: DagNode) {
    const cfg = loopNode.data.loop || {}
    const rawArray = cfg.loopOver ? evaluateExpression(cfg.loopOver, ctx) : undefined
    const iterable = Array.isArray(rawArray) ? rawArray : []
    const maxIter = Math.min(Math.max(1, cfg.maxIterations || 100), 1000)

    const outgoing = getActiveOutgoing(loopNode.id)
    const bodyEdge = outgoing.find((e) => e.label === 'body') || outgoing[0]
    if (!bodyEdge) return

    const bodyChain = collectLinearChain(bodyEdge.target, loopNode.id)
    const iterations: unknown[] = []

    for (let i = 0; i < Math.min(iterable.length, maxIter); i++) {
      if (abortSignal.aborted) throw new Error('已取消')
      ctx.variables[cfg.loopVariable || 'item'] = iterable[i]
      for (const bodyNode of bodyChain) {
        const out = await nodeExecutors[bodyNode.type](bodyNode, ctx, executorOptions)
        ctx.nodeOutputs.set(bodyNode.id, out)
      }
      const lastOutput = bodyChain.length > 0
        ? ctx.nodeOutputs.get(bodyChain[bodyChain.length - 1].id)
        : ctx.nodeOutputs.get(bodyEdge.target)
      iterations.push(lastOutput)
    }

    for (const bodyNode of bodyChain) {
      completed.add(bodyNode.id)
    }

    activeEdges.delete(bodyEdge.id)
    for (const edge of workflow.edges) {
      if (edge.type === 'loopback' && edge.target === loopNode.id) {
        activeEdges.delete(edge.id)
      }
    }

    ctx.nodeOutputs.set(loopNode.id, { iterations, count: iterations.length })
  }

  function processConditionNode(conditionNode: DagNode, result: unknown) {
    const bool = Boolean(result)
    const conditionEdges = workflow.edges.filter(
      (e) => e.source === conditionNode.id && e.type === 'condition' && activeEdges.has(e.id)
    )
    for (const edge of conditionEdges) {
      const label = (edge.label || '').toLowerCase()
      const matches = (bool && label === 'true') || (!bool && label === 'false')
      if (!matches) {
        activeEdges.delete(edge.id)
      }
    }
  }

  if (ctx.status === 'paused') {
    ctx.status = 'running'
  }

  try {
    while (completed.size < workflow.nodes.length) {
      if (abortSignal.aborted) {
        ctx.status = 'cancelled'
        break
      }

      const ready = workflow.nodes.filter((n) => isReady(n.id))
      if (ready.length === 0) {
        break
      }

      ctx.currentNodeIds = ready.map((n) => n.id)

      await Promise.all(
        ready.map(async (node) => {
          running.add(node.id)
          onNodeStart?.(node.id)

          log({
            nodeId: node.id,
            level: 'info',
            message: `开始执行节点 ${node.data.label || node.id}`,
          })

          try {
            const output = await executeNodeWithRetry(node)
            running.delete(node.id)
            completed.add(node.id)
            ctx.nodeOutputs.set(node.id, output)
            onNodeComplete?.(node.id, output)

            log({
              nodeId: node.id,
              level: 'info',
              message: `节点 ${node.data.label || node.id} 执行完成`,
              output,
            })

            if (node.type === 'condition') {
              processConditionNode(node, output)
            } else if (node.type === 'loop') {
              await processLoopNode(node)
            }
          } catch (err) {
            running.delete(node.id)
            const error = err instanceof Error ? err : new Error(String(err))
            onNodeError?.(node.id, error)

            const { mode } = getNodeErrorStrategy(node)
            if (mode === 'skip') {
              completed.add(node.id)
              log({
                nodeId: node.id,
                level: 'warn',
                message: `节点 ${node.data.label || node.id} 失败但设置为 skip，继续执行后续节点：${error.message}`,
              })
            } else {
              log({
                nodeId: node.id,
                level: 'error',
                message: `节点 ${node.data.label || node.id} 执行失败：${error.message}`,
              })
              ctx.status = 'failed'
              ctx.error = error.message
              throw error
            }
          }
        })
      )

      const pending = workflow.nodes.filter((n) => !completed.has(n.id)).map((n) => n.id)
      onCheckpoint?.(ctx, Array.from(completed), pending)

      const paused = await checkPaused?.()
      if (paused) {
        ctx.status = 'paused'
        log({
          nodeId: '',
          level: 'info',
          message: `工作流 ${workflowName || workflow.id} 已暂停`,
        })
        break
      }
    }

    if (ctx.status === 'running') {
      ctx.status = 'completed'
    }
  } catch (err) {
    if (ctx.status !== 'failed') {
      ctx.status = 'failed'
      ctx.error = err instanceof Error ? err.message : String(err)
    }
  } finally {
    ctx.endTime = Date.now()
    ctx.currentNodeIds = []

    if (workflow.outputMapping && (ctx.status === 'completed' || ctx.status === 'running')) {
      try {
        const outputs: Record<string, unknown> = {}
        for (const [key, expr] of Object.entries(workflow.outputMapping)) {
          outputs[key] = evaluateExpression(expr, ctx)
        }
        ctx.nodeOutputs.set('__outputs__', outputs)
      } catch {
        // 输出映射失败不阻塞主流程
      }
    }
  }

  if (ctx.status === 'completed') {
    try {
      useUsageStore.getState().report(buildTodayUsageRecord({ workflowRuns: 1 }))
    } catch {
      // 用量上报失败不影响工作流执行结果
    }
  }

  return ctx
}

export function computeDagLayout(workflow: DagWorkflow): DagWorkflow {
  const waves = buildWavesFromEdges(workflow.nodes, workflow.edges)
  const positions = new Map<string, NodePosition>()
  const spacingX = 320
  const baseSpacingY = 160

  if (waves.length === 0) {
    return { ...workflow, nodes: workflow.nodes.map((n) => ({ ...n, position: n.position })) }
  }

  const maxWaveSize = Math.max(...waves.map((w) => w.length), 1)
  const spacingY = Math.max(baseSpacingY, Math.min(220, (maxWaveSize > 4 ? 200 : baseSpacingY)))

  const waveIndexMap = new Map<string, number>()
  waves.forEach((wave, idx) => {
    wave.forEach((node) => waveIndexMap.set(node.id, idx))
  })

  const upstreamPositions = (nodeId: string): number[] => {
    const upstream = getUpstreamNodes(nodeId, workflow.edges)
    return upstream
      .map((id) => positions.get(id))
      .filter((p): p is NodePosition => !!p)
      .map((p) => p.y)
  }

  waves.forEach((wave, waveIndex) => {
    const sortedWave = [...wave].sort((a, b) => {
      const upstreamA = upstreamPositions(a.id)
      const upstreamB = upstreamPositions(b.id)
      const avgA = upstreamA.length > 0 ? upstreamA.reduce((s, y) => s + y, 0) / upstreamA.length : 0
      const avgB = upstreamB.length > 0 ? upstreamB.reduce((s, y) => s + y, 0) / upstreamB.length : 0
      return avgA - avgB
    })

    const startY = -((sortedWave.length - 1) * spacingY) / 2
    sortedWave.forEach((node, nodeIndex) => {
      positions.set(node.id, {
        x: waveIndex * spacingX,
        y: startY + nodeIndex * spacingY,
      })
    })
  })

  return {
    ...workflow,
    nodes: workflow.nodes.map((n) => ({
      ...n,
      position: positions.get(n.id) || n.position,
    })),
  }
}

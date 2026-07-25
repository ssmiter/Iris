import type { Message, ProviderConfig, StreamChunk } from '@/types/mescli'
import type { ExecutionMode } from './types'
import type { ModelClient, ModelClientRequest } from './modelClient'
import { createModelClient, isAnthropicCompatibleProvider } from './modelClient'
import { createBackendProxyModelClient } from './modelClient/backendProxyModelClient'
import { IS_STANDALONE } from '@/api/client'
import { isLocalRuntime } from '@/utils/runtimeMode'

/**
 * pipelineRunner —— 一次性模型调用的统一入口（对标 claude-code sideQuery）
 *
 * 目标：所有"输入≈自然语言（从系统状态装配）、prompt=自然语言模板、
 * 输出=结构化自然语言"的一次性任务（会话标题、长对话压缩、记忆整理、审批解释……）
 * 收敛到这一个入口，不再各写各的。
 *
 * 硬约定（不可插拔）：
 * 1. name 必填——归因标签，进日志/熔断状态（对标 querySource）；
 * 2. 失败静默——pipeline 是增强而非主链路，任何失败返回 { ok:false }，调用方自行回落，
 *    绝不抛出影响主对话；
 * 3. per-name 连续失败 3 次熔断（10 分钟半开）——防止 provider 过载时后台任务放大雪崩；
 * 4. token/成本与主会话隔离——不触碰主对话消息数组，writeBack 由调用方在 runner 外执行；
 * 5. 独立 AbortController + 超时，可与调用方 signal 联动。
 *
 * 结构化输出策略（跨 provider 公共分母，不依赖任何 provider 特有能力）：
 * prompt 内 JSON/标签指令 → 解析 → 失败 1 次修复重试 → 仍失败静默。
 *
 * TODO(pipeline-model-slot): 小模型槽位。标题/审批解释等轻量 pipeline 未来应走低成本
 * 小模型（如 ProviderConfig.pipelineModel 或全局配置项）。当前 modelSlot 仅作声明、
 * 全部使用当前会话模型——届时只需在 transport 层按 slot 选模型，骨架无需改动。
 */

export type PipelineName =
  | 'compact_summary'
  | 'session_title'
  | 'memory_organize'
  | 'approval_explain'

/** TODO(pipeline-model-slot): 'small' 当前等价于 'main'，见文件头 TODO */
export type PipelineModelSlot = 'main' | 'small'

export interface PipelineTokenUsage {
  tokensIn?: number
  tokensOut?: number
}

export type OutputSpec<O> =
  | { kind: 'json'; parse: (value: unknown) => O | null }
  | { kind: 'tagged'; tag: string; parse?: (inner: string) => O }
  | { kind: 'text' }

export interface PipelinePrompt {
  system?: string
  messages: Message[]
}

export interface PipelineDefinition<I, O> {
  name: PipelineName
  /** 每 pipeline 一个 prompt.ts，builder 函数从输入装配 prompt */
  buildPrompt: (input: I) => PipelinePrompt
  output: OutputSpec<O>
  /** 默认 1024（对齐 sideQuery 默认值）；摘要类 pipeline 应显式调大 */
  maxTokens?: number
  temperature?: number
  /** 传输层重试次数，默认 2（指数退避 + jitter） */
  maxRetries?: number
  /** 单次调用超时，默认 60s */
  timeoutMs?: number
  /** 默认 true：注入 no-tools 首尾夹击，防模型输出"我先调用工具"式废话 */
  noTools?: boolean
  /** TODO(pipeline-model-slot): 见文件头 TODO，当前不生效 */
  modelSlot?: PipelineModelSlot
}

export interface PipelineResult<O> {
  ok: boolean
  value?: O
  rawText?: string
  error?: string
  usage?: PipelineTokenUsage
  attempts: number
}

/** 通道抽象：给请求，拿回完整文本。由调用方按运行模式装配（见 createPipelineTransport） */
export type PipelineTransport = (req: {
  system?: string
  messages: Message[]
  maxTokens: number
  temperature?: number
  signal: AbortSignal
}) => Promise<{ text: string; usage?: PipelineTokenUsage }>

// ───────────────────────── 熔断（per-name，对标 529 后台熔断精神） ─────────────────────────

const CIRCUIT_FAILURE_THRESHOLD = 3
const CIRCUIT_COOLDOWN_MS = 10 * 60 * 1000

interface CircuitState {
  failures: number
  openedAt: number
}

const circuitState = new Map<PipelineName, CircuitState>()

function isCircuitOpen(name: PipelineName): boolean {
  const s = circuitState.get(name)
  if (!s || s.failures < CIRCUIT_FAILURE_THRESHOLD) return false
  // 冷却后半开：允许一次试探，成功则 recordSuccess 清零
  return Date.now() - s.openedAt <= CIRCUIT_COOLDOWN_MS
}

function recordPipelineSuccess(name: PipelineName): void {
  circuitState.delete(name)
}

function recordPipelineFailure(name: PipelineName): void {
  const s = circuitState.get(name) ?? { failures: 0, openedAt: 0 }
  s.failures += 1
  if (s.failures >= CIRCUIT_FAILURE_THRESHOLD && s.openedAt === 0) {
    s.openedAt = Date.now()
    console.warn(`[pipelineRunner] 熔断开启：${name} 连续失败 ${s.failures} 次，暂停 ${CIRCUIT_COOLDOWN_MS / 60000} 分钟`)
  }
  circuitState.set(name, s)
}

/** 手动恢复熔断（测试/调试入口） */
export function resetPipelineCircuit(name?: PipelineName): void {
  if (name) circuitState.delete(name)
  else circuitState.clear()
}

// ───────────────────────── no-tools 首尾夹击 ─────────────────────────

const NO_TOOLS_PREAMBLE = `重要：只用纯文本回答，不要调用任何工具。你已经拥有回答所需的全部上下文。`

const NO_TOOLS_TRAILER = `提醒：不要调用任何工具，直接输出要求的内容。`

// ───────────────────────── 输出解析 ─────────────────────────

/** 从文本中提取第一个合法 JSON 值（容忍 ```json 围栏与前导/尾随说明文字） */
function extractJson(text: string): unknown | null {
  let s = text.trim()
  // 剥离 markdown 围栏
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence) s = fence[1].trim()

  try {
    return JSON.parse(s)
  } catch {
    // 继续尝试括号扫描
  }

  const start = s.search(/[{[]/)
  if (start === -1) return null
  const openChar = s[start]
  const closeChar = openChar === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && inString) {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === openChar || (openChar === '{' ? ch === '{' : ch === '[')) depth++
    else if (ch === closeChar) {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function parseOutput<O>(spec: OutputSpec<O>, text: string): O | null {
  switch (spec.kind) {
    case 'text':
      return (text.trim() ? (text.trim() as O) : null)
    case 'tagged': {
      const closed = new RegExp(`<${spec.tag}>([\\s\\S]*?)</${spec.tag}>`, 'i').exec(text)
      const inner = closed
        ? closed[1].trim()
        // 容忍未闭合尾标签（被 maxTokens 截断）：取开标签后的全部内容
        : (new RegExp(`<${spec.tag}>([\\s\\S]*)$`, 'i').exec(text)?.[1].trim() ?? '')
      if (!inner) return null
      return spec.parse ? spec.parse(inner) : (inner as O)
    }
    case 'json': {
      const value = extractJson(text)
      if (value === null || value === undefined) return null
      return spec.parse(value)
    }
  }
}

// ───────────────────────── 重试退避 ─────────────────────────

function backoffMs(attempt: number): number {
  const base = Math.min(500 * Math.pow(2, attempt), 8000)
  return base + Math.random() * 0.25 * base
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error) {
    return err.name === 'AbortError' || /abort|超时|timeout/i.test(err.message)
  }
  return false
}

// ───────────────────────── 主入口 ─────────────────────────

export async function runPipeline<I, O>(
  def: PipelineDefinition<I, O>,
  input: I,
  transport: PipelineTransport,
  opts?: { signal?: AbortSignal }
): Promise<PipelineResult<O>> {
  if (isCircuitOpen(def.name)) {
    console.warn(`[pipelineRunner] ${def.name} 熔断中，跳过本次调用`)
    return { ok: false, error: 'circuit_open', attempts: 0 }
  }

  const maxTokens = def.maxTokens ?? 1024
  const maxRetries = def.maxRetries ?? 2
  const timeoutMs = def.timeoutMs ?? 60_000

  const prompt = def.buildPrompt(input)

  // no-tools 首尾夹击：preamble 进 system 开头，trailer 追加到最后一条 user 消息
  let system = prompt.system
  let messages = prompt.messages
  if (def.noTools !== false) {
    system = system ? `${NO_TOOLS_PREAMBLE}\n\n${system}` : NO_TOOLS_PREAMBLE
    messages = messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'user'
        ? { ...m, content: `${m.content}\n\n${NO_TOOLS_TRAILER}` }
        : m
    )
  }

  let attempts = 0

  const callOnce = async (msgs: Message[]): Promise<{ text: string; usage?: PipelineTokenUsage }> => {
    attempts++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`pipeline ${def.name} 调用超时`)), timeoutMs)
    const onParentAbort = (): void => controller.abort(opts?.signal?.reason)
    opts?.signal?.addEventListener('abort', onParentAbort)
    try {
      return await transport({
        system,
        messages: msgs,
        maxTokens,
        temperature: def.temperature,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
      opts?.signal?.removeEventListener('abort', onParentAbort)
    }
  }

  // 1) 传输调用 + 指数退避重试
  let response: { text: string; usage?: PipelineTokenUsage } | null = null
  let lastError = ''
  for (let i = 0; i <= maxRetries; i++) {
    try {
      response = await callOnce(messages)
      break
    } catch (err) {
      if (isAbortError(err)) {
        return { ok: false, error: 'aborted', attempts }
      }
      lastError = err instanceof Error ? err.message : String(err)
      if (i < maxRetries) await sleep(backoffMs(i))
    }
  }
  if (!response) {
    recordPipelineFailure(def.name)
    return { ok: false, error: lastError || 'transport_failed', attempts }
  }

  // 2) 解析输出
  const parsed = parseOutput(def.output, response.text)
  if (parsed !== null) {
    recordPipelineSuccess(def.name)
    return { ok: true, value: parsed, rawText: response.text, usage: response.usage, attempts }
  }

  // 3) 解析失败：1 次修复重试（带回上下文要求只输出格式内容）
  const repairMessages: Message[] = [
    ...messages,
    { role: 'assistant', content: response.text },
    {
      role: 'user',
      content: '你的输出不符合要求的格式。请重新输出，只包含要求格式的内容本身，不要任何解释、道歉或额外文字。',
    },
  ]
  try {
    const retry = await callOnce(repairMessages)
    const parsed2 = parseOutput(def.output, retry.text)
    if (parsed2 !== null) {
      recordPipelineSuccess(def.name)
      return { ok: true, value: parsed2, rawText: retry.text, usage: retry.usage, attempts }
    }
    recordPipelineFailure(def.name)
    return { ok: false, error: 'parse_failed', rawText: retry.text, usage: retry.usage, attempts }
  } catch (err) {
    if (isAbortError(err)) {
      return { ok: false, error: 'aborted', attempts }
    }
    recordPipelineFailure(def.name)
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      rawText: response.text,
      usage: response.usage,
      attempts,
    }
  }
}

// ───────────────────────── 通道工厂（按运行模式装配） ─────────────────────────

export interface PipelineTransportOptions {
  provider: ProviderConfig
  apiKey?: string
  baseUrl?: string
  conversationId?: number
  systemCode?: string
  executionMode?: ExecutionMode
  /** MESCLI-Online 前端循环开关（默认 true——Online 默认即前端循环） */
  enableFrontendToolLoop?: boolean
}

/**
 * 按当前运行模式装配一次性调用通道：
 * - MESCLI-Online（前端循环）/ Local Anthropic 兼容 Provider：后端 /api/chat/proxy 代理；
 * - Standalone / Local 其他 Provider：直连 ModelClient；
 * - Online 传统后端路径：不支持（该路径由后端 ChatService 自行管理上下文，pipeline 不可用）。
 *
 * 复用流式通道收集完整文本——零后端改动，三条路径统一。
 */
export function createPipelineTransport(opts: PipelineTransportOptions): PipelineTransport {
  return async ({ system, messages, maxTokens, temperature, signal }) => {
    const baseUrl = opts.baseUrl || opts.provider.baseUrl
    // tokenhub（腾讯 tokenhub.tencentmaas.com）不发 CORS 头，Local 下也必须走后端代理
    const useProxy =
      !IS_STANDALONE &&
      ((isLocalRuntime() &&
        (isAnthropicCompatibleProvider(opts.provider.provider, baseUrl) ||
          opts.provider.provider === 'tokenhub')) ||
        (!isLocalRuntime() && opts.enableFrontendToolLoop !== false))

    const request: ModelClientRequest = {
      provider: opts.provider.provider,
      model: opts.provider.model,
      apiKey: opts.apiKey,
      baseUrl,
      systemPrompt: system,
      messages,
      maxTokens,
      temperature,
      conversationId: opts.conversationId,
      systemCode: opts.systemCode,
      executionMode: opts.executionMode,
    }

    if (useProxy) {
      return collectViaModelClient(createBackendProxyModelClient(), request, signal)
    }

    if (!IS_STANDALONE && !isLocalRuntime() && opts.enableFrontendToolLoop === false) {
      // Online 传统后端路径：后端 ChatService 自建系统提示词与上下文管理，
      // pipeline 的自定义 system/messages 无法生效——明确拒绝而非静默降级。
      throw new Error('pipeline_unavailable_legacy_backend')
    }

    const client = await createModelClient(opts.provider.provider, baseUrl)
    return collectViaModelClient(client, request, signal)
  }
}

function collectViaModelClient(
  client: ModelClient,
  request: ModelClientRequest,
  signal: AbortSignal
): Promise<{ text: string; usage?: PipelineTokenUsage }> {
  return new Promise((resolve, reject) => {
    let text = ''
    let usage: PipelineTokenUsage | undefined
    let settled = false
    let abortStream: (() => void) | undefined

    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      abortStream?.()
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort)

    abortStream = client.streamChat(request, {
      onChunk: (chunk: StreamChunk) => {
        if (chunk.type === 'content' && chunk.content) text += chunk.content
        if (chunk.type === 'usage' && chunk.usage) {
          usage = { tokensIn: chunk.usage.tokensIn, tokensOut: chunk.usage.tokensOut }
        }
      },
      onError: (err) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      },
      onDone: () => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ text: text.trim(), usage })
      },
    })
  })
}

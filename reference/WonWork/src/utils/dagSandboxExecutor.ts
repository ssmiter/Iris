import type {
  DagExecutionContext,
  DagExecutionLog,
  DagNode,
  DagNodeType,
  DagWorkflow,
  ExecutionPlan,
  NodeExecutor,
} from '@/types/dagWorkflow'
import { executors, executeDagWorkflow, evaluateExpression } from '@/stores/dagExecutionEngine'
import { planToDag } from '@/utils/planToDag'
import { classifyDagSafety } from '@/utils/dagSideEffectClassifier'
import { createMockResult } from '@/utils/dagMockResultFactory'
import { generateDummyInputs } from '@/utils/dagDummyInputGenerator'

export interface SandboxResult {
  success: boolean
  /** 工作流是否被判定为完全无害 */
  harmless: boolean
  /** 被 mock 跳过的节点 ID 列表 */
  skippedNodes: string[]
  /** 执行日志 */
  logs: DagExecutionLog[]
  /** 所有节点输出（key 为节点 ID） */
  nodeOutputs: Record<string, unknown>
  /** 最终 outputMapping 解析结果 */
  outputs?: Record<string, unknown>
  /** 错误信息 */
  error?: string
}

export interface SandboxOptions {
  /** 每个节点执行超时（毫秒），默认 30000 */
  timeoutMs?: number
  /** LLM 节点沙箱超时（毫秒），默认 5000；超时时 mock */
  llmTimeoutMs?: number
  /** 自定义 dummy 输入，覆盖自动生成 */
  dummyInputs?: Record<string, unknown>
}

function generateWorkflowId(): string {
  return `sandbox-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function isSelectOnlySql(sql: string): boolean {
  const normalized = sql.trim().toUpperCase()
  return normalized.startsWith('SELECT') && !normalized.includes(' INTO ')
}

function addLimitOne(sql: string): string {
  const trimmed = sql.trim()
  if (/\bLIMIT\s+\d+\s*;?\s*$/i.test(trimmed)) {
    return trimmed
  }
  const withoutSemicolon = trimmed.replace(/;\s*$/, '')
  return `${withoutSemicolon} LIMIT 1`
}

function buildSandboxExecutors(
  skippedNodes: Set<string>,
  llmTimeoutMs: number
): Partial<Record<DagNodeType, NodeExecutor>> {
  const sandboxExecutors: Partial<Record<DagNodeType, NodeExecutor>> = {}

  // 只读 SELECT 数据库查询：真实执行，但强制 LIMIT 1
  sandboxExecutors.database_query = async (node, ctx, options) => {
    const originalQuery = node.data.databaseQuery?.query || ''
    if (!isSelectOnlySql(originalQuery)) {
      skippedNodes.add(node.id)
      return createMockResult({ nodeId: node.id, nodeType: 'database_query', nodeData: node.data })
    }

    const limitedNode: DagNode = {
      ...node,
      data: {
        ...node.data,
        databaseQuery: {
          ...node.data.databaseQuery,
          query: addLimitOne(originalQuery),
        },
      },
    }
    return executors.database_query(limitedNode, ctx, options)
  }

  // side_effect 节点直接 mock
  for (const type of [
    'http_request',
    'file_operation',
    'send_message',
    'tool',
    'webbridge',
    'javascript',
    'agent_swarm',
    'sub_workflow',
  ] as DagNodeType[]) {
    sandboxExecutors[type] = async (node: DagNode) => {
      skippedNodes.add(node.id)
      return createMockResult({ nodeId: node.id, nodeType: type, nodeData: node.data })
    }
  }

  // LLM 节点在沙箱中设置短超时，避免耗时/耗 token
  sandboxExecutors.llm = async (node, ctx, options) => {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), llmTimeoutMs)
    try {
      const result = await executors.llm(node, ctx, {
        ...options,
        abortSignal: controller.signal,
      })
      clearTimeout(timeoutId)
      return result
    } catch (err) {
      clearTimeout(timeoutId)
      skippedNodes.add(node.id)
      return { content: 'LLM 节点在沙箱中超时被 mock', mock: true }
    }
  }

  return sandboxExecutors
}

export async function runExecutionPlanInSandbox(
  plan: ExecutionPlan,
  options: SandboxOptions = {}
): Promise<SandboxResult> {
  const partialWorkflow = planToDag(plan)
  const workflow: DagWorkflow = {
    ...partialWorkflow,
    id: generateWorkflowId(),
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  return runDagWorkflowInSandbox(workflow, options)
}

export async function runDagWorkflowInSandbox(
  workflow: DagWorkflow,
  options: SandboxOptions = {}
): Promise<SandboxResult> {
  const timeoutMs = options.timeoutMs ?? 30000
  const llmTimeoutMs = options.llmTimeoutMs ?? 5000

  const safety = classifyDagSafety(workflow.nodes)
  const skippedNodes = new Set<string>()

  if (!safety.harmless) {
    return {
      success: true,
      harmless: false,
      skippedNodes: safety.sideEffectStepIds,
      logs: [
        {
          timestamp: Date.now(),
          nodeId: '',
          level: 'info',
          message: safety.skipReason || '工作流含副作用节点，跳过沙箱试运行',
        },
      ],
      nodeOutputs: {},
    }
  }

  const dummyInputs = options.dummyInputs ?? generateDummyInputs(workflow.inputSchema)
  const sandboxExecutors = buildSandboxExecutors(skippedNodes, llmTimeoutMs)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const ctx: DagExecutionContext = await executeDagWorkflow(workflow, dummyInputs, {
      abortSignal: controller.signal,
      executors: sandboxExecutors,
      onLog: (log) => {
        // 日志由 ctx.logs 收集
      },
    })

    clearTimeout(timeoutId)

    // 强制验证 outputMapping
    let outputs: Record<string, unknown> | undefined
    if (workflow.outputMapping && ctx.status === 'completed') {
      try {
        outputs = {}
        for (const [key, expr] of Object.entries(workflow.outputMapping)) {
          outputs[key] = evaluateExpression(expr, ctx)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          success: false,
          harmless: true,
          skippedNodes: Array.from(skippedNodes),
          logs: ctx.logs,
          nodeOutputs: Object.fromEntries(ctx.nodeOutputs.entries()),
          error: `outputMapping 解析失败: ${msg}`,
        }
      }
    }

    if (ctx.status !== 'completed') {
      return {
        success: false,
        harmless: true,
        skippedNodes: Array.from(skippedNodes),
        logs: ctx.logs,
        nodeOutputs: Object.fromEntries(ctx.nodeOutputs.entries()),
        outputs,
        error: ctx.error || '沙箱执行未正常完成',
      }
    }

    return {
      success: true,
      harmless: true,
      skippedNodes: Array.from(skippedNodes),
      logs: ctx.logs,
      nodeOutputs: Object.fromEntries(ctx.nodeOutputs.entries()),
      outputs,
    }
  } catch (err) {
    clearTimeout(timeoutId)
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      harmless: true,
      skippedNodes: Array.from(skippedNodes),
      logs: [],
      nodeOutputs: {},
      error: msg,
    }
  }
}

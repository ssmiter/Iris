/**
 * DAG 工作流执行 Agent 编排器
 * 包装现有 executeDagWorkflow，在节点失败时调用 LLM 自动修复并恢复执行
 */

import type { DagWorkflow, DagExecutionContext, DagExecutionLog, DagNode } from '@/types/dagWorkflow'
import { executeDagWorkflow, type DagExecutionResumeContext } from '@/stores/dagExecutionEngine'
import { useChatStore } from '@/stores/chatStore'
import { useContextPanelStore } from '@/stores/contextPanelStore'
import {
  useWorkflowExecutionAgentStore,
  getNodeLabel,
  type RepairRecord,
  type AgentExecutionStatus,
  type AgentNodeStatus,
} from '@/stores/workflowExecutionAgentStore'
import {
  buildRepairPrompt,
  parseRepairDecision,
  applyNodeDataPatch,
  createRepairRecord,
  collectUpstreamOutputs,
} from '@/utils/dagWorkflowRepairPrompt'
import { chatApi } from '@/api/client'
import type { Message } from '@/types/mescli'
import { TrajectoryLogger } from '@/utils/trajectoryLogger'

export interface DagWorkflowRunResult {
  status: 'completed' | 'failed' | 'cancelled'
  outputs?: Record<string, unknown>
  error?: string
  logs: string[]
  executedWorkflow: DagWorkflow
}

export interface RunDagWorkflowAsAgentOptions {
  /** 是否以静默模式运行：不创建聊天消息、不操作右侧任务面板 */
  silent?: boolean
  /** 执行进度更新回调 */
  onProgress?: (snapshot: ReturnType<ReturnType<typeof useWorkflowExecutionAgentStore.getState>['getProgressSnapshot']>) => void
  /** 节点状态变化回调 */
  onNodeStatusChange?: (nodeId: string, status: AgentNodeStatus) => void
  /** 新日志行回调 */
  onLog?: (log: string) => void
  /** 自动把工作流修复写回 dagWorkflowStore（通过传入的 commit 回调） */
  onCommitRepairs?: (repairs: RepairRecord[]) => void | Promise<void>
  /** 最终完成回调（旧签名，保留兼容） */
  onComplete?: (ctx: DagExecutionContext, workflow: DagWorkflow) => void
  /** 失败回调（旧签名，保留兼容） */
  onFailed?: (ctx: DagExecutionContext | null, workflow: DagWorkflow, error: Error) => void
  /** 统一结果回调，包含日志 */
  onResult?: (result: DagWorkflowRunResult) => void
}

const MAX_TOTAL_REPAIRS = 50

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function cloneWorkflow(workflow: DagWorkflow): DagWorkflow {
  return deepClone(workflow)
}

const DOCUMENT_TOOL_NAMES = ['create_pptx_document', 'create_excel_document', 'create_word_document']

function getWrapperArrayFields(value: unknown): string[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const fields: string[] = []
  if (Array.isArray(obj.data) && obj.data.length > 0) fields.push('data')
  if (Array.isArray(obj.rows) && obj.rows.length > 0) fields.push('rows')
  if (Array.isArray(obj.results) && obj.results.length > 0) fields.push('results')
  return fields.length > 0 ? fields : null
}

function isDataOutput(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value) && value.length > 0) return true
  const obj = value as Record<string, unknown>
  if (Array.isArray(obj.data) && obj.data.length > 0) return true
  if (Array.isArray(obj.rows) && obj.rows.length > 0) return true
  if (Array.isArray(obj.results) && obj.results.length > 0) return true
  const keys = Object.keys(obj)
  if (keys.length >= 3) return true
  return false
}

function hasDataArrayAccess(code: string, field: string): boolean {
  return (
    new RegExp(`\\.${field}\\b`).test(code) ||
    new RegExp(`\\[['"]${field}['"]\\]`).test(code) ||
    new RegExp(`\\.get\\(['"]${field}['"]`).test(code)
  )
}

function getUpstreamNodeIds(workflow: DagWorkflow, nodeId: string): string[] {
  return workflow.edges.filter((e) => e.target === nodeId).map((e) => e.source)
}

function hasUpstreamDataReference(node: DagNode, dataUpstreamIds: string[]): boolean {
  const argsText = node.data.tool?.args || '{}'
  try {
    const args = JSON.parse(argsText) as Record<string, unknown>
    const pythonCode = String(args.python_code || '')
    if (!pythonCode) return true
    for (const id of dataUpstreamIds) {
      if (pythonCode.includes(id)) return true
      if (pythonCode.includes(`steps.${id}`)) return true
      if (pythonCode.includes(`nodeOutputs['${id}']`)) return true
      if (pythonCode.includes(`nodeOutputs["${id}"]`)) return true
    }
    return false
  } catch {
    return true
  }
}

function validateDocumentNodes(
  ctx: DagExecutionContext,
  workflow: DagWorkflow
): { valid: boolean; failedNodeId?: string; error?: Error } {
  for (const node of workflow.nodes) {
    if (node.type !== 'tool') continue
    const toolName = node.data.tool?.toolName || ''
    if (!DOCUMENT_TOOL_NAMES.includes(toolName)) continue

    const upstreamIds = getUpstreamNodeIds(workflow, node.id)
    if (upstreamIds.length === 0) continue

    const upstreamDataInfo = upstreamIds
      .map((id) => ({ id, wrapperFields: getWrapperArrayFields(ctx.nodeOutputs.get(id)) }))
      .filter((u) => isDataOutput(ctx.nodeOutputs.get(u.id)))

    if (upstreamDataInfo.length === 0) continue

    const dataUpstreamIds = upstreamDataInfo.map((u) => u.id)
    if (!hasUpstreamDataReference(node, dataUpstreamIds)) {
      return {
        valid: false,
        failedNodeId: node.id,
        error: new Error(
          `文档生成节点「${getNodeLabel(node)}」的 python_code 未引用上游数据节点（${dataUpstreamIds.join(', ')}），` +
            `导致 PPT 中该有数据的部分为空。请在代码中使用 \${steps.<上游节点ID>} 读取数据后再生成图表/表格。`
        ),
      }
    }

    const pythonCode = (() => {
      try {
        const args = JSON.parse(node.data.tool?.args || '{}') as Record<string, unknown>
        return String(args.python_code || '')
      } catch {
        return ''
      }
    })()

    for (const u of upstreamDataInfo) {
      if (!u.wrapperFields || !hasUpstreamDataReference(node, [u.id])) continue
      const hasAccess = u.wrapperFields.some((f) => hasDataArrayAccess(pythonCode, f))
      if (!hasAccess) {
        return {
          valid: false,
          failedNodeId: node.id,
          error: new Error(
            `文档生成节点「${getNodeLabel(node)}」的 python_code 引用了上游数据节点 ${u.id}，但未读取其 ${u.wrapperFields.join('/')} 数组，` +
              `导致 PPT 数据部分为空。请使用 json.loads('''\${steps.${u.id}}''').get('data', []) 获取数据后再生成图表/表格。`
          ),
        }
      }
    }
  }
  return { valid: true }
}

export async function runDagWorkflowAsAgent(
  workflow: DagWorkflow,
  inputs: Record<string, unknown>,
  options: RunDagWorkflowAsAgentOptions = {}
): Promise<DagExecutionContext> {
  const store = useWorkflowExecutionAgentStore.getState()
  store.reset()
  store.startExecution(workflow, inputs)

  // 轨迹日志：DAG Agent 执行开始
  const dagLogger = new TrajectoryLogger()
  dagLogger.startTrace(`DAG Agent: ${workflow.name}`, 'dag', {
    workflowId: workflow.id,
    nodeCount: workflow.nodes.length,
    edgeCount: workflow.edges.length,
    inputs: Object.keys(inputs),
  })
  let dagTraceActive = true

  if (!options.silent) {
    const panelStore = useContextPanelStore.getState()
    panelStore.clearTasks()
  }

  const localLogs: string[] = [...store.executionLog]
  const appendLog = (message: string) => {
    store.appendLog(message)
    localLogs.push(message)
    options.onLog?.(message)
  }

  const appendDagLog = (log: DagExecutionLog) => {
    store.appendDagLog(log)
    const prefix = log.nodeId ? `[${log.nodeId}] ` : ''
    const message = `${prefix}[${log.level}] ${log.message}`
    localLogs.push(message)
    options.onLog?.(message)
  }

  let mutableWorkflow = cloneWorkflow(workflow)
  let resumeContext: DagExecutionResumeContext | undefined
  let completedNodeIds: string[] | undefined
  let totalRepairs = 0

  const ensureTaskForNode = (node: typeof mutableWorkflow.nodes[0], status: 'running' | 'completed' | 'error' = 'running') => {
    if (options.silent) return
    const fresh = useContextPanelStore.getState()
    const existing = fresh.tasks.find((t) => t.title === getNodeLabel(node))
    if (existing) {
      fresh.updateTaskStatus(existing.id, status)
    } else {
      fresh.addTask({ title: getNodeLabel(node), status })
    }
  }

  const updateTaskForNodeId = (nodeId: string, status: 'running' | 'completed' | 'error') => {
    if (options.silent) return
    const node = mutableWorkflow.nodes.find((n) => n.id === nodeId)
    if (!node) return
    ensureTaskForNode(node, status)
  }

  const requestRepair = async (
    nodeId: string,
    error: Error,
    executionContext?: DagExecutionContext
  ): Promise<'retry' | 'mutate' | 'skip' | 'escalate' | 'cancelled'> => {
    const storeNow = useWorkflowExecutionAgentStore.getState()
    if (storeNow.isCancelled) return 'cancelled'

    const node = mutableWorkflow.nodes.find((n) => n.id === nodeId)
    if (!node) return 'escalate'

    const errorRecord = storeNow.nodeErrors.get(nodeId)
    const attempts = errorRecord?.attempts || 1

    const upstreamCtx: DagExecutionContext = executionContext
      ? {
          ...executionContext,
          nodeOutputs: new Map(executionContext.nodeOutputs.entries()),
        }
      : {
          workflowId: mutableWorkflow.id,
          runId: '',
          inputs,
          variables: {},
          nodeOutputs: new Map(),
          logs: [],
          status: 'running',
          currentNodeIds: [],
          startTime: Date.now(),
        }
    const upstreamOutputs = collectUpstreamOutputs(mutableWorkflow, nodeId, upstreamCtx)

    const prompt = buildRepairPrompt({
      node,
      error,
      upstreamOutputs,
      executionLog: storeNow.executionLog,
      attempts,
    })

    storeNow.recordRepair({
      nodeId,
      action: 'retry',
      reason: '请求 LLM 诊断中...',
      appliedAt: Date.now(),
    })

    const provider = useChatStore.getState().activeProvider
    if (!provider) {
      throw new Error('未选择 LLM 提供商，无法自动修复节点')
    }

    const messages: Message[] = [
      { role: 'system', content: '你是工业 AI 助手，专门诊断并修复 DAG 工作流节点错误。' },
      { role: 'user', content: prompt },
    ]

    return new Promise((resolve, reject) => {
      let collected = ''
      const abort = chatApi.streamChat(
        {
          provider: provider.provider,
          model: provider.model,
          baseUrl: provider.baseUrl,
          messages,
          saveToHistory: false,
        },
        (chunk) => {
          if (chunk.type === 'content') {
            collected += chunk.content || ''
          } else if (chunk.type === 'error') {
            reject(new Error(chunk.content || '修复请求失败'))
          }
        },
        (err) => reject(err),
        () => {
          try {
            const decision = parseRepairDecision(collected)
            if (decision.action === 'escalate') {
              storeNow.recordRepair(createRepairRecord(nodeId, decision))
              resolve('escalate')
              return
            }
            if (decision.action === 'skip') {
              storeNow.recordRepair(createRepairRecord(nodeId, decision))
              resolve('skip')
              return
            }
            if (decision.action === 'mutate' && decision.newConfig) {
              const nodeIndex = mutableWorkflow.nodes.findIndex((n) => n.id === nodeId)
              if (nodeIndex !== -1) {
                const patchedNode = applyNodeDataPatch(mutableWorkflow.nodes[nodeIndex], decision.newConfig)
                mutableWorkflow = {
                  ...mutableWorkflow,
                  nodes: [
                    ...mutableWorkflow.nodes.slice(0, nodeIndex),
                    patchedNode,
                    ...mutableWorkflow.nodes.slice(nodeIndex + 1),
                  ],
                }
              }
              storeNow.recordRepair(createRepairRecord(nodeId, decision))
              appendLog(`已应用节点「${getNodeLabel(node)}」修复配置：${decision.reason}`)
              resolve('mutate')
              return
            }
            storeNow.recordRepair(createRepairRecord(nodeId, decision))
            resolve('retry')
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            appendLog(`[修复] 无法解析 LLM 修复决策：${msg}`)
            resolve('escalate')
          }
        }
      )

      const controller = storeNow.abortController
      const onAbort = () => {
        abort()
        resolve('cancelled')
      }
      controller?.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  let lastFailedNodeId: string | null = null

  const execute = async (): Promise<DagExecutionContext> => {
    const storeNow = useWorkflowExecutionAgentStore.getState()
    const controller = storeNow.abortController
    if (!controller) {
      throw new Error('执行未初始化')
    }

    lastFailedNodeId = null

    // 轨迹日志：DAG 执行循环开始
    if (dagTraceActive) {
      dagLogger.addPhase('dag_execution', {
        input: { workflowName: mutableWorkflow.name, nodeCount: mutableWorkflow.nodes.length },
        metadata: { resumeContext: !!resumeContext, completedNodeCount: completedNodeIds?.length || 0 },
      })
    }

    return executeDagWorkflow(mutableWorkflow, inputs, {
      abortSignal: controller.signal,
      resumeContext,
      completedNodeIds,
      workflowName: mutableWorkflow.name,
      onNodeStart: (nodeId) => {
        const node = mutableWorkflow.nodes.find((n) => n.id === nodeId)
        if (node) {
          storeNow.setNodeStatus(nodeId, 'running')
          storeNow.setCurrentNodeId(nodeId)
          appendLog(`▶ 派发任务：${getNodeLabel(node)}`)
          ensureTaskForNode(node, 'running')
          options.onNodeStatusChange?.(nodeId, 'running')
          options.onProgress?.(storeNow.getProgressSnapshot())
        }
      },
      onNodeComplete: (nodeId, output) => {
        const node = mutableWorkflow.nodes.find((n) => n.id === nodeId)
        if (node) {
          storeNow.setNodeStatus(nodeId, 'completed')
          ensureTaskForNode(node, 'completed')
          options.onNodeStatusChange?.(nodeId, 'completed')
        }
      },
      onNodeError: (nodeId, error) => {
        lastFailedNodeId = nodeId
        storeNow.setNodeStatus(nodeId, 'error')
        storeNow.recordNodeError(nodeId, error)
        updateTaskForNodeId(nodeId, 'error')
        options.onNodeStatusChange?.(nodeId, 'error')
      },
      onLog: (log: DagExecutionLog) => {
        appendDagLog(log)
        options.onProgress?.(storeNow.getProgressSnapshot())
      },
      onCheckpoint: (ctx, completed, pending) => {
        resumeContext = {
          runId: ctx.runId,
          inputs: ctx.inputs,
          variables: { ...ctx.variables },
          nodeOutputs: Object.fromEntries(ctx.nodeOutputs.entries()),
          logs: [...ctx.logs],
          status: ctx.status,
          startTime: ctx.startTime,
          endTime: ctx.endTime,
          error: ctx.error,
          currentNodeIds: [...ctx.currentNodeIds],
        }
        completedNodeIds = completed
        storeNow.setResumeContext(resumeContext)
      },
      checkPaused: () => {
        return useWorkflowExecutionAgentStore.getState().isPaused
      },
    })
  }

  let lastCtx: DagExecutionContext | undefined

  try {
    while (true) {
      const storeNow = useWorkflowExecutionAgentStore.getState()
      if (storeNow.isCancelled) {
        appendLog('执行已取消')
        break
      }

      lastCtx = await execute()

      if (lastCtx.status === 'cancelled') {
        appendLog('执行已被取消')
        break
      }
      if (lastCtx.status === 'paused') {
        appendLog('执行已暂停')
        break
      }
      if (lastCtx.status === 'completed') {
        appendLog('工作流执行完成，正在校验文档节点数据引用...')
        options.onProgress?.(storeNow.getProgressSnapshot())
        const validation = validateDocumentNodes(lastCtx, mutableWorkflow)
        if (!validation.valid && validation.failedNodeId && validation.error) {
          lastCtx = {
            ...lastCtx,
            status: 'failed',
            error: validation.error.message,
            endTime: Date.now(),
          }
          lastFailedNodeId = validation.failedNodeId
          storeNow.setNodeStatus(validation.failedNodeId, 'error')
          storeNow.recordNodeError(validation.failedNodeId, validation.error)
          updateTaskForNodeId(validation.failedNodeId, 'error')
          appendLog(`[验证失败] ${validation.error.message}`)
          options.onProgress?.(storeNow.getProgressSnapshot())
          continue
        }
        appendLog('工作流执行完成')
        break
      }

      // status === 'failed'
      const failedNodeId = lastFailedNodeId
      const errorRecord = failedNodeId ? storeNow.nodeErrors.get(failedNodeId) : undefined
      const error = errorRecord?.error || new Error(lastCtx.error || '工作流执行失败')

      if (!failedNodeId) {
        throw error
      }

      totalRepairs++
      if (totalRepairs > MAX_TOTAL_REPAIRS) {
        throw new Error(`修复次数超过全局安全上限 ${MAX_TOTAL_REPAIRS} 次，停止执行。`)
      }

      appendLog(`节点「${getNodeLabel(mutableWorkflow.nodes.find((n) => n.id === failedNodeId)!)}」执行失败，正在请求 LLM 自动修复...`)
      useWorkflowExecutionAgentStore.setState({ status: 'repairing' })
      options.onProgress?.(storeNow.getProgressSnapshot())

      const decision = await requestRepair(failedNodeId, error, lastCtx)

      if (decision === 'cancelled') {
        break
      }
      if (decision === 'escalate') {
        throw error
      }
      if (decision === 'skip') {
        completedNodeIds = Array.from(new Set([...(completedNodeIds || []), failedNodeId]))
        resumeContext = resumeContext
          ? { ...resumeContext, status: 'running', error: undefined }
          : {
              inputs,
              variables: {},
              nodeOutputs: {},
              logs: [...lastCtx.logs],
              status: 'running',
              startTime: lastCtx.startTime,
            }
        storeNow.setNodeStatus(failedNodeId, 'completed')
        appendLog(`跳过节点：${getNodeLabel(mutableWorkflow.nodes.find((n) => n.id === failedNodeId)!)}`)
        continue
      }

      // retry / mutate：从失败节点重跑
      completedNodeIds = (completedNodeIds || []).filter((id) => id !== failedNodeId)
      resumeContext = resumeContext
        ? { ...resumeContext, status: 'running', error: undefined }
        : {
            inputs,
            variables: {},
            nodeOutputs: {},
            logs: [...lastCtx.logs],
            status: 'running',
            startTime: lastCtx.startTime,
          }
      storeNow.setNodeStatus(failedNodeId, 'pending')
      appendLog(`准备重试节点：${getNodeLabel(mutableWorkflow.nodes.find((n) => n.id === failedNodeId)!)}`)
      continue
    }

    const storeNow = useWorkflowExecutionAgentStore.getState()
    const finalCtx: DagExecutionContext = lastCtx || {
      workflowId: workflow.id,
      runId: '',
      inputs,
      variables: {},
      nodeOutputs: new Map(),
      logs: [],
      status: storeNow.isCancelled ? 'cancelled' : 'completed',
      currentNodeIds: [],
      startTime: Date.now(),
      endTime: Date.now(),
    }

    if (storeNow.isCancelled) {
      finalCtx.status = 'cancelled'
    }

    const agentStatus: AgentExecutionStatus =
      finalCtx.status === 'completed'
        ? 'completed'
        : finalCtx.status === 'cancelled'
          ? 'cancelled'
          : finalCtx.status === 'paused'
            ? 'running'
            : 'failed'
    useWorkflowExecutionAgentStore.setState({ status: agentStatus })

    // 轨迹日志：DAG Agent 执行完成
    if (dagTraceActive) {
      if (finalCtx.status === 'completed') {
        const outputs = finalCtx.nodeOutputs.get('__outputs__') as Record<string, unknown> | undefined
        dagLogger.complete(`DAG Agent 执行完成：${workflow.name}`, {
          executedNodeCount: completedNodeIds?.length || 0,
          outputKeys: outputs ? Object.keys(outputs) : [],
          totalRepairs,
          durationMs: finalCtx.endTime ? finalCtx.endTime - finalCtx.startTime : undefined,
        })
      } else if (finalCtx.status === 'cancelled') {
        dagLogger.fail('DAG Agent 执行已取消')
      } else {
        dagLogger.fail(finalCtx.error || 'DAG Agent 执行失败')
      }
      dagTraceActive = false
    }

    if (finalCtx.status === 'completed') {
      await options.onCommitRepairs?.(storeNow.getRepairMutations())
      options.onComplete?.(finalCtx, mutableWorkflow)
    }

    const outputs = finalCtx.nodeOutputs.get('__outputs__') as Record<string, unknown> | undefined
    options.onResult?.({
      status: finalCtx.status === 'completed' ? 'completed' : finalCtx.status === 'cancelled' ? 'cancelled' : 'failed',
      outputs,
      error: finalCtx.error,
      logs: localLogs,
      executedWorkflow: mutableWorkflow,
    })

    return finalCtx
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    const storeNow = useWorkflowExecutionAgentStore.getState()
    appendLog(`[错误] ${error.message}`)
    useWorkflowExecutionAgentStore.setState({ status: 'failed' })
    // 轨迹日志：DAG Agent 执行异常
    if (dagTraceActive) {
      dagLogger.fail(error.message)
      dagTraceActive = false
    }
    options.onFailed?.(null, mutableWorkflow, error)
    options.onResult?.({
      status: 'failed',
      error: error.message,
      logs: localLogs,
      executedWorkflow: mutableWorkflow,
    })
    throw error
  }
}

import type { DagNode, DagNodeData, DagNodeType, ExecutionPlan, ExecutionPlanStep } from '@/types/dagWorkflow'

export type NodeSafetyLevel = 'safe' | 'read_only' | 'side_effect'

export interface NodeSafetyClassification {
  nodeId: string
  nodeType: DagNodeType
  level: NodeSafetyLevel
  reason: string
}

export interface ExecutionPlanSafety {
  /** 整体是否完全无害（只包含 safe + read_only） */
  harmless: boolean
  /** 整体是否只读（允许 safe + read_only） */
  readOnly: boolean
  /** 每个 step 的分级结果 */
  steps: NodeSafetyClassification[]
  /** 含副作用的 step id 列表 */
  sideEffectStepIds: string[]
  /** 跳过的原因（含副作用时） */
  skipReason?: string
}

/** 只读 tool 白名单 */
export const READ_ONLY_TOOL_WHITELIST = new Set([
  'search_schema',
  'list_schema_tables',
  'get_table_schema',
  'execute_sql_query',
  'web_search',
  'web_fetch',
])

function isSelectOnlySql(sql: string): boolean {
  const normalized = sql.trim().toUpperCase()
  return normalized.startsWith('SELECT') && !normalized.includes(' INTO ')
}

function classifyNodeSafety(node: DagNode): NodeSafetyClassification {
  const { id, type } = node

  switch (type) {
    case 'start':
    case 'end':
    case 'condition':
    case 'loop':
    case 'delay':
    case 'variable':
    case 'merge':
      return { nodeId: id, nodeType: type, level: 'safe', reason: '控制流节点，无外部副作用' }

    case 'llm':
      return { nodeId: id, nodeType: type, level: 'safe', reason: 'LLM 调用无状态变更（仅耗时/耗 token）' }

    case 'database_query': {
      const query = node.data.databaseQuery?.query || ''
      return isSelectOnlySql(query)
        ? { nodeId: id, nodeType: type, level: 'read_only', reason: 'SQL 为纯 SELECT 查询' }
        : { nodeId: id, nodeType: type, level: 'side_effect', reason: 'SQL 非纯 SELECT，可能修改数据' }
    }

    case 'http_request': {
      const method = (node.data.httpRequest?.method || 'GET').toUpperCase()
      return method === 'GET' || method === 'HEAD'
        ? { nodeId: id, nodeType: type, level: 'read_only', reason: `HTTP 方法 ${method} 为只读` }
        : { nodeId: id, nodeType: type, level: 'side_effect', reason: `HTTP 方法 ${method} 可能产生副作用` }
    }

    case 'file_operation': {
      const action = node.data.fileOperation?.action || 'read'
      return action === 'read'
        ? { nodeId: id, nodeType: type, level: 'read_only', reason: '文件操作为读取' }
        : { nodeId: id, nodeType: type, level: 'side_effect', reason: `文件操作为 ${action}，会产生写入/上传/下载副作用` }
    }

    case 'send_message': {
      const channel = node.data.sendMessage?.channel || 'log'
      return channel === 'log'
        ? { nodeId: id, nodeType: type, level: 'safe', reason: 'send_message 仅输出日志' }
        : { nodeId: id, nodeType: type, level: 'side_effect', reason: `send_message channel 为 ${channel}，会触达用户/系统` }
    }

    case 'tool': {
      const toolName = node.data.tool?.toolName || ''
      return READ_ONLY_TOOL_WHITELIST.has(toolName)
        ? { nodeId: id, nodeType: type, level: 'read_only', reason: `tool ${toolName} 在白名单内` }
        : { nodeId: id, nodeType: type, level: 'side_effect', reason: `tool ${toolName || '(未命名)'} 不在只读白名单内` }
    }

    case 'webbridge':
    case 'javascript':
    case 'agent_swarm':
      return { nodeId: id, nodeType: type, level: 'side_effect', reason: `${type} 节点可能执行任意外部操作` }

    case 'sub_workflow':
      return { nodeId: id, nodeType: type, level: 'side_effect', reason: '子工作流副作用未知，v1 保守处理' }

    default:
      return { nodeId: id, nodeType: type, level: 'side_effect', reason: '未知节点类型，按有副作用处理' }
  }
}

function classifyExecutionPlanStep(step: ExecutionPlanStep): NodeSafetyClassification {
  const base = { nodeId: step.id }

  switch (step.kind) {
    case 'tool': {
      const toolName = step.toolName
      return READ_ONLY_TOOL_WHITELIST.has(toolName)
        ? { ...base, nodeType: 'tool', level: 'read_only', reason: `tool ${toolName} 在白名单内` }
        : { ...base, nodeType: 'tool', level: 'side_effect', reason: `tool ${toolName} 不在只读白名单内` }
    }
    case 'workflow':
      return { ...base, nodeType: 'sub_workflow', level: 'side_effect', reason: '子工作流副作用未知，v1 保守处理' }
    case 'node':
      return classifyNodeSafety({
        id: step.id,
        type: step.nodeType,
        position: { x: 0, y: 0 },
        data: { label: step.description || step.nodeType, ...step.config } as DagNodeData,
      })
    default:
      return { ...base, nodeType: 'tool', level: 'side_effect', reason: '未知 step 类型' }
  }
}

export function classifyDagSafety(nodes: DagNode[]): ExecutionPlanSafety {
  const steps = nodes.map(classifyNodeSafety)
  const sideEffectStepIds = steps.filter((s) => s.level === 'side_effect').map((s) => s.nodeId)
  const harmless = sideEffectStepIds.length === 0
  const readOnly = steps.every((s) => s.level === 'safe' || s.level === 'read_only')

  return {
    harmless,
    readOnly,
    steps,
    sideEffectStepIds,
    skipReason: harmless
      ? undefined
      : `存在 ${sideEffectStepIds.length} 个含副作用节点，跳过沙箱试运行`,
  }
}

export function classifyExecutionPlan(plan: ExecutionPlan): ExecutionPlanSafety {
  const steps = plan.steps.map(classifyExecutionPlanStep)
  const sideEffectStepIds = steps.filter((s) => s.level === 'side_effect').map((s) => s.nodeId)
  const harmless = sideEffectStepIds.length === 0
  const readOnly = steps.every((s) => s.level === 'safe' || s.level === 'read_only')

  return {
    harmless,
    readOnly,
    steps,
    sideEffectStepIds,
    skipReason: harmless
      ? undefined
      : `存在 ${sideEffectStepIds.length} 个含副作用步骤，跳过沙箱试运行`,
  }
}

export { classifyNodeSafety }

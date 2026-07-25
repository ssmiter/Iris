/**
 * DAG 工作流类型定义
 */

// ==================== 节点 ====================

export interface DagNode {
  id: string
  label: string
  type: 'llm_prompt' | 'tool_execute' | 'conditional' | 'transform' | 'output' | 'input'
  description?: string
  /** LLM prompt（type='llm_prompt' 时） */
  prompt?: string
  /** 工具名称（type='tool_execute' 时） */
  toolName?: string
  /** 工具参数模板 */
  toolParams?: Record<string, string>
  /** 条件表达式（type='conditional' 时） */
  condition?: string
  /** 转换脚本（type='transform' 时） */
  transformScript?: string
  /** 节点属性 */
  position?: { x: number; y: number }
  /** 自定义配置 */
  config?: Record<string, unknown>
  /** 超时毫秒 */
  timeoutMs?: number
  /** 最大重试次数 */
  maxRetries?: number
}

// ==================== 边 ====================

export interface DagEdge {
  id: string
  source: string
  target: string
  label?: string
  /** 条件边（type='conditional' 的节点输出用） */
  condition?: string
  /** 参数映射：target 节点参数名 → source 节点输出路径 */
  paramMapping?: Record<string, string>
}

// ==================== 工作流 ====================

export type DagWorkflowStatus = 'draft' | 'published' | 'archived'

export interface DagWorkflow {
  id: string
  name: string
  description?: string
  status: DagWorkflowStatus
  nodes: DagNode[]
  edges: DagEdge[]
  createdAt: string
  updatedAt: string
  version: number
  tags?: string[]
  metadata?: Record<string, unknown>
}

// ==================== 执行计划 ====================

export type ExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'

export interface ExecutionNodeStatus {
  nodeId: string
  status: ExecutionStatus
  startedAt?: string
  completedAt?: string
  output?: string
  error?: string
  retryCount: number
  durationMs?: number
}

export interface ExecutionPlan {
  id: string
  workflowId: string
  workflowName: string
  status: ExecutionStatus
  startedAt?: string
  completedAt?: string
  nodeStatuses: ExecutionNodeStatus[]
  currentNodeId?: string
  inputs?: Record<string, unknown>
  outputs?: Record<string, unknown>
  error?: string
  createdAt: string
}

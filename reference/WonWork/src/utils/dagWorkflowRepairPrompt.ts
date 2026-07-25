/**
 * DAG 修复提示词构建器
 * 把失败节点的上下文组装成 LLM 提示词，并解析返回的修复动作
 */

import type { DagNode, DagExecutionContext } from '@/types/dagWorkflow'
import type { RepairRecord } from '@/stores/workflowExecutionAgentStore'

import { safeStringify } from '@/utils/safeSerialize'

export type RepairAction = 'retry' | 'mutate' | 'skip' | 'escalate'

export interface RepairDecision {
  action: RepairAction
  reason: string
  newConfig?: Partial<Record<string, unknown>>
}

export interface RepairPromptContext {
  node: DagNode
  error: Error
  upstreamOutputs: Record<string, unknown>
  executionLog: string[]
  attempts: number
}

function serializeValue(value: unknown, maxLength = 2000): string {
  return safeStringify(value, maxLength)
}

function buildNodeSpecHint(nodeType: string): string {
  const specs: Record<string, string> = {
  tool:
      'tool: { toolName: string, args: JSON字符串 }。注意：args中若包含sql/query字段，会被按SQL字面量语义进行变量替换；其他字段会按JSON语义替换。修复时 newConfig 可直接提供 { tool: { args: "..." } }，args 必须是完整合法的 JSON 字符串。',
    database_query:
      'database_query: { connection?: string, query: SQL字符串, parameters?: JSON字符串 }。query字段使用${...}表达式时，会按SQL字面量（字符串加引号、日期转义）替换。',
    http_request:
      'http_request: { url: string, method: "GET"|"POST"|..., headers?: JSON字符串, body?: string, timeout?: number }',
    javascript:
      'javascript: { code: JavaScript代码字符串 }。code内可用 variables、nodeOutputs、inputs 三个全局对象。',
    llm:
      'llm: { prompt: string, model?: string, temperature?: number, maxTokens?: number, systemPrompt?: string }',
    file_operation:
      'file_operation: { action: "read"|"write"|"upload"|"download", path: string, content?: string, dataUrl?: string }',
    sub_workflow:
      'sub_workflow: { workflowId: string, inputs: JSON字符串 }',
    condition:
      'condition: { conditionExpression: string }。表达式使用${...}求值，结果会被Boolean()。',
    variable:
      'variable: { variableName: string, variableValue: string }。variableValue支持${...}表达式。',
  }
  return specs[nodeType] || `${nodeType}: 请参考 DagNodeData 类型定义配置节点。`
}

export function buildRepairPrompt(ctx: RepairPromptContext): string {
  const { node, error, upstreamOutputs, executionLog, attempts } = ctx
  const nodeType = node.type
  const currentData = safeStringify(node.data, 4000)

  return `你是一名工作流修复专家。当前 DAG 工作流中的一个节点执行失败，请分析错误原因并给出修复动作。

## 节点信息
- ID: ${node.id}
- 类型: ${nodeType}
- 名称: ${node.data.label || node.id}
- 已尝试次数: ${attempts}

## 当前节点配置
\`\`\`json
${currentData}
\`\`\`

## 节点类型规范
${buildNodeSpecHint(nodeType)}

## 失败错误
\`\`\`
${error.message}
\`\`\`

## 上游节点输出（可用于判断输入数据是否正确）
\`\`\`json
${serializeValue(upstreamOutputs)}
\`\`\`

## 最近执行日志
\`\`\`
${executionLog.slice(-30).join('\n')}
\`\`\`

## 可用修复动作
- retry: 仅重试，不修改配置。适用于临时网络/超时/后端瞬时错误。
- mutate: 修改节点 data 配置后重试。请提供完整的新配置片段，会合并到现有 node.data 中。
- skip: 跳过该节点，继续执行后续节点。仅在失败节点对最终结果无关键影响时使用。
- escalate: 无法自动修复，停止工作流并上报给用户。

## 输出要求
仅输出一个 JSON 对象，不要包含任何解释文本、markdown 标记或代码块：
\`\`\`json
{
  "action": "retry" | "mutate" | "skip" | "escalate",
  "reason": "简短说明",
  "newConfig": { /* action 为 mutate 时必填，会合并到 node.data */ }
}
\`\`\`

注意：
1. 若 action 为 mutate，newConfig 只包含需要修改的字段，会深度合并到当前 node.data（嵌套对象如 tool/llm/databaseQuery 等只需给出要改的字段）。
2. 对于 SQL 类错误，优先修正 query/sql 中的语法、类型、字段名或日期格式。
3. 对于 Tool 调用错误，检查 toolName 和 args 是否符合后端工具签名。
4. 对于 create_pptx_document / create_excel_document / create_word_document 等文档生成节点，如果错误提示"未引用上游数据"，必须在 python_code 中通过 \${steps.<上游节点ID>} 读取上游数据；若上游输出是包装对象（如 { data: [...] }），请使用 json.loads('''\${steps.<上游节点ID>}''').get('data', []) 取得数组后再生成图表/表格。
5. 如果错误是 NameError: name 'true' is not defined（或 'false' / 'null'），说明 python_code 中直接硬编码了 JSON 字面量。请用 mutate 动作，把硬编码的 JSON 对象替换为 \${steps.<上游节点ID>} 占位符，并在代码中用 json.loads('''\${steps.<上游节点ID>}''') 读取后再使用字段。
6. 不要编造不存在的表名或工具名；如无法确定，请选择 escalate。
7. 保持配置中的 \${...} 模板表达式不变，除非它明显是错误来源。
8. 对于 create_pptx_document / create_excel_document / create_word_document，**严禁把上游数据直接硬编码/内联到 python_code 中**；务必使用 \${steps.<上游节点ID>} 占位符，并在 Python 中用 json.loads 读取后使用。python_code 长度超过 5 万字符会被拒绝执行。`
}

export function parseRepairDecision(raw: string): RepairDecision {
  const trimmed = raw.trim()
  let jsonText = trimmed

  // 尝试从 markdown 代码块中提取 JSON
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1].trim()
  }

  // 尝试从文本中提取第一个 { ... }
  if (!jsonText.startsWith('{')) {
    const braceMatch = trimmed.match(/\{[\s\S]*\}/)
    if (braceMatch) {
      jsonText = braceMatch[0]
    }
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('LLM 返回的修复决策不是 JSON 对象')
    }
    const obj = parsed as Record<string, unknown>
    const action = String(obj.action || '')
    if (!['retry', 'mutate', 'skip', 'escalate'].includes(action)) {
      throw new Error(`未知的修复动作: ${action}`)
    }
    const decision: RepairDecision = {
      action: action as RepairAction,
      reason: String(obj.reason || '未提供原因'),
    }
    if (decision.action === 'mutate') {
      if (!obj.newConfig || typeof obj.newConfig !== 'object') {
        throw new Error('mutate 动作必须提供 newConfig 对象')
      }
      decision.newConfig = obj.newConfig as Partial<Record<string, unknown>>
    }
    return decision
  } catch (err) {
    const message = err instanceof Error ? err.message : '解析失败'
    throw new Error(`无法解析 LLM 修复决策: ${message}\n原始输出: ${raw.slice(0, 500)}`)
  }
}

function deepMergeNodeData(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMergeNodeData(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>
      )
    } else {
      result[key] = value
    }
  }
  return result
}

export function applyNodeDataPatch(
  node: DagNode,
  patch: Partial<Record<string, unknown>>
): DagNode {
  return {
    ...node,
    data: deepMergeNodeData(node.data as Record<string, unknown>, patch) as DagNode['data'],
  }
}

export function createRepairRecord(
  nodeId: string,
  decision: RepairDecision
): RepairRecord {
  return {
    nodeId,
    action: decision.action,
    reason: decision.reason,
    config: decision.newConfig,
    appliedAt: Date.now(),
  }
}

export function collectUpstreamOutputs(
  workflow: { edges: { source: string; target: string }[] },
  nodeId: string,
  ctx: DagExecutionContext
): Record<string, unknown> {
  const outputs: Record<string, unknown> = {}
  const visited = new Set<string>()
  const queue = [nodeId]

  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)

    const upstreamEdges = workflow.edges.filter((e) => e.target === id)
    for (const edge of upstreamEdges) {
      const value = ctx.nodeOutputs.get(edge.source)
      if (value !== undefined) {
        outputs[edge.source] = value
      }
      queue.push(edge.source)
    }
  }

  return outputs
}

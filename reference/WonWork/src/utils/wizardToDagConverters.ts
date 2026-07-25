/**
 * 旧版向导式工作流 (MESCLI WorkflowStep) → DAG 工作流 转换器
 *
 * 说明：这是一个最佳 effort 迁移适配器，将旧版 step-by-step 会话式工作流
 * 映射为可编辑的 DAG。Form/SearchSelect 等需要人工交互的步骤会被转换为
 * 占位节点，用户可在 DAG 编辑器中进一步替换为 LLM/WebBridge/HTTP 等自动化节点。
 */

import type {
  DagWorkflow,
  DagNode,
  DagEdge,
  DagNodeData,
  NodePosition,
} from '@/types/dagWorkflow'
import type { WorkflowStep, WorkflowField } from '@/types/mescli'

function generateId(prefix = 'node'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

const SPACING_X = 300
const SPACING_Y = 150

function position(index: number, branch = 0): NodePosition {
  return { x: index * SPACING_X, y: branch * SPACING_Y }
}

function createStartNode(): DagNode {
  return {
    id: 'start',
    type: 'start',
    position: position(0),
    data: { label: 'Start' },
  }
}

function createEndNode(index: number): DagNode {
  return {
    id: 'end',
    type: 'end',
    position: position(index),
    data: { label: 'End' },
  }
}

function createDefaultData(label: string): DagNodeData {
  return { label, onError: 'stop', maxRetries: 0 }
}

function fieldToDefaultValue(field: WorkflowField): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue
  switch (field.type) {
    case 'Number':
    case 'Decimal':
      return field.min ?? 0
    case 'Checkbox':
      return false
    case 'Date':
    case 'DateTime':
      return new Date().toISOString().slice(0, 10)
    default:
      return ''
  }
}

function convertFormStep(step: WorkflowStep, index: number): { nodes: DagNode[]; edges: DagEdge[] } {
  const nodes: DagNode[] = []
  const edges: DagEdge[] = []

  // Form 步骤映射为 JavaScript 节点，返回字段默认值对象
  // 用户后续可替换为 LLM 抽取、WebBridge 表单填写等真实自动化节点
  const fieldDefaults: Record<string, unknown> = {}
  ;(step.fields || []).forEach((field) => {
    fieldDefaults[field.id] = fieldToDefaultValue(field)
  })

  const code = `// 原始 Form 步骤：${step.name}\n// 字段：${(step.fields || []).map((f) => f.name).join(', ')}\nreturn ${JSON.stringify(fieldDefaults, null, 2)}`

  const node: DagNode = {
    id: generateId('form'),
    type: 'javascript',
    position: position(index),
    data: {
      ...createDefaultData(step.name || 'Form'),
      javascript: { code },
      description: step.prompt,
    },
  }

  nodes.push(node)
  return { nodes, edges }
}

function convertChoiceStep(step: WorkflowStep, index: number): { nodes: DagNode[]; edges: DagEdge[] } {
  // Choice 步骤映射为 condition 节点，判断 variables[stepId] 是否匹配首个选项
  const firstOption = step.options?.[0]
  const expression = firstOption
    ? `variables['${step.id}'] === '${firstOption.value}'`
    : 'true'

  const node: DagNode = {
    id: generateId('choice'),
    type: 'condition',
    position: position(index),
    data: {
      ...createDefaultData(step.name || 'Choice'),
      condition: { conditionExpression: expression },
      description: step.prompt,
    },
  }

  const edges: DagEdge[] = []
  if (step.options && step.options.length >= 2) {
    edges.push({
      id: generateId('edge'),
      source: node.id,
      target: '', // 占位，将在链式连接时填充
      label: 'true',
      type: 'condition',
    })
    edges.push({
      id: generateId('edge'),
      source: node.id,
      target: '', // 占位
      label: 'false',
      type: 'condition',
    })
  }

  return { nodes: [node], edges }
}

function convertSearchSelectStep(step: WorkflowStep, index: number): { nodes: DagNode[]; edges: DagEdge[] } {
  // SearchSelect 映射为 HTTP 请求占位节点，用户后续可替换为真实搜索 API
  const node: DagNode = {
    id: generateId('search'),
    type: 'http_request',
    position: position(index),
    data: {
      ...createDefaultData(step.name || 'Search'),
      httpRequest: {
        url: `https://example.com/api/search/${step.searchTool || 'default'}`,
        method: 'GET',
        headers: '{}',
        body: '',
        timeout: 30000,
      },
      description: step.prompt || `SearchSelect: ${step.searchTool}`,
    },
  }

  return { nodes: [node], edges: [] }
}

function convertConfirmStep(step: WorkflowStep, index: number): { nodes: DagNode[]; edges: DagEdge[] } {
  // Confirm 映射为 condition 节点，默认判断 variables[stepId] !== false
  const node: DagNode = {
    id: generateId('confirm'),
    type: 'condition',
    position: position(index),
    data: {
      ...createDefaultData(step.name || 'Confirm'),
      condition: { conditionExpression: `variables['${step.id}'] !== false` },
      description: step.prompt || step.summaryTemplate,
    },
  }

  return {
    nodes: [node],
    edges: [
      {
        id: generateId('edge'),
        source: node.id,
        target: '',
        label: 'true',
        type: 'condition',
      },
      {
        id: generateId('edge'),
        source: node.id,
        target: '',
        label: 'false',
        type: 'condition',
      },
    ],
  }
}

function convertResultStep(step: WorkflowStep, index: number): { nodes: DagNode[]; edges: DagEdge[] } {
  // Result 映射为 send_message 节点，输出结果
  const node: DagNode = {
    id: generateId('result'),
    type: 'send_message',
    position: position(index),
    data: {
      ...createDefaultData(step.name || 'Result'),
      sendMessage: {
        channel: 'log',
        title: step.name,
        content: step.prompt || '工作流执行完成',
      },
      description: step.prompt,
    },
  }

  return { nodes: [node], edges: [] }
}

function convertStep(step: WorkflowStep, index: number): { nodes: DagNode[]; edges: DagEdge[] } {
  switch (step.type) {
    case 'Form':
      return convertFormStep(step, index)
    case 'Choice':
      return convertChoiceStep(step, index)
    case 'SearchSelect':
      return convertSearchSelectStep(step, index)
    case 'Confirm':
      return convertConfirmStep(step, index)
    case 'Result':
      return convertResultStep(step, index)
    default:
      // 未知类型映射为 JavaScript 占位节点
      return {
        nodes: [
          {
            id: generateId('step'),
            type: 'javascript',
            position: position(index),
            data: {
              ...createDefaultData(step.name || step.type),
              javascript: { code: `// 原始步骤类型：${step.type}\nreturn null` },
              description: step.prompt,
            },
          },
        ],
        edges: [],
      }
  }
}

export function wizardWorkflowToDag(
  workflowCode: string,
  workflowName: string,
  steps: WorkflowStep[]
): Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'> {
  const nodes: DagNode[] = [createStartNode()]
  const edges: DagEdge[] = []
  const stepNodes: DagNode[] = []

  steps.forEach((step, index) => {
    const { nodes: convertedNodes, edges: convertedEdges } = convertStep(step, index + 1)
    stepNodes.push(...convertedNodes)
    nodes.push(...convertedNodes)
    edges.push(...convertedEdges)
  })

  nodes.push(createEndNode(steps.length + 1))

  // 连接 start -> first step -> ... -> end
  if (stepNodes.length > 0) {
    edges.push({
      id: generateId('edge'),
      source: 'start',
      target: stepNodes[0].id,
    })

    for (let i = 0; i < stepNodes.length - 1; i++) {
      edges.push({
        id: generateId('edge'),
        source: stepNodes[i].id,
        target: stepNodes[i + 1].id,
      })
    }

    edges.push({
      id: generateId('edge'),
      source: stepNodes[stepNodes.length - 1].id,
      target: 'end',
    })
  } else {
    edges.push({
      id: generateId('edge'),
      source: 'start',
      target: 'end',
    })
  }

  return {
    name: workflowName || workflowCode,
    description: `从向导式工作流 ${workflowCode} 迁移生成的 DAG 工作流`,
    version: '1.0.0',
    nodes,
    edges,
  }
}

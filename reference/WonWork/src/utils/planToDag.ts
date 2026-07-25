import type {
  DagWorkflow,
  DagNode,
  DagEdge,
  ExecutionPlan,
  ExecutionPlanStep,
  DagNodeData,
  DagNodeType,
} from '@/types/dagWorkflow'
import { createDefaultDagNodeData } from '@/types/dagWorkflow'

const SPACING_X = 300
const SPACING_Y = 150

function buildToolNodeData(step: Extract<ExecutionPlanStep, { kind: 'tool' }>): Partial<DagNodeData> {
  return {
    label: step.toolName,
    description: step.description,
    tool: {
      toolName: step.toolName,
      args: JSON.stringify(step.inputs, null, 2),
    },
  }
}

function buildSubWorkflowNodeData(step: Extract<ExecutionPlanStep, { kind: 'workflow' }>): Partial<DagNodeData> {
  return {
    label: step.description || step.workflowId,
    description: step.description,
    subWorkflow: {
      workflowId: step.workflowId,
      inputs: JSON.stringify(step.inputs, null, 2),
    },
  }
}

function buildNodeNodeData(step: Extract<ExecutionPlanStep, { kind: 'node' }>): Partial<DagNodeData> {
  const defaults = createDefaultDagNodeData(step.nodeType)
  return {
    ...defaults,
    label: step.description || defaults.label,
    description: step.description,
    ...step.config,
  }
}

function stepToNode(step: ExecutionPlanStep, index: number): DagNode {
  let data: Partial<DagNodeData>
  let type: DagNodeType

  switch (step.kind) {
    case 'tool':
      type = 'tool'
      data = buildToolNodeData(step)
      break
    case 'workflow':
      type = 'sub_workflow'
      data = buildSubWorkflowNodeData(step)
      break
    case 'node':
    default:
      type = step.nodeType
      data = buildNodeNodeData(step)
      break
  }

  return {
    id: step.id,
    type,
    position: { x: (index + 1) * SPACING_X, y: 0 },
    data: data as DagNodeData,
  }
}

export function planToDag(plan: ExecutionPlan): Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'> {
  const nodes: DagNode[] = []
  const edges: DagEdge[] = []

  const startNode: DagNode = {
    id: 'start',
    type: 'start',
    position: { x: 0, y: 0 },
    data: { label: 'Start' },
  }
  nodes.push(startNode)

  const stepNodes = plan.steps.map((step, index) => stepToNode(step, index))
  nodes.push(...stepNodes)

  const endNode: DagNode = {
    id: 'end',
    type: 'end',
    position: { x: (plan.steps.length + 1) * SPACING_X, y: 0 },
    data: { label: 'End' },
  }
  nodes.push(endNode)

  // 顺序连线
  const orderedIds = ['start', ...plan.steps.map((s) => s.id), 'end']
  for (let i = 0; i < orderedIds.length - 1; i++) {
    const source = orderedIds[i]
    const target = orderedIds[i + 1]
    edges.push({
      id: `e-${source}-${target}`,
      source,
      target,
      type: 'default',
    })
  }

  return {
    name: plan.name,
    description: plan.description,
    version: '1.0.0',
    nodes,
    edges,
    inputSchema: plan.inputSchema,
    outputMapping: plan.outputMapping,
  }
}

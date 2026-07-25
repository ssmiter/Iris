/**
 * WebBridge 顺序工作流与 DAG 工作流之间的转换工具
 * 支持线性链、条件分支的双向转换
 */

import type { DagWorkflow, DagNode, DagEdge, DagNodeData } from '@/types/dagWorkflow'
import type { WorkflowDefinition, WorkflowStep, BrowserAction } from '@/types/webbridge'

function generateId(prefix = 'id'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function buildStepNodeData(step: WorkflowStep): DagNodeData {
  return {
    label: step.description || 'WebBridge Step',
    description: step.description,
    onError: (step.on_error === 'fallback' ? undefined : step.on_error) as DagNodeData['onError'],
    maxRetries: step.max_retries,
    webbridge: {
      actions: step.actions || [],
    },
  }
}

export function webbridgeWorkflowToDag(
  wf: WorkflowDefinition,
  options?: { stepSpacingX?: number; stepSpacingY?: number }
): DagWorkflow {
  const spacingX = options?.stepSpacingX ?? 300
  const spacingY = options?.stepSpacingY ?? 150

  const startId = 'start'
  const endId = 'end'

  const nodes: DagNode[] = [
    {
      id: startId,
      type: 'start',
      position: { x: 0, y: 0 },
      data: { label: 'Start' },
    },
  ]
  const edges: DagEdge[] = []

  const steps = wf.steps || []
  let currentX = spacingX
  let prevId = startId

  steps.forEach((step) => {
    const stepId = step.step_id || generateId('step')

    if (step.condition) {
      const conditionId = generateId('condition')
      nodes.push({
        id: conditionId,
        type: 'condition',
        position: { x: currentX, y: 0 },
        data: {
          label: 'Condition',
          condition: { conditionExpression: step.condition },
        },
      })
      edges.push({ id: `e-${prevId}-${conditionId}`, source: prevId, target: conditionId })

      nodes.push({
        id: stepId,
        type: 'webbridge',
        position: { x: currentX + spacingX, y: -spacingY * 0.5 },
        data: buildStepNodeData(step),
      })
      edges.push({
        id: `e-${conditionId}-${stepId}`,
        source: conditionId,
        target: stepId,
        type: 'condition',
        label: 'true',
      })

      const skipId = generateId('skip')
      nodes.push({
        id: skipId,
        type: 'merge',
        position: { x: currentX + spacingX, y: spacingY * 0.5 },
        data: { label: 'Skip' },
      })
      edges.push({
        id: `e-${conditionId}-${skipId}`,
        source: conditionId,
        target: skipId,
        type: 'condition',
        label: 'false',
      })
      edges.push({
        id: `e-${stepId}-${skipId}`,
        source: stepId,
        target: skipId,
      })

      prevId = skipId
      currentX += spacingX * 1.5
    } else {
      nodes.push({
        id: stepId,
        type: 'webbridge',
        position: { x: currentX, y: 0 },
        data: buildStepNodeData(step),
      })
      edges.push({ id: `e-${prevId}-${stepId}`, source: prevId, target: stepId })
      prevId = stepId
      currentX += spacingX
    }
  })

  nodes.push({
    id: endId,
    type: 'end',
    position: { x: currentX, y: 0 },
    data: { label: 'End' },
  })
  edges.push({ id: `e-${prevId}-${endId}`, source: prevId, target: endId })

  const now = new Date().toISOString()
  return {
    id: generateId('dag'),
    name: wf.name,
    description: wf.description,
    version: '1.0.0',
    nodes,
    edges,
    securityPolicy: wf.security_policy,
    createdAt: now,
    updatedAt: now,
  }
}

export function dagToWebbridgeWorkflow(dag: DagWorkflow): WorkflowDefinition | null {
  const startNode = dag.nodes.find((n) => n.type === 'start')
  if (!startNode) return null

  const nodeMap = new Map(dag.nodes.map((n) => [n.id, n]))
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()

  for (const edge of dag.edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, [])
    if (!incoming.has(edge.target)) incoming.set(edge.target, [])
    outgoing.get(edge.source)!.push(edge.target)
    incoming.get(edge.target)!.push(edge.source)
  }

  const steps: WorkflowStep[] = []
  const visited = new Set<string>()
  let current: DagNode | undefined = startNode

  while (current) {
    if (current.type === 'end') break

    if (current.type === 'webbridge') {
      if (visited.has(current.id)) break
      visited.add(current.id)

      const conditionSources = (incoming.get(current.id) || [])
        .map((id) => nodeMap.get(id))
        .filter((n): n is DagNode => !!n)
      const conditionNode = conditionSources.find((n) => n.type === 'condition')

      steps.push({
        step_id: current.id,
        description: current.data.label || 'WebBridge Step',
        actions: current.data.webbridge?.actions || ([] as BrowserAction[]),
        condition: conditionNode?.data.condition?.conditionExpression,
        on_error: current.data.onError as WorkflowStep['on_error'],
        max_retries: current.data.maxRetries,
      })
    }

    const nextIds = outgoing.get(current.id) || []
    if (nextIds.length === 0) break

    if (nextIds.length === 1) {
      current = nodeMap.get(nextIds[0])
      continue
    }

    // 多分支：优先走 true/condition 边，跳过 false/merge 分支
    const trueEdge = dag.edges.find(
      (e) => e.source === current!.id && nextIds.includes(e.target) && (e.label === 'true' || e.type === 'condition')
    )
    const trueTarget = trueEdge?.target ?? nextIds[0]
    current = nodeMap.get(trueTarget)
  }

  return {
    id: generateId('wf'),
    name: dag.name,
    description: dag.description,
    workflow_type: 'custom',
    steps,
    security_policy: dag.securityPolicy,
    version: '1.0.0',
  }
}

export function dagToWebbridgeWorkflowV2(dag: DagWorkflow): WorkflowDefinition | null {
  return dagToWebbridgeWorkflow(dag)
}

export function webbridgeWorkflowToDagV2(
  wf: WorkflowDefinition,
  options?: { stepSpacingX?: number; stepSpacingY?: number }
): DagWorkflow {
  return webbridgeWorkflowToDag(wf, options)
}

import type { ExecutionPlan, ExecutionPlanStep } from '@/types/dagWorkflow'
import { DAG_NODE_TYPES } from '@/types/dagWorkflow'
import type { CapabilityCatalog } from './capabilityCatalog'
import { sqlValidationResultsToIssues, type PlanValidationState } from './sqlValidator'

export interface PlanValidationIssue {
  stepId?: string
  field: string
  message: string
  suggestedFix?: string
}

const VARIABLE_REF_REGEX = /\$\{([^}]+)\}/g

function collectStepIds(steps: ExecutionPlanStep[]): Set<string> {
  return new Set(steps.map((s) => s.id))
}

function collectVariableRefs(value: unknown): string[] {
  const refs: string[] = []
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let match: RegExpExecArray | null
  while ((match = VARIABLE_REF_REGEX.exec(text)) !== null) {
    refs.push(match[1].trim())
  }
  return refs
}

function validateVariableRef(
  ref: string,
  plan: ExecutionPlan,
  stepIds: Set<string>,
  stepId?: string
): PlanValidationIssue | null {
  if (ref.startsWith('inputs.')) {
    const inputName = ref.slice('inputs.'.length)
    if (!plan.inputSchema || !(inputName in plan.inputSchema)) {
      return {
        stepId,
        field: ref,
        message: `引用了未定义的输入变量 \${${ref}}`,
        suggestedFix: `在 inputSchema 中定义 "${inputName}"，或改为已存在的输入变量`,
      }
    }
    return null
  }

  if (ref.startsWith('steps.')) {
    const rest = ref.slice('steps.'.length)
    const [targetStepId] = rest.split('.')
    if (!stepIds.has(targetStepId)) {
      return {
        stepId,
        field: ref,
        message: `引用了不存在的步骤 \${${ref}}`,
        suggestedFix: `确认步骤 id "${targetStepId}" 存在，或使用正确的步骤 id`,
      }
    }
    return null
  }

  // 允许 variables.xxx，但不做强校验
  if (ref.startsWith('variables.')) {
    return null
  }

  return {
    stepId,
    field: ref,
    message: `不支持的变量引用格式 \${${ref}}`,
    suggestedFix: '使用 \${inputs.xxx} 或 \${steps.<stepId>.<field>}',
  }
}

export function validateExecutionPlanAgainstCatalog(
  plan: ExecutionPlan,
  catalog: CapabilityCatalog
): { valid: boolean; issues: PlanValidationIssue[] } {
  const issues: PlanValidationIssue[] = []
  const stepIds = collectStepIds(plan.steps)
  const toolNames = new Set(catalog.tools.map((t) => t.name))
  const workflowIds = new Set(catalog.workflows.map((w) => w.id))

  for (const step of plan.steps) {
    const add = (field: string, message: string, suggestedFix?: string) =>
      issues.push({ stepId: step.id, field, message, suggestedFix })

    switch (step.kind) {
      case 'tool': {
        if (!step.toolName.trim()) {
          add('toolName', 'Tool 步骤必须指定 toolName')
        } else if (!toolNames.has(step.toolName)) {
          add(
            'toolName',
            `Tool "${step.toolName}" 不在可用工具目录中`,
            `从可用工具中选择：${Array.from(toolNames).slice(0, 10).join(', ')}${toolNames.size > 10 ? '...' : ''}`
          )
        }

        const tool = catalog.tools.find((t) => t.name === step.toolName)
        if (tool && tool.parameters && typeof tool.parameters === 'object') {
          const params = tool.parameters as Record<string, { type?: string; description?: string; enum?: unknown[]; required?: boolean }>
          const schema = (tool.parameters as { required?: string[] }).required
          const required = Array.isArray(schema) ? schema : []
          for (const key of required) {
            if (!(key in step.inputs)) {
              add(`inputs.${key}`, `Tool "${step.toolName}" 缺少必填参数 "${key}"`, `在 inputs 中添加 "${key}": "\${inputs.xxx}"`)
            }
          }
        }
        break
      }

      case 'workflow': {
        if (!step.workflowId.trim()) {
          add('workflowId', 'Workflow 步骤必须指定 workflowId')
        } else if (!workflowIds.has(step.workflowId)) {
          add(
            'workflowId',
            `Workflow "${step.workflowId}" 不在已保存工作流目录中`,
            `从已保存工作流中选择：${Array.from(workflowIds).slice(0, 10).join(', ')}${workflowIds.size > 10 ? '...' : ''}`
          )
        }
        break
      }

      case 'node': {
        if (!DAG_NODE_TYPES.includes(step.nodeType)) {
          add('nodeType', `节点类型 "${step.nodeType}" 不合法`, `可用类型：${DAG_NODE_TYPES.join(', ')}`)
        }
        break
      }
    }

    // 校验变量引用
    const refs = step.kind === 'node' ? collectVariableRefs(step.config) : collectVariableRefs(step.inputs)
    for (const ref of refs) {
      const issue = validateVariableRef(ref, plan, stepIds, step.id)
      if (issue) issues.push(issue)
    }
  }

  // 校验 outputMapping
  for (const [outputName, stepId] of Object.entries(plan.outputMapping)) {
    if (!stepIds.has(stepId)) {
      issues.push({
        field: `outputMapping.${outputName}`,
        message: `outputMapping.${outputName} 引用了不存在的步骤 "${stepId}"`,
      })
    }
  }

  return { valid: issues.length === 0, issues }
}

export function mergePlanValidationIssues(
  catalogIssues: PlanValidationIssue[],
  structuralIssues: Array<{ stepId?: string; field: string; message: string }>,
  sqlState: PlanValidationState
): PlanValidationIssue[] {
  const structuralAsPlanIssues: PlanValidationIssue[] = structuralIssues.map((i) => ({
    stepId: i.stepId,
    field: i.field,
    message: i.message,
  }))
  const sqlIssues = sqlValidationResultsToIssues(sqlState)
  return [...structuralAsPlanIssues, ...catalogIssues, ...sqlIssues]
}

import type { DagWorkflow, ExecutionPlan } from '@/types/dagWorkflow'
import { IS_STANDALONE } from '@/api/client'
import { buildCapabilityCatalog, type CapabilityCatalog } from './capabilityCatalog'
import {
  buildExecutionPlanPrompt,
  type DagIntent,
} from './intentToDag'
import {
  generateExecutionPlan,
  validateExecutionPlan,
  type ExecutionPlanValidationIssue,
  type ExecutionPlanFeedbackItem,
} from './naturalLanguageToDag'
import { validateExecutionPlanAgainstCatalog, mergePlanValidationIssues, type PlanValidationIssue } from './planValidator'
import {
  validateSqlSteps,
  buildSchemaContextForPrompt,
  buildSkippedSqlState,
  type PlanValidationState,
} from './sqlValidator'
import { planToDag } from './planToDag'
import { runExecutionPlanInSandbox, type SandboxResult } from './dagSandboxExecutor'

export interface DagWorkflowGenerationState {
  intent: DagIntent
  systemCode?: string
  catalog?: CapabilityCatalog
  plan?: ExecutionPlan
  structuralIssues: ExecutionPlanValidationIssue[]
  catalogIssues: PlanValidationIssue[]
  sqlState: PlanValidationState
  sandboxResult?: SandboxResult
  dryRunStatus: 'pending' | 'running' | 'passed' | 'failed' | 'skipped'
  retryCount: number
  maxRetries: number
  status: 'idle' | 'discovering' | 'planning' | 'validating' | 'refining' | 'completed' | 'failed'
  error?: string
}

export interface GenerationResult {
  plan: ExecutionPlan
  dag: Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'>
  structuralIssues: ExecutionPlanValidationIssue[]
  catalogIssues: PlanValidationIssue[]
  sqlState: PlanValidationState
  sandboxResult?: SandboxResult
  dryRunStatus: DagWorkflowGenerationState['dryRunStatus']
  allIssues: PlanValidationIssue[]
}

export interface RunAgentOptions {
  systemCode?: string
  maxRetries?: number
  skipSqlValidation?: boolean
  onStatusChange?: (state: DagWorkflowGenerationState) => void
}

function createInitialState(intent: DagIntent, options: RunAgentOptions): DagWorkflowGenerationState {
  return {
    intent,
    systemCode: options.systemCode,
    structuralIssues: [],
    catalogIssues: [],
    sqlState: { sqlResults: [], overallSqlValid: true },
    dryRunStatus: 'pending',
    retryCount: 0,
    maxRetries: options.maxRetries ?? 3,
    status: 'idle',
  }
}

function emitStatus(
  state: DagWorkflowGenerationState,
  onStatusChange?: (state: DagWorkflowGenerationState) => void
) {
  onStatusChange?.({ ...state })
}

async function discoverCapabilities(
  state: DagWorkflowGenerationState,
  onStatusChange?: (state: DagWorkflowGenerationState) => void
): Promise<void> {
  state.status = 'discovering'
  emitStatus(state, onStatusChange)
  state.catalog = await buildCapabilityCatalog(state.systemCode)
}

async function generatePlan(
  state: DagWorkflowGenerationState,
  feedbackHistory: ExecutionPlanFeedbackItem[] = [],
  onStatusChange?: (state: DagWorkflowGenerationState) => void
): Promise<void> {
  if (!state.catalog) {
    throw new Error('Capability catalog 未加载')
  }
  state.status = 'planning'
  emitStatus(state, onStatusChange)

  const prompt = buildExecutionPlanPrompt(state.intent, state.catalog)
  state.plan = await generateExecutionPlan(prompt, feedbackHistory, {
    maxRetries: 0, // Agent 自己控制重试
    timeoutMs: 120000,
  })
}

async function validateStructure(state: DagWorkflowGenerationState): Promise<void> {
  if (!state.plan) {
    throw new Error('ExecutionPlan 未生成')
  }
  const result = validateExecutionPlan(state.plan)
  state.structuralIssues = result.issues
}

async function validateAgainstCatalog(state: DagWorkflowGenerationState): Promise<void> {
  if (!state.plan || !state.catalog) {
    throw new Error('ExecutionPlan 或 Catalog 未生成')
  }
  const result = validateExecutionPlanAgainstCatalog(state.plan, state.catalog)
  state.catalogIssues = result.issues
}

async function validateSql(
  state: DagWorkflowGenerationState,
  skipSqlValidation?: boolean,
  onStatusChange?: (state: DagWorkflowGenerationState) => void
): Promise<void> {
  if (!state.plan) {
    throw new Error('ExecutionPlan 未生成')
  }

  if (skipSqlValidation || IS_STANDALONE) {
    state.sqlState = buildSkippedSqlState(state.plan)
    return
  }

  state.status = 'validating'
  state.sqlState = await validateSqlSteps(state.plan, { systemCode: state.systemCode })
}

async function runSandboxValidation(
  state: DagWorkflowGenerationState,
  onStatusChange?: (state: DagWorkflowGenerationState) => void
): Promise<void> {
  if (!state.plan) {
    throw new Error('ExecutionPlan 未生成')
  }

  state.dryRunStatus = 'running'
  emitStatus(state, onStatusChange)

  const sandboxResult = await runExecutionPlanInSandbox(state.plan, {
    timeoutMs: 30000,
    llmTimeoutMs: 5000,
  })

  state.sandboxResult = sandboxResult

  if (!sandboxResult.harmless) {
    state.dryRunStatus = 'skipped'
  } else if (sandboxResult.success) {
    state.dryRunStatus = 'passed'
  } else {
    state.dryRunStatus = 'failed'
  }

  emitStatus(state, onStatusChange)
}

function buildFeedbackForRetry(state: DagWorkflowGenerationState): string | null {
  const parts: string[] = []

  if (state.structuralIssues.length > 0) {
    parts.push('执行计划存在结构问题：')
    parts.push(
      state.structuralIssues
        .map((i) => `[${i.stepId ?? 'plan'}:${i.field}] ${i.message}`)
        .join('\n')
    )
  }

  if (state.catalogIssues.length > 0) {
    parts.push('\n执行计划与可用能力目录不匹配：')
    parts.push(
      state.catalogIssues
        .map((i) => `[${i.stepId ?? 'plan'}:${i.field}] ${i.message}${i.suggestedFix ? `（建议：${i.suggestedFix}）` : ''}`)
        .join('\n')
    )
  }

  if (!state.sqlState.overallSqlValid) {
    parts.push('\n' + buildSchemaContextForPrompt(state.sqlState))
  }

  if (state.dryRunStatus === 'failed' && state.sandboxResult?.error) {
    parts.push('\n沙箱试运行失败：')
    parts.push(state.sandboxResult.error)
    if (state.sandboxResult.logs.length > 0) {
      parts.push('\n沙箱日志：')
      parts.push(
        state.sandboxResult.logs
          .map((l) => `[${l.level.toUpperCase()}] ${l.nodeId ? `[${l.nodeId}] ` : ''}${l.message}`)
          .join('\n')
      )
    }
  }

  if (parts.length === 0) return null

  parts.push('\n请修正以上问题后重新输出完整 JSON，只输出 JSON，不要解释。')
  return parts.join('\n')
}

async function refinePlan(
  state: DagWorkflowGenerationState,
  previousOutput: string,
  feedbackHistory: ExecutionPlanFeedbackItem[],
  onStatusChange?: (state: DagWorkflowGenerationState) => void
): Promise<void> {
  state.status = 'refining'
  emitStatus(state, onStatusChange)

  const feedback = buildFeedbackForRetry(state)
  if (!feedback) return

  feedbackHistory.push({ previousOutput, feedback })
  state.retryCount++
}

function instantiateDag(state: DagWorkflowGenerationState): Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'> {
  if (!state.plan) {
    throw new Error('ExecutionPlan 未生成')
  }
  return planToDag(state.plan)
}

function mergeAllIssues(state: DagWorkflowGenerationState): PlanValidationIssue[] {
  return mergePlanValidationIssues(state.catalogIssues, state.structuralIssues, state.sqlState)
}

export async function runDagWorkflowGenerationAgent(
  intent: DagIntent,
  options: RunAgentOptions = {}
): Promise<GenerationResult> {
  const state = createInitialState(intent, options)
  const feedbackHistory: ExecutionPlanFeedbackItem[] = []
  let lastRawOutput = ''

  try {
    await discoverCapabilities(state, options.onStatusChange)

    while (state.retryCount <= state.maxRetries) {
      try {
        await generatePlan(state, feedbackHistory, options.onStatusChange)
        lastRawOutput = JSON.stringify(state.plan, null, 2)
        state.error = undefined
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        state.error = `生成计划失败（尝试 ${state.retryCount + 1}/${state.maxRetries + 1}）：${message}`
        emitStatus(state, options.onStatusChange)
        if (state.retryCount >= state.maxRetries) {
          state.status = 'failed'
          throw err
        }
        state.retryCount++
        continue
      }

      await validateStructure(state)
      await validateAgainstCatalog(state)
      await validateSql(state, options.skipSqlValidation, options.onStatusChange)
      await runSandboxValidation(state, options.onStatusChange)

      const hasIssues =
        state.structuralIssues.length > 0 ||
        state.catalogIssues.length > 0 ||
        !state.sqlState.overallSqlValid ||
        state.dryRunStatus === 'failed'

      if (!hasIssues) {
        state.status = 'completed'
        emitStatus(state, options.onStatusChange)
        const dag = instantiateDag(state)
        return {
          plan: state.plan!,
          dag,
          structuralIssues: state.structuralIssues,
          catalogIssues: state.catalogIssues,
          sqlState: state.sqlState,
          sandboxResult: state.sandboxResult,
          dryRunStatus: state.dryRunStatus,
          allIssues: mergeAllIssues(state),
        }
      }

      if (state.retryCount >= state.maxRetries) {
        break
      }

      await refinePlan(state, lastRawOutput, feedbackHistory, options.onStatusChange)
    }

    state.status = 'failed'
    const allIssues = mergeAllIssues(state)
    const detail = allIssues.map((i) => `[${i.stepId ?? 'plan'}:${i.field}] ${i.message}`).join('\n')
    state.error = `经过 ${state.maxRetries + 1} 次尝试仍未生成可用工作流：\n${detail}`
    emitStatus(state, options.onStatusChange)
    throw new Error(state.error)
  } catch (err) {
    state.status = 'failed'
    state.error = err instanceof Error ? err.message : String(err)
    emitStatus(state, options.onStatusChange)
    throw err
  }
}

import type { ExecutionPlan, ExecutionPlanStep } from '@/types/dagWorkflow'
import type { PlanValidationIssue } from '@/utils/planValidator'
import type { PlanValidationState, SqlValidationResult } from '@/utils/sqlValidator'
import type { SandboxResult } from '@/utils/dagSandboxExecutor'
import { cn } from '@/utils'
import { Wand2, AlertCircle, CheckCircle2, Layers, Puzzle, GitBranch, Loader2, XCircle, SkipForward } from 'lucide-react'

interface ExecutionPlanPreviewProps {
  plan: ExecutionPlan
  issues?: PlanValidationIssue[]
  sqlValidationState?: PlanValidationState
  dryRunStatus?: 'pending' | 'running' | 'passed' | 'failed' | 'skipped'
  sandboxResult?: SandboxResult
  onConfirm: () => void
  onCancel: () => void
  isGenerating?: boolean
}

function StepIcon({ kind }: { kind: ExecutionPlanStep['kind'] }) {
  switch (kind) {
    case 'tool':
      return <Puzzle size={16} />
    case 'workflow':
      return <Layers size={16} />
    case 'node':
      return <GitBranch size={16} />
  }
}

function SqlValidationBadge({ result }: { result?: SqlValidationResult }) {
  if (!result) return null
  const { status } = result
  const labels: Record<typeof status, string> = {
    pending: 'SQL 待验证',
    validating: 'SQL 验证中',
    valid: 'SQL 已验证',
    invalid: 'SQL 验证失败',
    skipped: 'SQL 未验证(Standalone)',
  }
  return (
    <span className={cn(
      'text-xs px-1.5 py-0.5 rounded-full',
      status === 'valid' && 'bg-green-100 text-green-700',
      status === 'invalid' && 'bg-red-100 text-red-700',
      status === 'validating' && 'bg-yellow-100 text-yellow-700',
      status === 'pending' && 'bg-surface-100 text-surface-500',
      status === 'skipped' && 'bg-surface-100 text-surface-500'
    )}>
      {labels[status]}
    </span>
  )
}

function DryRunBadge({ status }: { status?: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' }) {
  if (!status || status === 'pending') return null

  const config: Record<
    Exclude<typeof status, 'pending'>,
    { label: string; icon: typeof Loader2; className: string }
  > = {
    running: { label: '沙箱试运行中', icon: Loader2, className: 'bg-yellow-100 text-yellow-700' },
    passed: { label: '沙箱试运行通过', icon: CheckCircle2, className: 'bg-green-100 text-green-700' },
    failed: { label: '沙箱试运行失败', icon: XCircle, className: 'bg-red-100 text-red-700' },
    skipped: { label: '跳过沙箱（含副作用节点）', icon: SkipForward, className: 'bg-surface-100 text-surface-500' },
  }

  const { label, icon: Icon, className } = config[status]
  const isRunning = status === 'running'

  return (
    <span className={cn('flex items-center gap-1 text-xs px-2 py-1 rounded-full', className)}>
      <Icon size={14} className={cn(isRunning && 'animate-spin')} />
      {label}
    </span>
  )
}

interface StepCardProps {
  step: ExecutionPlanStep
  index: number
  sqlValidation?: SqlValidationResult
}

function StepCard({ step, index, sqlValidation }: StepCardProps) {
  return (
    <div className="flex items-start gap-3 p-3 bg-surface-50 rounded-lg border border-surface-200">
      <span className="flex-none w-6 h-6 flex items-center justify-center rounded-full bg-primary-100 text-primary-700 text-xs font-medium">
        {index + 1}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-surface-500"><StepIcon kind={step.kind} /></span>
          <span className="text-sm font-medium text-surface-900 truncate">{step.description || step.id}</span>
          <span className={cn(
            'text-xs px-1.5 py-0.5 rounded-full',
            step.kind === 'tool' && 'bg-violet-100 text-violet-700',
            step.kind === 'workflow' && 'bg-emerald-100 text-emerald-700',
            step.kind === 'node' && 'bg-surface-200 text-surface-700'
          )}>
            {step.kind === 'tool' && `tool: ${step.toolName}`}
            {step.kind === 'workflow' && `workflow: ${step.workflowId}`}
            {step.kind === 'node' && `node: ${step.nodeType}`}
          </span>
          {step.kind === 'node' && step.nodeType === 'database_query' && <SqlValidationBadge result={sqlValidation} />}
        </div>
        {step.kind !== 'node' && Object.keys(step.inputs).length > 0 && (
          <pre className="mt-2 text-xs text-surface-600 bg-white p-2 rounded border border-surface-200 overflow-auto">
            {JSON.stringify(step.inputs, null, 2)}
          </pre>
        )}
        {step.kind === 'node' && Object.keys(step.config).length > 0 && (
          <pre className="mt-2 text-xs text-surface-600 bg-white p-2 rounded border border-surface-200 overflow-auto">
            {JSON.stringify(step.config, null, 2)}
          </pre>
        )}
        {sqlValidation?.status === 'invalid' && sqlValidation.executionError && (
          <p className="mt-2 text-xs text-red-600">{sqlValidation.executionError}</p>
        )}
      </div>
    </div>
  )
}

export function ExecutionPlanPreview({
  plan,
  issues,
  sqlValidationState,
  dryRunStatus,
  sandboxResult,
  onConfirm,
  onCancel,
  isGenerating,
}: ExecutionPlanPreviewProps) {
  const sqlResultByStepId = new Map(sqlValidationState?.sqlResults.map((r) => [r.stepId, r]) || [])
  const hasInvalidSql = sqlValidationState?.sqlResults.some((r) => r.status === 'invalid') ?? false
  const hasPendingSql = sqlValidationState?.sqlResults.some((r) => r.status === 'validating' || r.status === 'pending') ?? false
  const dryRunFailed = dryRunStatus === 'failed'

  return (
    <div className="flex flex-col h-full bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-surface-200 bg-surface-50">
        <div className="flex items-center gap-2">
          <Wand2 size={18} className="text-purple-600" />
          <h3 className="font-semibold text-surface-900">AI 生成的执行计划</h3>
          <DryRunBadge status={dryRunStatus} />
        </div>
        <p className="text-xs text-surface-500 mt-1">{plan.description}</p>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-3">
        {dryRunFailed && sandboxResult?.error && (
          <div className="p-3 bg-red-50 rounded-lg border border-red-100">
            <div className="flex items-center gap-2 text-red-800 text-sm font-medium">
              <XCircle size={16} />
              沙箱试运行失败
            </div>
            <p className="mt-2 text-xs text-red-700">{sandboxResult.error}</p>
            {sandboxResult.logs.length > 0 && (
              <div className="mt-2 text-xs text-red-600 bg-white p-2 rounded border border-red-100 max-h-40 overflow-auto">
                {sandboxResult.logs.map((log, idx) => (
                  <div key={idx} className="font-mono">
                    [{log.level.toUpperCase()}] {log.nodeId ? `[${log.nodeId}] ` : ''}{log.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {plan.steps.map((step, index) => (
          <StepCard key={step.id} step={step} index={index} sqlValidation={sqlResultByStepId.get(step.id)} />
        ))}

        {Object.keys(plan.inputSchema).length > 0 && (
          <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
            <div className="flex items-center gap-2 text-blue-800 text-sm font-medium">
              <CheckCircle2 size={16} />
              输入变量
            </div>
            <ul className="mt-2 space-y-1 text-xs text-blue-700">
              {Object.entries(plan.inputSchema).map(([name, schema]) => (
                <li key={name}>
                  {name} ({schema.type})
                  {schema.required && <span className="text-red-500 ml-1">*</span>}
                  {schema.description && <span className="text-surface-500 ml-1">— {schema.description}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {Object.keys(plan.outputMapping).length > 0 && (
          <div className="p-3 bg-green-50 rounded-lg border border-green-100">
            <div className="flex items-center gap-2 text-green-800 text-sm font-medium">
              <CheckCircle2 size={16} />
              输出映射
            </div>
            <ul className="mt-2 space-y-1 text-xs text-green-700">
              {Object.entries(plan.outputMapping).map(([name, stepId]) => (
                <li key={name}>
                  {name} → {stepId}
                </li>
              ))}
            </ul>
          </div>
        )}
        {issues && issues.length > 0 && (
          <div className="p-3 bg-red-50 rounded-lg border border-red-100">
            <div className="flex items-center gap-2 text-red-800 text-sm font-medium">
              <AlertCircle size={16} />
              校验问题（请返回修改提示词或到编辑器中手动修正）
            </div>
            <ul className="mt-2 space-y-1 text-xs text-red-700">
              {issues.map((issue, idx) => (
                <li key={idx}>
                  {issue.stepId ? `[${issue.stepId}] ` : ''}{issue.field}: {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex-none px-4 py-3 border-t border-surface-200">
        <p className="text-xs text-surface-500 mb-2 text-right">确认后将自动保存工作流并进入编辑器</p>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={isGenerating}
            className="px-4 py-2 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={isGenerating || hasPendingSql || hasInvalidSql || dryRunFailed || (issues ? issues.length > 0 : false)}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {isGenerating ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Wand2 size={16} />
            )}
            确认并保存
          </button>
        </div>
      </div>
    </div>
  )
}

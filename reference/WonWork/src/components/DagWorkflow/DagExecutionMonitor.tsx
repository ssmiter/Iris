import { useDagWorkflowStore } from '@/stores/dagWorkflowStore'
import { useDagExecutionQueueStore } from '@/stores/dagExecutionQueueStore'
import { cn } from '@/utils'
import { RotateCcw, Play, X } from 'lucide-react'

function formatDuration(ms?: number): string {
  if (!ms) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function statusLabel(status: string): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'paused':
      return '已暂停'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default:
      return status
  }
}

export function DagExecutionMonitor() {
  const { executionContext, isExecuting } = useDagWorkflowStore()
  const queue = useDagExecutionQueueStore()
  const workflow = useDagWorkflowStore((s) =>
    s.activeWorkflowId ? s.workflows.find((w) => w.id === s.activeWorkflowId) : undefined
  )

  const workflowRuns = workflow ? queue.getRunsByWorkflow(workflow.id) : []
  const currentRun = queue.activeRunId ? queue.getRun(queue.activeRunId) : undefined

  if (!executionContext && workflowRuns.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-surface-400">
        暂无执行记录
      </div>
    )
  }

  const ctx = executionContext
  const duration = ctx?.endTime
    ? ctx.endTime - ctx.startTime
    : ctx
      ? Date.now() - ctx.startTime
      : undefined

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="px-4 py-3 border-b border-surface-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {ctx && (
            <>
              <span
                className={cn(
                  'w-2 h-2 rounded-full',
                  ctx.status === 'running' && 'bg-blue-500 animate-pulse',
                  ctx.status === 'paused' && 'bg-amber-500',
                  ctx.status === 'completed' && 'bg-green-500',
                  ctx.status === 'failed' && 'bg-red-500',
                  ctx.status === 'cancelled' && 'bg-surface-400'
                )}
              />
              <span className="text-sm font-medium text-surface-800">{statusLabel(ctx.status)}</span>
            </>
          )}
          {!ctx && currentRun && (
            <span className="text-sm font-medium text-surface-800">{statusLabel(currentRun.status)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {ctx?.status === 'paused' && (
            <>
              <button
                onClick={() => useDagWorkflowStore.getState().resumeWorkflow()}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-primary-50 hover:bg-primary-100 text-primary-600 rounded transition-colors"
              >
                <Play size={12} /> 继续
              </button>
              <button
                onClick={() => useDagWorkflowStore.getState().stopWorkflow()}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-red-50 hover:bg-red-100 text-red-600 rounded transition-colors"
              >
                <X size={12} /> 取消
              </button>
            </>
          )}
          {ctx?.status === 'failed' && (
            <button
              onClick={() => useDagWorkflowStore.getState().retryWorkflow()}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-orange-50 hover:bg-orange-100 text-orange-600 rounded transition-colors"
            >
              <RotateCcw size={12} /> 重试
            </button>
          )}
          <span className="text-xs text-surface-500">耗时 {formatDuration(duration)}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {ctx?.error && (
          <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">
            {ctx.error}
          </div>
        )}

        {workflowRuns.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-surface-700 mb-2">执行队列</h4>
            <div className="space-y-1">
              {workflowRuns.slice(0, 5).map((run) => (
                <div
                  key={run.id}
                  className={cn(
                    'flex items-center justify-between px-2 py-1.5 rounded-lg text-xs border',
                    queue.activeRunId === run.id
                      ? 'bg-primary-50 border-primary-200'
                      : 'bg-surface-50 border-surface-100'
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={cn(
                        'w-1.5 h-1.5 rounded-full flex-shrink-0',
                        run.status === 'running' && 'bg-blue-500',
                        run.status === 'paused' && 'bg-amber-500',
                        run.status === 'completed' && 'bg-green-500',
                        run.status === 'failed' && 'bg-red-500',
                        run.status === 'cancelled' && 'bg-surface-400'
                      )}
                    />
                    <span className="text-surface-600 truncate">
                      {new Date(run.updatedAt).toLocaleTimeString()} · {statusLabel(run.status)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {run.status === 'paused' && (
                      <button
                        onClick={() => {
                          useDagExecutionQueueStore.getState().setActiveRun(run.id)
                          useDagWorkflowStore.getState().resumeWorkflow()
                        }}
                        className="p-1 hover:bg-primary-100 text-primary-600 rounded"
                        title="继续"
                      >
                        <Play size={12} />
                      </button>
                    )}
                    {run.status === 'failed' && (
                      <button
                        onClick={() => {
                          useDagExecutionQueueStore.getState().setActiveRun(run.id)
                          useDagWorkflowStore.getState().retryWorkflow()
                        }}
                        className="p-1 hover:bg-orange-100 text-orange-600 rounded"
                        title="重试"
                      >
                        <RotateCcw size={12} />
                      </button>
                    )}
                    {(run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') && (
                      <button
                        onClick={() => {
                          useDagExecutionQueueStore.getState().setActiveRun(run.id)
                          const ctx = useDagExecutionQueueStore.getState().getRun(run.id)
                          if (ctx) {
                            useDagWorkflowStore.setState({
                              executionContext: {
                                workflowId: ctx.workflowId,
                                runId: ctx.id,
                                inputs: ctx.inputs,
                                variables: ctx.variables,
                                nodeOutputs: new Map(Object.entries(ctx.nodeOutputs)),
                                logs: ctx.logs,
                                status: ctx.status,
                                currentNodeIds: ctx.pendingNodeIds,
                                startTime: ctx.startTime,
                                endTime: ctx.endTime,
                                error: ctx.error,
                              },
                            })
                          }
                        }}
                        className="p-1 hover:bg-surface-200 text-surface-500 rounded"
                        title="查看"
                      >
                        查看
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <h4 className="text-xs font-semibold text-surface-700 mb-2">节点输出</h4>
          <div className="space-y-1">
            {ctx && Array.from(ctx.nodeOutputs.entries()).map(([nodeId, output]) => (
              <div key={nodeId} className="p-2 bg-surface-50 rounded-lg border border-surface-100">
                <span className="text-xs font-medium text-surface-700">{nodeId}</span>
                <pre className="mt-1 text-[10px] text-surface-500 overflow-x-auto font-mono">
                  {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
                </pre>
              </div>
            ))}
            {(!ctx || ctx.nodeOutputs.size === 0) && (
              <p className="text-xs text-surface-400">暂无输出</p>
            )}
          </div>
        </div>

        <div>
          <h4 className="text-xs font-semibold text-surface-700 mb-2">执行日志</h4>
          <div className="space-y-1">
            {ctx?.logs.map((log, idx) => (
              <div
                key={idx}
                className={cn(
                  'px-2 py-1 rounded text-[11px] font-mono',
                  log.level === 'error' && 'bg-red-50 text-red-700',
                  log.level === 'warn' && 'bg-amber-50 text-amber-700',
                  log.level === 'info' && 'bg-surface-50 text-surface-600'
                )}
              >
                <span className="opacity-60">{new Date(log.timestamp).toLocaleTimeString()}</span>{' '}
                [{log.nodeId}] {log.message}
              </div>
            ))}
            {(!ctx || ctx.logs.length === 0) && (
              <p className="text-xs text-surface-400">暂无日志</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

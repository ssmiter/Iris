import { useMemo, useState } from 'react'
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Pause,
} from 'lucide-react'
import type { TaskActivityView, TaskView } from '@/api/irisApi'
import { cn } from '@/lib/cn'

interface TaskBlackboardProps {
  tasks: TaskView[]
}

const phaseCopy: Record<
  TaskView['phase'],
  { label: string; tone: string }
> = {
  active: { label: '正在推进', tone: 'text-info' },
  blocked: { label: '需要你协助', tone: 'text-warning' },
  paused: { label: '已暂停', tone: 'text-ink-muted' },
  completed: { label: '已完成', tone: 'text-success' },
  cancelled: { label: '已取消', tone: 'text-ink-muted' },
}

function PhaseIcon({ phase }: { phase: TaskView['phase'] }) {
  const className = 'h-4 w-4 shrink-0'
  if (phase === 'blocked') return <CircleAlert className={className} />
  if (phase === 'paused') return <Pause className={className} />
  if (phase === 'completed') return <CircleCheck className={className} />
  return <CircleDot className={className} />
}

const terminalRunPhases = new Set([
  'succeeded',
  'failed',
  'cancelled',
])

function activityState(
  activity: TaskActivityView,
  taskPhase: TaskView['phase'],
) {
  if (!terminalRunPhases.has(activity.phase)) {
    return { label: '分头处理中', tone: 'text-info' }
  }
  if (activity.failure || activity.phase !== 'succeeded') {
    return taskPhase === 'blocked'
      ? { label: '卡点已确认', tone: 'text-warning' }
      : { label: 'Iris 正在处理卡点', tone: 'text-warning' }
  }
  return { label: '结果已返回，等待核验', tone: 'text-success' }
}

export function TaskBlackboard({ tasks }: TaskBlackboardProps) {
  const task = useMemo(
    () =>
      [...tasks]
        .filter((item) =>
          item.phase === 'active'
          || item.phase === 'blocked'
          || item.phase === 'paused',
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0],
    [tasks],
  )
  const [disclosure, setDisclosure] = useState({
    taskId: '',
    expanded: false,
  })

  if (!task) return null

  const expanded = disclosure.taskId === task.taskId
    && disclosure.expanded

  const completed = task.steps.filter(
    (step) => step.status === 'completed' || step.status === 'skipped',
  ).length
  const progress = task.steps.length > 0
    ? `${completed}/${task.steps.length}`
    : null
  const copy = phaseCopy[task.phase]
  const detailItems = task.pendingDecisions.length > 0
    ? task.pendingDecisions
    : task.nextActions
  const detailLabel = task.pendingDecisions.length > 0
    ? '需要确认'
    : '接下来'
  const activities = task.activities ?? []
  const latestActivity = activities[0]
  const latestActivityState = latestActivity
    ? activityState(latestActivity, task.phase)
    : null

  return (
    <section
      aria-label="当前任务状态"
      className="relative z-10 shrink-0 bg-canvas/92 backdrop-blur-md"
    >
      <div className="mx-auto w-full max-w-[var(--conversation-max)] px-[var(--conversation-pad)] pt-2">
        <button
          type="button"
          aria-expanded={expanded}
          className="group flex w-full items-center gap-2 rounded-sm px-1.5 py-2 text-left transition-colors duration-fast hover:bg-surface-muted/55 focus-visible:outline-none focus-visible:shadow-focus"
          onClick={() => setDisclosure({
            taskId: task.taskId,
            expanded: !expanded,
          })}
        >
          <span className={cn('flex items-center gap-1.5 text-caption font-medium', copy.tone)}>
            <PhaseIcon phase={task.phase} />
            {copy.label}
          </span>
          <span className="min-w-0 flex-1 truncate text-small text-ink-subtle">
            {task.currentFocus || task.summary || task.objective}
          </span>
          {task.pendingDecisions.length > 0 && (
            <span className="shrink-0 text-caption text-warning">
              {task.pendingDecisions.length} 项待确认
            </span>
          )}
          {latestActivityState && task.pendingDecisions.length === 0 && (
            <span className={cn(
              'hidden shrink-0 text-caption sm:inline',
              latestActivityState.tone,
            )}>
              {latestActivityState.label}
            </span>
          )}
          {progress && (
            <span className="shrink-0 tabular-nums text-caption text-ink-muted">
              {progress}
            </span>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'h-4 w-4 shrink-0 text-ink-muted transition-transform duration-fold ease-flow',
              expanded && 'rotate-180',
            )}
          />
        </button>

        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-fold ease-flow',
            expanded
              ? 'grid-rows-[1fr] opacity-100'
              : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="overflow-hidden">
            <div className="pb-3 pl-7 pr-7">
              <p className="text-caption font-medium text-ink-muted">
                {detailLabel}
              </p>
              {detailItems.length > 0 ? (
                <ul className="mt-1.5 space-y-1 text-small leading-relaxed text-ink-subtle">
                  {detailItems.map((item) => (
                    <li key={item} className="flex gap-2">
                      <span aria-hidden="true" className="mt-[0.65em] h-1 w-1 shrink-0 rounded-full bg-border-strong" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-small text-ink-muted">
                  Iris 正在根据当前状态收敛下一步。
                </p>
              )}
              {task.blockers.length > 0 && task.pendingDecisions.length === 0 && (
                <p className="mt-2 text-caption text-warning">
                  卡点：{task.blockers.join('；')}
                </p>
              )}
              {activities.length > 0 && (
                <div className="mt-3">
                  <p className="text-caption font-medium text-ink-muted">
                    后台工作
                  </p>
                  <ul className="mt-1.5 space-y-2">
                    {activities.slice(0, 3).map((activity) => {
                      const state = activityState(activity, task.phase)
                      const outcome = activity.failure?.message
                        || activity.summary
                      return (
                        <li key={activity.runId} className="min-w-0">
                          <div className="flex items-baseline gap-2 text-small">
                            <span className={cn(
                              'shrink-0 text-caption font-medium',
                              state.tone,
                            )}>
                              {state.label}
                            </span>
                            <span className="min-w-0 truncate text-ink-subtle">
                              {activity.purpose}
                            </span>
                          </div>
                          {outcome && (
                            <p className="mt-0.5 line-clamp-2 text-caption leading-relaxed text-ink-muted">
                              {outcome}
                            </p>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

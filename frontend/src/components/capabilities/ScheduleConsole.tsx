import { useEffect, useState, type FormEvent } from 'react'
import { Play, Plus, Trash2 } from 'lucide-react'
import {
  scheduleApi,
  type ScheduleDraft,
  type ScheduleExecutionView,
  type ScheduleView,
} from '@/api/irisApi'
import { Badge, Button, Input, notify } from '@/components/ui'
import { EditorHeading, EnableSwitch, QuietState, TextArea } from './controls'

const emptySchedule: ScheduleDraft = {
  name: '',
  expression: '',
  prompt: '',
  enabled: true,
}

function formatInstant(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
}

/**
 * 定时任务控制台（DB 真相，docs/33 §3）：统一能力页的子视图，
 * 沿用 MemoryConsole 模式。能力树只投影启用件（kind=schedule），
 * 这里管理全部任务；每次触发产生的会话是结果的去处，不另造结果存储。
 */
export function ScheduleConsole({ onBack }: { onBack: () => void }) {
  const [schedules, setSchedules] = useState<ScheduleView[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<ScheduleView | undefined | null>(null)

  const reload = () => {
    scheduleApi
      .list()
      .then(setSchedules)
      .catch((error: Error) =>
        notify.error('定时任务暂时不可用', { description: error.message }),
      )
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    scheduleApi
      .list()
      .then((next) => !cancelled && setSchedules(next))
      .catch((error: Error) =>
        !cancelled &&
        notify.error('定时任务暂时不可用', { description: error.message }),
      )
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const toggleSchedule = async (schedule: ScheduleView) => {
    setBusyId(schedule.taskId)
    setSchedules((items) =>
      items.map((item) =>
        item.taskId === schedule.taskId
          ? { ...item, enabled: !schedule.enabled }
          : item,
      ),
    )
    try {
      const updated = await scheduleApi.setEnabled(schedule, !schedule.enabled)
      setSchedules((items) => replaceBy(items, updated))
    } catch (error) {
      setSchedules((items) => replaceBy(items, schedule))
      notify.error('没有改变定时任务状态', {
        description: (error as Error).message,
      })
    } finally {
      setBusyId(null)
    }
  }

  const runNow = async (schedule: ScheduleView) => {
    setBusyId(schedule.taskId)
    try {
      const execution = await scheduleApi.runNow(schedule)
      if (execution.status === 'fired') {
        notify.success(`已为「${schedule.name}」开启新会话`, {
          description: '执行过程与结果都在对应的会话里查看。',
        })
      } else {
        notify.error('触发没有完成', {
          description: execution.error ?? '请稍后重试。',
        })
      }
      reload()
    } catch (error) {
      notify.error('触发没有完成', { description: (error as Error).message })
    } finally {
      setBusyId(null)
    }
  }

  if (editing !== null) {
    return (
      <ScheduleEditor
        current={editing}
        onCancel={() => setEditing(null)}
        onSaved={(saved, removed) => {
          setSchedules((items) =>
            removed
              ? items.filter((item) => item.taskId !== removed)
              : items.some((item) => item.taskId === saved?.taskId)
                ? replaceBy(items, saved!)
                : saved
                  ? [...items, saved]
                  : items,
          )
          setEditing(null)
        }}
      />
    )
  }

  return (
    <section className="grid gap-3">
      <EditorHeading title="定时任务" onCancel={onBack} backLabel="返回能力树" />
      <div className="flex items-start justify-between gap-5 px-1">
        <p className="text-small leading-relaxed text-ink-muted">
          到点以任务的 prompt 自动开启新会话执行；其中的写动作仍会逐次等待你的批准。启用的任务会作为叶子出现在
          /system/schedule 目录下。
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setEditing(undefined)}
        >
          <Plus className="h-3.5 w-3.5" />
          新建定时任务
        </Button>
      </div>
      {loading ? (
        <QuietState>正在读取定时任务…</QuietState>
      ) : schedules.length === 0 ? (
        <QuietState>
          还没有定时任务。也可以直接在对话里让 Iris 帮你创建。
        </QuietState>
      ) : (
        schedules.map((schedule) => (
          <article
            key={schedule.taskId}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 rounded-md px-3 py-3 transition-colors hover:bg-surface-muted"
          >
            <button
              type="button"
              className="min-w-0 text-left"
              disabled={busyId === schedule.taskId}
              onClick={() => setEditing(schedule)}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-body font-semibold text-ink">
                  {schedule.name}
                </span>
                <code className="rounded-xs bg-surface-muted px-1.5 py-0.5 text-caption text-ink-subtle">
                  {schedule.expression}
                </code>
                <Badge tone={schedule.enabled ? 'info' : 'neutral'}>
                  {schedule.enabled ? '已启用' : '已停用'}
                </Badge>
              </div>
              <p className="mt-1 line-clamp-2 text-small leading-relaxed text-ink-subtle">
                {schedule.prompt}
              </p>
              <p className="mt-1 text-caption text-ink-muted">
                {schedule.enabled
                  ? `下次触发 ${formatInstant(schedule.nextFireAt)}`
                  : '已停用，不再触发'}
                {' · '}已触发 {schedule.fireCount} 次
                {schedule.lastFireAt &&
                  ` · 上次 ${formatInstant(schedule.lastFireAt)}`}
              </p>
            </button>
            <div className="flex flex-col items-end gap-2">
              <EnableSwitch
                checked={schedule.enabled}
                disabled={busyId === schedule.taskId}
                label={`${schedule.enabled ? '停用' : '启用'} ${schedule.name}`}
                onClick={() => void toggleSchedule(schedule)}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-caption"
                disabled={busyId === schedule.taskId}
                onClick={() => void runNow(schedule)}
              >
                <Play className="h-3 w-3" />
                立即运行
              </Button>
            </div>
          </article>
        ))
      )}
    </section>
  )
}

function ScheduleEditor({
  current,
  onCancel,
  onSaved,
}: {
  current?: ScheduleView
  onCancel: () => void
  onSaved: (saved: ScheduleView | null, removedTaskId?: string) => void
}) {
  const [draft, setDraft] = useState<ScheduleDraft>(
    current
      ? {
          name: current.name,
          expression: current.expression,
          prompt: current.prompt,
          enabled: current.enabled,
        }
      : emptySchedule,
  )
  const [saving, setSaving] = useState(false)
  const [executions, setExecutions] = useState<ScheduleExecutionView[] | null>(
    null,
  )

  useEffect(() => {
    if (!current) return
    let cancelled = false
    scheduleApi
      .executions(current.taskId)
      .then((next) => !cancelled && setExecutions(next))
      .catch(() => !cancelled && setExecutions([]))
    return () => {
      cancelled = true
    }
  }, [current])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const saved = current
        ? await scheduleApi.update(current, draft)
        : await scheduleApi.create(draft)
      onSaved(saved)
    } catch (error) {
      notify.error('定时任务没有保存', {
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!current) return
    setSaving(true)
    try {
      await scheduleApi.remove(current)
      notify.success('定时任务已删除', {
        description: '已经产生的会话与执行记录仍保留在历史中。',
      })
      onSaved(null, current.taskId)
    } catch (error) {
      notify.error('定时任务没有删除', {
        description: (error as Error).message,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <EditorHeading
        title={current ? '编辑定时任务' : '新建定时任务'}
        onCancel={onCancel}
        backLabel="返回定时任务"
      />
      <Input
        label="任务名称"
        required
        value={draft.name}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        placeholder="每日晨间整理"
      />
      <Input
        label="触发表达式"
        required
        value={draft.expression}
        onChange={(event) =>
          setDraft({ ...draft, expression: event.target.value })
        }
        placeholder="0 0 9 * * *"
        description="六位 cron（秒 分 时 日 月 周），按本机时区触发。例：每天 9 点 = 0 0 9 * * *。"
      />
      <TextArea
        label="到点要做的事（prompt）"
        value={draft.prompt}
        onChange={(value) => setDraft({ ...draft, prompt: value })}
        rows={5}
        description="到点会以这段文字自动开启一个新会话执行；会话标题由标题流程自动生成。"
      />
      <label className="flex items-center gap-2 text-small text-ink">
        <EnableSwitch
          checked={draft.enabled}
          label={draft.enabled ? '创建后即启用' : '创建后保持停用'}
          onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
        />
        {draft.enabled ? '启用' : '停用'}
      </label>

      {current && (
        <div className="grid gap-1.5">
          <p className="text-caption font-semibold text-ink-muted">
            最近触发
          </p>
          {executions === null ? (
            <p className="text-small text-ink-muted">正在读取触发记录…</p>
          ) : executions.length === 0 ? (
            <p className="text-small text-ink-muted">还没有触发过。</p>
          ) : (
            <ul className="grid gap-1">
              {executions.map((execution) => (
                <li
                  key={execution.executionId}
                  className="flex flex-wrap items-center gap-2 text-caption text-ink-subtle"
                >
                  <Badge
                    tone={execution.status === 'fired' ? 'success' : 'danger'}
                  >
                    {execution.status === 'fired' ? '已触发' : '失败'}
                  </Badge>
                  <Badge appearance="outline">
                    {execution.triggerKind === 'manual' ? '手动' : '到点'}
                  </Badge>
                  <span>{formatInstant(execution.firedAt)}</span>
                  {execution.error && (
                    <span className="text-danger">{execution.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div>
          {current && (
            <Button
              variant="ghost"
              size="sm"
              className="text-danger"
              isLoading={saving}
              onClick={() => void remove()}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" isLoading={saving} loadingLabel="正在保存">
            保存定时任务
          </Button>
        </div>
      </div>
    </form>
  )
}

function replaceBy(items: ScheduleView[], value: ScheduleView) {
  return items.map((item) => (item.taskId === value.taskId ? value : item))
}

import { useTranslation } from 'react-i18next'
import { useState, useCallback, useEffect, useMemo, memo } from 'react'
import { cn } from '@/utils'
import { useCronSchedulerStore } from '@/stores/cronSchedulerStore'
import { cronApi } from '@/api/client'
import type { CronTask, CronTaskResult, TaskExecutionMode, TaskPayload } from '@/types/cron'
import { humanReadableCron, validateCron } from '@/types/cron'
import { generateCronFromNaturalLanguage, getNextRunTimes } from '@/utils/naturalLanguageToCron'
import { Bot, Wand2, Loader2, CalendarClock, Clock } from 'lucide-react'

/**
 * 定时页（2026-08-08 温润卡片式重写，以 MCP 能力房丝滑四原则为验收基准）。
 *
 * 产品语义：这不是 cron 管理台，是「让它按时做的事」的清单——
 * 主对话里可以用工具定时（cron_create），这里是管理面。
 * 因此页面上不出现「执行模式 / Payload / Cron 表达式」等技术概念：
 * - 主路径=agent_prompt（统一 agent 闭环，结果落库为会话，行内可直达）
 * - 调度说人话（humanReadableCron 中文），cron 原文只在展开的详情里以 mono 小字出现
 * - 其余执行方式不新建（agent_swarm 已废弃；llm_prompt 等后端遗产模式存量任务
 *   照常展示与编辑，详情里标注）
 *
 * 四原则落点：
 * - 即时反应：启停=乐观开关（store 内回滚）；删除=两段确认+退场动画落完才调 API
 * - 几何连续：骨架行首载；表单/详情=wf-collapse 收展；删除=wf-row-leave 收高
 * - 诚实：执行历史拉后端 executions 表真数据；骨架是占位非假数据
 * - 安静：全组件窄选择器；模式图标只在非主路径出现
 */

const MODE_LABEL_KEYS: Record<string, string> = {
  llm_prompt: 'cronScheduler.cronSchedulerView.modeLlmPrompt',
  webbridge: 'cronScheduler.cronSchedulerView.modeWebBridge',
  code_exec: 'cronScheduler.cronSchedulerView.modeCodeExec',
  agent_swarm: 'cronScheduler.cronSchedulerView.modeAgentSwarm',
  notification: 'cronScheduler.cronSchedulerView.modeNotification',
  agent_prompt: 'cronScheduler.cronSchedulerView.modeAgentPrompt',
}

/** 快捷时间：最常见的四档，chips 一点即填（生成式输入之外的零成本路径） */
const QUICK_SCHEDULES = [
  { key: 'hourly', cron: '0 * * * *' },
  { key: 'daily9', cron: '0 9 * * *' },
  { key: 'weekday9', cron: '0 9 * * 1-5' },
  { key: 'monday9', cron: '0 9 * * 1' },
] as const

function formatTime(iso?: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

function formatShort(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return '{}'
  }
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

export interface CronSchedulerViewProps {
  /** 执行结果落库为会话时，行内「查看结果」直达该会话（MainLayout 接线） */
  onOpenConversation?: (conversationId: number) => void
}

/** r309 合并导师：从执行结果文本解析落库会话 id（后端 execution-report 回写格式） */
function conversationIdFromResult(output?: string): number | null {
  if (!output) return null
  const match = output.match(/(?:会话\s*#|conversation(?:\s+id)?\s*[:#]?\s*)(\d+)/i)
  if (!match) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function CronSchedulerView({ onOpenConversation }: CronSchedulerViewProps) {
  const { t } = useTranslation()
  const tasks = useCronSchedulerStore((s) => s.tasks)
  const loading = useCronSchedulerStore((s) => s.loading)
  const error = useCronSchedulerStore((s) => s.error)

  const [showCreate, setShowCreate] = useState(false)

  useEffect(() => {
    const store = useCronSchedulerStore.getState()
    store.loadTasks()
  }, [])

  const firstLoad = loading && tasks.length === 0
  // 任务卡无固有宽度（居中列），双列网格必然高度相等——用分栏卡片错位开
  // （[三/二] + [一/三]，偶数列回归整排），视觉像瀑布而非整齐格子
  const colA = tasks.filter((_, i) => i % 2 === 0)
  const colB = tasks.filter((_, i) => i % 2 === 1)

  return (
    <div className="wf-cron">
      <div className="wf-cron-scroll">
        <div className="wf-cron-col">
          {/* 头部：单色图标块 + 标题+一句说明，右侧新建 CTA（全流程唯一实心蓝） */}
          <div className="wf-cron-head wf-cronpg-head">
            <span className="wf-cronpg-head-ic">
              <Clock size={20} />
            </span>
            <div className="wf-cronpg-head-tx">
              <h1 className="wf-cron-title">{t('cronScheduler.cronSchedulerView.title')}</h1>
              <p className="wf-cron-sub">{t('cronScheduler.cronSchedulerView.subtitle')}</p>
            </div>
            <button className="wf-cta wf-cron-new wf-press" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? t('cronScheduler.cronSchedulerView.cancel') : t('cronScheduler.cronSchedulerView.newTask')}
            </button>
          </div>

          {error && (
            <div className="wf-cron-err">
              <span className="flex-1 min-w-0">{error}</span>
              <button
                className="wf-mini-btn wf-press"
                onClick={() => useCronSchedulerStore.getState().clearError()}
              >
                {t('cronScheduler.cronSchedulerView.dismiss')}
              </button>
            </div>
          )}

          {/* 新建卡：收展不断几何（wf-collapse）；createwrap 给阴影留 padding 缓冲
              （collapse-inner 的 overflow:hidden 裁剪在 padding box 外缘） */}
          <div className={cn('wf-collapse', !showCreate && 'wf-collapsed')}>
            <div className="wf-collapse-inner">
              <div className="wf-cron-createwrap">{showCreate && <CreateCard onDone={() => setShowCreate(false)} />}</div>
            </div>
          </div>

          {firstLoad && (
            <div className="wf-cron-cols">
              <div>
                <div className="wf-skel-row" />
                <div className="wf-skel-row" />
              </div>
              <div>
                <div className="wf-skel-row" />
              </div>
            </div>
          )}

          {!firstLoad && tasks.length === 0 && (
            <div className="wf-cron-empty">
              <span className="wf-cron-empty-ic">
                <CalendarClock size={22} />
              </span>
              <p className="t">{t('cronScheduler.cronSchedulerView.noTasks')}</p>
              <p className="h">{t('cronScheduler.cronSchedulerView.createHint')}</p>
              <button className="wf-cta wf-press" onClick={() => setShowCreate(true)}>
                {t('cronScheduler.cronSchedulerView.newTask')}
              </button>
            </div>
          )}

          {!firstLoad && tasks.length > 0 && (
            <div className="wf-cron-cols">
              <div className="wf-cron-col-list">
                {colA.map((task) => (
                  <TaskCard key={task.id} id={task.id} onOpenConversation={onOpenConversation} />
                ))}
              </div>
              <div className="wf-cron-col-list">
                {colB.map((task) => (
                  <TaskCard key={task.id} id={task.id} onOpenConversation={onOpenConversation} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ───────────────────────────── 新建卡 ─────────────────────────────

function CreateCard({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()

  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [whenText, setWhenText] = useState('')
  const [cron, setCron] = useState('0 9 * * 1-5')
  const [once, setOnce] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const cronValid = useMemo(() => validateCron(cron), [cron])
  const nextPreview = useMemo(() => (cronValid ? getNextRunTimes(cron, once ? 1 : 3) : []), [cron, cronValid, once])

  const handleGenerate = useCallback(async () => {
    if (!whenText.trim() || generating) return
    setGenerating(true)
    setGenError(null)
    try {
      const result = await generateCronFromNaturalLanguage(whenText.trim())
      setCron(result.expression)
      setWhenText('')
    } catch (err) {
      setGenError(err instanceof Error ? err.message : t('cron.generateFailed'))
    } finally {
      setGenerating(false)
    }
  }, [whenText, generating])

  const canCreate = prompt.trim().length > 0 && cronValid

  const handleCreate = useCallback(async () => {
    if (!canCreate || creating) return
    setCreating(true)
    try {
      const payload: TaskPayload = {
        execution_mode: 'agent_prompt',
        prompt: prompt.trim(),
        ...(once ? { once: true } : {}),
      }
      const created = await useCronSchedulerStore.getState().createTask({
        // 名字可留空：取任务内容前 16 字，少一道必填门槛
        name: name.trim() || prompt.trim().slice(0, 16) || t('cronScheduler.cronSchedulerView.newTask'),
        task_type: once ? 'one_time' : 'recurring',
        cron: { expression: cron.trim() },
        payload,
        is_enabled: true,
      })
      if (created) onDone()
    } finally {
      setCreating(false)
    }
  }, [canCreate, creating, prompt, once, name, cron, onDone, t])

  return (
    <div className="wf-cron-create wf-caprow">
      {/* 它要做什么——主输入，一句话说清 */}
      <span className="wf-sec-label">{t('cronScheduler.cronSchedulerView.whatToDo')}</span>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t('cronScheduler.cronSchedulerView.whatToDoPlaceholder')}
        rows={3}
        className="wf-ink-input wf-cron-prompt"
      />

      {/* 什么时候做——快捷 chips + 自然语言生成 */}
      <span className="wf-sec-label" style={{ marginTop: 14 }}>
        {t('cronScheduler.cronSchedulerView.whenToRun')}
      </span>
      <div className="wf-cron-quick">
        {QUICK_SCHEDULES.map((q) => (
          <button
            key={q.key}
            className={cn('wf-cron-chipbtn wf-press', cron === q.cron && 'on')}
            onClick={() => setCron(q.cron)}
          >
            {t(`cronScheduler.cronSchedulerView.quick.${q.key}`)}
          </button>
        ))}
      </div>
      <div className="wf-cron-gen">
        <Wand2 size={13} className="ic" />
        <input
          type="text"
          value={whenText}
          onChange={(e) => setWhenText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleGenerate()
          }}
          placeholder={t('cronScheduler.cronSchedulerView.generateCronPlaceholder')}
          className="wf-ink-input"
        />
        <button
          className="wf-mini-btn wf-press"
          onClick={handleGenerate}
          disabled={generating || !whenText.trim()}
        >
          {generating && <Loader2 size={11} className="animate-spin" />}
          {generating ? t('cronScheduler.cronSchedulerView.generating') : t('cronScheduler.cronSchedulerView.generate')}
        </button>
      </div>
      {genError && <p className="wf-cron-ferr">{genError}</p>}

      {/* 名字：可留空（取内容前 16 字） */}
      <span className="wf-sec-label" style={{ marginTop: 14 }}>
        {t('cronScheduler.cronSchedulerView.taskName')}
      </span>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('cronScheduler.cronSchedulerView.taskNamePlaceholder')}
        className="wf-ink-input"
      />

      {/* 高级：cron 原文/执行方式/单次——默认折起，技术概念不占主视觉 */}
      <button className="wf-cron-advbtn wf-press" onClick={() => setShowAdvanced((v) => !v)}>
        {t('cronScheduler.cronSchedulerView.advanced')}
        <span className={cn('wf-cron-advarrow', showAdvanced && 'open')}>▾</span>
      </button>
      <div className={cn('wf-collapse', !showAdvanced && 'wf-collapsed')}>
        <div className="wf-collapse-inner">
          <div className="wf-cron-adv">
            <span className="wf-sec-label">{t('cronScheduler.cronSchedulerView.cronExpression')}</span>
            <input
              type="text"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className={cn('wf-ink-input wf-cron-mono', !cronValid && 'invalid')}
            />
            {cronValid ? (
              <p className="wf-cron-fhint">
                {humanReadableCron(cron)}
                {nextPreview.length > 0 && ` · ${t('cronScheduler.cronSchedulerView.nextRun', { time: formatTime(nextPreview[0]) })}`}
              </p>
            ) : (
              <p className="wf-cron-ferr">{t('cronScheduler.cronSchedulerView.invalidCron')}</p>
            )}

            <div className="wf-cron-advrow">
              <div>
                <span className="wf-sec-label">{t('cronScheduler.cronSchedulerView.execMode')}</span>
                <span className="wf-chip">{t('cronScheduler.cronSchedulerView.modeAgentPrompt')}</span>
              </div>
              <label className="wf-cron-once">
                <span>{t('cronScheduler.cronSchedulerView.runOnce')}</span>
                <button
                  type="button"
                  className={cn('wf-switch wf-press', once && 'on')}
                  onClick={() => setOnce((v) => !v)}
                >
                  <span className="knob" />
                </button>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* 提交行：调度人话摘要 + 创建 */}
      <div className="wf-cron-cfoot">
        <span className="wf-cron-csummary">{cronValid ? humanReadableCron(cron) : ''}</span>
        <button className="wf-cta wf-press" onClick={handleCreate} disabled={!canCreate || creating}>
          {creating && <Loader2 size={12} className="animate-spin" />}
          {t('cronScheduler.cronSchedulerView.createTask')}
        </button>
      </div>
    </div>
  )
}

// ───────────────────────────── 任务卡 ─────────────────────────────

const TaskCard = memo(function TaskCard({ id, onOpenConversation }: { id: string } & CronSchedulerViewProps) {
  const { t } = useTranslation()
  const task = useCronSchedulerStore((s) => s.tasks.find((x) => x.id === id))
  const result = useCronSchedulerStore((s) => s.results[id])

  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [executions, setExecutions] = useState<CronTaskResult[] | null>(null)

  // 展开即拉后端 executions 表真历史（每次展开刷新，代价一次小查询）
  useEffect(() => {
    if (!expanded || editing) return
    let alive = true
    cronApi
      .getExecutions(id, 10)
      .then((list) => {
        if (alive) setExecutions(list)
      })
      .catch(() => {
        if (alive) setExecutions([])
      })
    return () => {
      alive = false
    }
  }, [expanded, editing, id, result])

  // 删除两段确认的自动解除（3s 不点第二下恢复）
  useEffect(() => {
    if (!deleteArmed) return
    const timer = setTimeout(() => setDeleteArmed(false), 3000)
    return () => clearTimeout(timer)
  }, [deleteArmed])

  const handleDelete = useCallback(() => {
    if (!deleteArmed) {
      setDeleteArmed(true)
      return
    }
    // 退场动画落完才真删（wf-row-leave 收高 380ms，列表下方行缓缓上移）
    setLeaving(true)
    setTimeout(() => {
      void useCronSchedulerStore.getState().deleteTask(id)
    }, 400)
  }, [deleteArmed, id])

  if (!task) return null

  const enabled = task.is_enabled ?? true
  const mode: TaskExecutionMode = task.payload?.execution_mode ?? 'agent_prompt'
  const running = !!task.isRunning
  const statusKey = result?.status || task.status || 'pending'
  const isOnce = task.payload?.once === true
  const humanSchedule = task.cron?.expression ? humanReadableCron(task.cron.expression) : ''
  const dotClass = running
    ? 'connecting'
    : statusKey === 'failed'
      ? 'failed'
      : enabled
        ? 'connected'
        : 'off'
  const statusWord = running
    ? t('cron.status.running')
    : !enabled
      ? t('cron.status.disabled')
      : statusKey === 'failed'
        ? t('cron.status.lastFailed')
        : null

  return (
    <div className={cn('wf-row-leave', leaving && 'leaving')}>
      <div className="wf-row-leave-inner">
        <div className={cn('wf-caprow wf-cron-card', !enabled && 'off')}>
          {editing ? (
            <EditForm task={task} onDone={() => setEditing(false)} />
          ) : (
            <>
              {/* 行头：点+名+调度人话+状态词+下次+开关 */}
              <div className="wf-list-row wf-cronpg-row wf-press" onClick={() => setExpanded((v) => !v)}>
                <span className={cn('wf-state-dot', dotClass)} />
                <div className="wf-cron-rowmain">
                  <span className="wf-cron-name">{task.name}</span>
                  <span className="wf-cron-sched">
                    {isOnce ? t('cronScheduler.cronSchedulerView.onceOnly') : humanSchedule}
                  </span>
                </div>
                {statusWord && (
                  <span className={cn('wf-cron-status', running && 'live', statusKey === 'failed' && !running && 'failed')}>
                    {statusWord}
                  </span>
                )}
                <span className="wf-cron-next">
                  {enabled && task.next_run_at ? formatShort(task.next_run_at) : ''}
                </span>
                <button
                  className={cn('wf-switch wf-press', enabled && 'on')}
                  disabled={running}
                  onClick={(e) => {
                    e.stopPropagation()
                    void useCronSchedulerStore.getState().toggleTask(id)
                  }}
                >
                  <span className="knob" />
                </button>
              </div>

              {/* 就地详情：与行同卡，虚线分隔（wf-collapse 收展） */}
              <div className={cn('wf-collapse', !expanded && 'wf-collapsed')}>
                <div className="wf-collapse-inner">
                  <div className="wf-list-detail">
                    {/* 它要做什么 */}
                    {task.payload?.prompt && (
                      <>
                        <span className="wf-sec-label">{t('cronScheduler.cronSchedulerView.whatToDo')}</span>
                        <p className="wf-cron-promptview">{task.payload.prompt}</p>
                      </>
                    )}

                    {/* 技术细节：cron 原文/非主路径模式/单次——mono 小字，不占主视觉 */}
                    <div className="wf-cron-tags">
                      {task.cron?.expression && <span className="wf-chip">{task.cron.expression}</span>}
                      {mode !== 'agent_prompt' && (
                        <span className="wf-chip">
                          <Bot size={11} />
                          {t(MODE_LABEL_KEYS[mode] ?? mode)}
                          {mode === 'agent_swarm' && ` · ${t('cronScheduler.cronSchedulerView.deprecated')}`}
                        </span>
                      )}
                      {isOnce && <span className="wf-chip">{t('cronScheduler.cronSchedulerView.onceOnly')}</span>}
                      <span className="wf-chip">
                        {t('cronScheduler.cronSchedulerView.lastRun', { time: formatTime(task.last_run_at) })}
                      </span>
                    </div>

                    {/* 动作行 */}
                    <div className="wf-cron-actions">
                      <button
                        className="wf-mini-btn wf-press"
                        disabled={running}
                        onClick={() => void useCronSchedulerStore.getState().runTask(id)}
                      >
                        {running && <Loader2 size={11} className="animate-spin" />}
                        {t('cronScheduler.cronSchedulerView.executeNow')}
                      </button>
                      {/* 会话直达：优先结构化 conversation_id，兜底从 output 文本解析（r309 导师正则） */}
                      {(() => {
                        const resultConversationId =
                          result?.conversation_id ?? conversationIdFromResult(result?.output) ?? undefined
                        return resultConversationId != null && onOpenConversation ? (
                          <button className="wf-mini-btn wf-press" onClick={() => onOpenConversation(resultConversationId)}>
                            {t('cronScheduler.cronSchedulerView.viewResult')}
                          </button>
                        ) : null
                      })()}
                      <button className="wf-mini-btn wf-press" onClick={() => setEditing(true)}>
                        {t('cronScheduler.cronSchedulerView.edit')}
                      </button>
                      <button
                        className={cn('wf-mini-btn wf-press', deleteArmed && 'armed')}
                        onClick={handleDelete}
                      >
                        {deleteArmed
                          ? t('cronScheduler.cronSchedulerView.confirmDelete')
                          : t('cronScheduler.cronSchedulerView.delete')}
                      </button>
                    </div>

                    {/* 本地最新一次的失败原因（诚实信号，立即反馈） */}
                    {result?.error_message && <p className="wf-cron-ferr">{result.error_message}</p>}

                    {/* 执行历史：后端 executions 表真数据 */}
                    <span className="wf-sec-label" style={{ marginTop: 12 }}>
                      {t('cronScheduler.cronSchedulerView.executionHistory')}
                    </span>
                    {executions === null ? (
                      <div className="wf-cron-execskel wf-skel-fade" />
                    ) : executions.length === 0 ? (
                      <p className="wf-cron-noexec">{t('cronScheduler.cronSchedulerView.noExecutions')}</p>
                    ) : (
                      <div className="wf-cron-execs">
                        {executions.map((ex, idx) => (
                          <div key={idx} className="wf-cron-exec">
                            <span className={cn('wf-state-dot', ex.status === 'completed' ? 'connected' : 'failed')} />
                            <span className="t">{formatTime(ex.triggered_at)}</span>
                            <span className={cn('s', ex.status !== 'completed' && 'failed')}>
                              {ex.status === 'completed'
                                ? t('cron.status.completed')
                                : ex.status === 'failed'
                                  ? t('cron.status.failed')
                                  : ex.status === 'cancelled'
                                    ? t('cron.status.lastInterrupted')
                                    : ex.status === 'expired'
                                      ? t('cron.status.expired')
                                      : ex.status === 'coalesced'
                                        ? t('cron.status.coalesced')
                                        : ex.status === 'pending'
                                          ? t('cron.status.pending')
                                          : ex.status === 'running'
                                            ? t('cron.status.running')
                                            : ex.status}
                            </span>
                            {ex.execution_time_ms != null && (
                              <span className="d">{(ex.execution_time_ms / 1000).toFixed(1)}s</span>
                            )}
                            {ex.error_message && <span className="e">{ex.error_message}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
})

// ───────────────────────────── 编辑表单 ─────────────────────────────

function EditForm({ task, onDone }: { task: CronTask; onDone: () => void }) {
  const { t } = useTranslation()
  const mode: TaskExecutionMode = task.payload?.execution_mode ?? 'agent_prompt'
  const isMainMode = mode === 'agent_prompt'

  const [name, setName] = useState(task.name)
  const [cron, setCron] = useState(task.cron?.expression ?? '0 9 * * *')
  const [prompt, setPrompt] = useState(task.payload?.prompt ?? '')
  // 遗产模式（llm_prompt 等）：payload 以 JSON 原文编辑，不美化不藏匿
  const [payloadJson, setPayloadJson] = useState(safeJsonStringify(task.payload ?? {}))
  const [saving, setSaving] = useState(false)

  const cronValid = useMemo(() => validateCron(cron), [cron])
  const canSave =
    name.trim().length > 0 &&
    cronValid &&
    (mode === 'agent_prompt'
      ? prompt.trim().length > 0
      : safeJsonParse(payloadJson) !== null)

  const handleSave = useCallback(async () => {
    if (!canSave || saving) return
    setSaving(true)
    try {
      let payload: TaskPayload
      if (mode === 'agent_prompt') {
        payload = {
          execution_mode: 'agent_prompt',
          prompt: prompt.trim(),
          ...(task.payload?.once ? { once: true } : {}),
        }
      } else {
        payload = { ...(safeJsonParse(payloadJson) as unknown as TaskPayload), execution_mode: mode }
      }
      const updated = await useCronSchedulerStore.getState().updateTask(task.id, {
        name: name.trim(),
        cron: { expression: cron.trim() },
        payload,
      })
      if (updated) onDone()
    } finally {
      setSaving(false)
    }
  }, [canSave, saving, mode, prompt, task, payloadJson, name, cron, onDone])

  return (
    <div className="wf-cron-edit">
      <span className="wf-sec-label">{t('cronScheduler.cronSchedulerView.taskName')}</span>
      <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="wf-ink-input" />

      <span className="wf-sec-label" style={{ marginTop: 12 }}>
        {t('cronScheduler.cronSchedulerView.whenToRun')}
      </span>
      <div className="wf-cron-quick">
        {QUICK_SCHEDULES.map((q) => (
          <button
            key={q.key}
            className={cn('wf-cron-chipbtn wf-press', cron === q.cron && 'on')}
            onClick={() => setCron(q.cron)}
          >
            {t(`cronScheduler.cronSchedulerView.quick.${q.key}`)}
          </button>
        ))}
      </div>
      <input
        type="text"
        value={cron}
        onChange={(e) => setCron(e.target.value)}
        className={cn('wf-ink-input wf-cron-mono', !cronValid && 'invalid')}
        style={{ marginTop: 8 }}
      />
      {cronValid ? (
        <p className="wf-cron-fhint">{humanReadableCron(cron)}</p>
      ) : (
        <p className="wf-cron-ferr">{t('cronScheduler.cronSchedulerView.invalidCron')}</p>
      )}

      {mode === 'agent_prompt' && (
        <>
          <span className="wf-sec-label" style={{ marginTop: 12 }}>
            {t('cronScheduler.cronSchedulerView.whatToDo')}
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="wf-ink-input wf-cron-prompt"
          />
        </>
      )}
      {!isMainMode && (
        <>
          <span className="wf-sec-label" style={{ marginTop: 12 }}>
            {t(MODE_LABEL_KEYS[mode] ?? mode)} · {t('cronScheduler.cronSchedulerView.payload')}
          </span>
          <textarea
            value={payloadJson}
            onChange={(e) => setPayloadJson(e.target.value)}
            rows={5}
            className="wf-ink-input wf-cron-mono"
          />
        </>
      )}

      <div className="wf-cron-cfoot">
        <span />
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="wf-mini-btn wf-press" onClick={onDone}>
            {t('cronScheduler.cronSchedulerView.cancelEdit')}
          </button>
          <button className="wf-cta wf-press" onClick={handleSave} disabled={!canSave || saving}>
            {saving && <Loader2 size={12} className="animate-spin" />}
            {t('cronScheduler.cronSchedulerView.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

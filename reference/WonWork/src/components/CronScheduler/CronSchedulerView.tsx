import { useTranslation } from 'react-i18next'
import { useState, useCallback, useEffect, useMemo } from 'react'
import { cn } from '@/utils'
import { useCronSchedulerStore } from '@/stores/cronSchedulerStore'
import { useDagWorkflowStore } from '@/stores/dagWorkflowStore'
import type { CronTask, TaskExecutionMode, TaskPayload } from '@/types/cron'
import { TASK_EXECUTION_MODES, CommonPresets, humanReadableCron, validateCron } from '@/types/cron'
import { generateCronFromNaturalLanguage, getNextRunTimes } from '@/utils/naturalLanguageToCron'
import {
  Calendar,
  Plus,
  Trash2,
  Play,
  Clock,
  CheckCircle2,
  XCircle,
  Bot,
  Workflow,
  Globe,
  Code,
  Users,
  Bell,
  Pencil,
  Loader2,
  GitBranch,
  Wand2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'

const MODE_ICONS: Record<TaskExecutionMode, React.ReactNode> = {
  llm_prompt: <Bot size={14} />,
  workflow: <Workflow size={14} />,
  webbridge: <Globe size={14} />,
  code_exec: <Code size={14} />,
  agent_swarm: <Users size={14} />,
  notification: <Bell size={14} />,
  dag_workflow: <GitBranch size={14} />,
}

const MODE_KEYS: Record<TaskExecutionMode, string> = {
  llm_prompt: 'cronScheduler.cronSchedulerView.modeLlmPrompt',
  workflow: 'cronScheduler.cronSchedulerView.modeWorkflow',
  webbridge: 'cronScheduler.cronSchedulerView.modeWebBridge',
  code_exec: 'cronScheduler.cronSchedulerView.modeCodeExec',
  agent_swarm: 'cronScheduler.cronSchedulerView.modeAgentSwarm',
  notification: 'cronScheduler.cronSchedulerView.modeNotification',
  dag_workflow: 'cronScheduler.cronSchedulerView.modeDagWorkflow',
}

const PRESETS = [
  { key: 'dailyStandupSummary', factory: CommonPresets.dailyStandupSummary },
  { key: 'hourlyHealthCheck', factory: CommonPresets.hourlyHealthCheck },
  { key: 'dailyNewsBriefing', factory: CommonPresets.dailyNewsBriefing },
  { key: 'weeklyReport', factory: CommonPresets.weeklyReport },
  { key: 'databaseBackupCheck', factory: CommonPresets.databaseBackupCheck },
]

function formatTime(iso?: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('zh-CN')
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return '{}'
  }
}

function safeJsonParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function CronSchedulerView() {
  const { t } = useTranslation()
  const { tasks, loading, error, loadTasks, createTask, updateTask, deleteTask, toggleTask, runTask, checkAndRunDueTasks, clearError, getTaskResult } =
    useCronSchedulerStore()

  const [showAddForm, setShowAddForm] = useState(false)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newCron, setNewCron] = useState('0 9 * * 1-5')
  const [newMode, setNewMode] = useState<TaskExecutionMode>('llm_prompt')
  const [newPayload, setNewPayload] = useState('{}')
  const [payloadError, setPayloadError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editCron, setEditCron] = useState('')
  const [editMode, setEditMode] = useState<TaskExecutionMode>('llm_prompt')
  const [editPayload, setEditPayload] = useState('{}')

  const [newDagWorkflowId, setNewDagWorkflowId] = useState('')
  const [newDagInputs, setNewDagInputs] = useState('{}')
  const [editDagWorkflowId, setEditDagWorkflowId] = useState('')
  const [editDagInputs, setEditDagInputs] = useState('{}')

  const [cronDescription, setCronDescription] = useState('')
  const [isGeneratingCron, setIsGeneratingCron] = useState(false)
  const [cronGenerateError, setCronGenerateError] = useState<string | null>(null)

  const { workflows: dagWorkflows, loadWorkflows: loadDagWorkflows } = useDagWorkflowStore()

  useEffect(() => {
    loadTasks()
    loadDagWorkflows()
  }, [loadTasks, loadDagWorkflows])

  useEffect(() => {
    const interval = setInterval(() => {
      checkAndRunDueTasks()
    }, 60000)
    return () => clearInterval(interval)
  }, [checkAndRunDueTasks])

  const cronIsValid = useMemo(() => validateCron(newCron), [newCron])
  const editCronIsValid = useMemo(() => validateCron(editCron), [editCron])
  const nextRunPreview = useMemo(() => getNextRunTimes(newCron, 5), [newCron])

  const validatePayload = (text: string): boolean => {
    try {
      JSON.parse(text)
      setPayloadError(null)
      return true
    } catch {
      setPayloadError(t('cronScheduler.cronSchedulerView.invalidPayload'))
      return false
    }
  }

  const validateDagInputs = (text: string): boolean => {
    try {
      JSON.parse(text)
      return true
    } catch {
      return false
    }
  }

  const buildDagPayload = (dagId: string, dagInputsJson: string): TaskPayload => {
    return {
      execution_mode: 'dag_workflow',
      dagWorkflowId: dagId,
      dagInputs: validateDagInputs(dagInputsJson) ? safeJsonParse(dagInputsJson) : {},
    }
  }

  const buildTaskInput = (): Omit<CronTask, 'id' | 'status' | 'created_at' | 'updated_at' | 'last_run_at' | 'next_run_at' | 'run_count'> | null => {
    if (!newName.trim() || !cronIsValid) return null

    let payload: TaskPayload
    if (newMode === 'dag_workflow') {
      if (!newDagWorkflowId || !validateDagInputs(newDagInputs)) return null
      payload = buildDagPayload(newDagWorkflowId, newDagInputs)
    } else {
      if (!validatePayload(newPayload)) return null
      payload = safeJsonParse(newPayload) as unknown as TaskPayload
      payload.execution_mode = newMode
    }

    return {
      name: newName.trim(),
      description: newDescription.trim() || undefined,
      task_type: 'recurring',
      cron: { expression: newCron.trim() },
      payload,
      is_enabled: true,
      stale_after_days: 7,
      stale_policy: 'notify_and_delete',
      tags: [],
    }
  }

  const handleAdd = useCallback(async () => {
    const input = buildTaskInput()
    if (!input) return
    await createTask(input)
    setNewName('')
    setNewDescription('')
    setNewCron('0 9 * * 1-5')
    setNewMode('llm_prompt')
    setNewPayload('{}')
    setNewDagWorkflowId('')
    setNewDagInputs('{}')
    setShowAddForm(false)
  }, [newName, newDescription, newCron, newMode, newPayload, newDagWorkflowId, newDagInputs, createTask, cronIsValid])

  const startEdit = useCallback((task: CronTask) => {
    setEditingId(task.id)
    setEditName(task.name)
    setEditDescription(task.description ?? '')
    setEditCron(task.cron?.expression ?? '0 9 * * *')
    setEditMode(task.payload?.execution_mode ?? 'llm_prompt')
    setEditPayload(safeJsonStringify(task.payload))
    setEditDagWorkflowId(task.payload?.dagWorkflowId ?? '')
    setEditDagInputs(safeJsonStringify(task.payload?.dagInputs ?? {}))
  }, [])

  const handleSaveEdit = useCallback(
    async (id: string) => {
      if (!editName.trim() || !editCronIsValid) return

      let payload: TaskPayload
      if (editMode === 'dag_workflow') {
        if (!editDagWorkflowId || !validateDagInputs(editDagInputs)) return
        payload = buildDagPayload(editDagWorkflowId, editDagInputs)
      } else {
        payload = safeJsonParse(editPayload) as unknown as TaskPayload
        payload.execution_mode = editMode
      }

      await updateTask(id, {
        name: editName.trim(),
        description: editDescription.trim() || undefined,
        cron: { expression: editCron.trim() },
        payload,
      })
      setEditingId(null)
    },
    [editName, editDescription, editCron, editMode, editPayload, editDagWorkflowId, editDagInputs, updateTask, editCronIsValid]
  )

  const applyPreset = useCallback((factory: () => CronTask) => {
    const preset = factory()
    setNewName(preset.name)
    setNewDescription(preset.description ?? '')
    setNewCron(preset.cron?.expression ?? '0 9 * * *')
    setNewMode(preset.payload?.execution_mode ?? 'llm_prompt')
    setNewPayload(safeJsonStringify(preset.payload))
    setShowAddForm(true)
  }, [])

  const handleGenerateCron = useCallback(async () => {
    if (!cronDescription.trim() || isGeneratingCron) return
    setIsGeneratingCron(true)
    setCronGenerateError(null)
    try {
      const result = await generateCronFromNaturalLanguage(cronDescription.trim())
      setNewCron(result.expression)
      if (!newDescription) {
        setNewDescription(result.description)
      }
      setCronDescription('')
    } catch (err) {
      setCronGenerateError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setIsGeneratingCron(false)
    }
  }, [cronDescription, isGeneratingCron, newDescription])

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-surface-200 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
            <Calendar size={20} className="text-purple-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-surface-800">{t('cronScheduler.cronSchedulerView.title')}</h2>
            <p className="text-sm text-surface-400">{t('cronScheduler.cronSchedulerView.subtitle')}</p>
          </div>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            showAddForm
              ? 'bg-surface-200 text-surface-600'
              : 'bg-purple-500 text-white hover:bg-purple-600'
          )}
        >
          {showAddForm ? t('cronScheduler.cronSchedulerView.cancel') : <><Plus size={16} /> {t('cronScheduler.cronSchedulerView.newTask')}</>}
        </button>
      </div>

      {/* Add Form */}
      {showAddForm && (
        <div className="px-6 py-4 bg-purple-50 border-b border-purple-100 overflow-y-auto">
          <div className="max-w-3xl space-y-3">
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  onClick={() => applyPreset(preset.factory)}
                  className="px-2 py-1 text-xs bg-white border border-purple-200 text-purple-700 rounded-md hover:bg-purple-100"
                >
                  {t(`cronScheduler.cronSchedulerView.preset.${preset.key}`)}
                </button>
              ))}
            </div>
            <div className="space-y-2 p-3 bg-white border border-purple-200 rounded-lg">
              <div className="flex items-center gap-2 text-xs text-purple-700 font-medium">
                <Wand2 size={14} />
                {t('cronScheduler.cronSchedulerView.generateCronFromDescription')}
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={cronDescription}
                  onChange={(e) => setCronDescription(e.target.value)}
                  placeholder={t('cronScheduler.cronSchedulerView.generateCronPlaceholder')}
                  className="flex-1 px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-purple-400"
                />
                <button
                  onClick={handleGenerateCron}
                  disabled={isGeneratingCron || !cronDescription.trim()}
                  className="flex items-center gap-1.5 px-3 py-2 bg-purple-500 hover:bg-purple-600 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {isGeneratingCron ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                  {isGeneratingCron ? t('cronScheduler.cronSchedulerView.generating') : t('cronScheduler.cronSchedulerView.generate')}
                </button>
              </div>
              {cronGenerateError && <p className="text-xs text-red-500">{cronGenerateError}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('cronScheduler.cronSchedulerView.taskName')}
                className="px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-purple-400"
              />
              <select
                value={newMode}
                onChange={(e) => setNewMode(e.target.value as TaskExecutionMode)}
                className="px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-purple-400"
              >
                {TASK_EXECUTION_MODES.map((mode) => (
                  <option key={mode} value={mode}>{t(MODE_KEYS[mode])}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                value={newCron}
                onChange={(e) => setNewCron(e.target.value)}
                placeholder={t('cronScheduler.cronSchedulerView.cronExpression')}
                className={cn(
                  'px-3 py-2 border rounded-lg text-sm focus:outline-none focus:border-purple-400',
                  cronIsValid ? 'border-surface-200' : 'border-red-300'
                )}
              />
              <span className="text-xs text-surface-500 flex items-center">{humanReadableCron(newCron)}</span>
            </div>
            {cronIsValid && nextRunPreview.length > 0 && (
              <div className="p-3 bg-white border border-surface-200 rounded-lg">
                <p className="text-xs font-medium text-surface-700 mb-1.5">{t('cronScheduler.cronSchedulerView.nextRuns')}</p>
                <ul className="space-y-1">
                  {nextRunPreview.map((time, idx) => (
                    <li key={idx} className="text-xs text-surface-500 flex items-center gap-2">
                      <span className="w-4 h-4 rounded-full bg-purple-50 text-purple-600 flex items-center justify-center text-[10px] font-medium">
                        {idx + 1}
                      </span>
                      {new Date(time).toLocaleString('zh-CN')}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!cronIsValid && <p className="text-xs text-red-500">{t('cronScheduler.cronSchedulerView.invalidCron')}</p>}
            <input
              type="text"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder={t('cronScheduler.cronSchedulerView.taskDescription')}
              className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-purple-400"
            />
            {newMode === 'dag_workflow' ? (
              <>
                <select
                  value={newDagWorkflowId}
                  onChange={(e) => setNewDagWorkflowId(e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-purple-400"
                >
                  <option value="">{t('cronScheduler.cronSchedulerView.selectDagWorkflow')}</option>
                  {dagWorkflows.map((wf) => (
                    <option key={wf.id} value={wf.id}>{wf.name}</option>
                  ))}
                </select>
                <textarea
                  value={newDagInputs}
                  onChange={(e) => setNewDagInputs(e.target.value)}
                  placeholder={t('cronScheduler.cronSchedulerView.dagInputs')}
                  rows={5}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm font-mono focus:outline-none focus:border-purple-400"
                />
              </>
            ) : (
              <textarea
                value={newPayload}
                onChange={(e) => setNewPayload(e.target.value)}
                placeholder={t('cronScheduler.cronSchedulerView.payload')}
                rows={5}
                className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm font-mono focus:outline-none focus:border-purple-400"
              />
            )}
            {payloadError && newMode !== 'dag_workflow' && <p className="text-xs text-red-500">{payloadError}</p>}
            <div className="flex justify-end">
              <button
                onClick={handleAdd}
                disabled={!newName.trim() || !cronIsValid || (newMode === 'dag_workflow' ? !newDagWorkflowId || !validateDagInputs(newDagInputs) : !validatePayload(newPayload))}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                  newName.trim() && cronIsValid
                    ? 'bg-purple-500 text-white hover:bg-purple-600'
                    : 'bg-surface-200 text-surface-400 cursor-not-allowed'
                )}
              >
                {t('cronScheduler.cronSchedulerView.createTask')}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="px-6 py-2 bg-red-50 border-b border-red-100 flex items-center justify-between">
          <p className="text-sm text-red-600">{error}</p>
          <button onClick={clearError} className="text-xs text-red-700 hover:underline">{t('cronScheduler.cronSchedulerView.dismiss')}</button>
        </div>
      )}

      {/* Task List */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-3">
          {loading && tasks.length === 0 && (
            <div className="text-center py-12 text-surface-400">
              <Loader2 className="mx-auto animate-spin mb-2" size={24} />
              {t('cronScheduler.cronSchedulerView.loading')}
            </div>
          )}

          {!loading && tasks.length === 0 && (
            <div className="text-center py-12">
              <Calendar size={48} className="mx-auto text-surface-300 mb-3" />
              <p className="text-surface-500 font-medium">{t('cronScheduler.cronSchedulerView.noTasks')}</p>
              <p className="text-sm text-surface-400 mt-1">{t('cronScheduler.cronSchedulerView.createHint')}</p>
            </div>
          )}

          {tasks.map((task) => {
            const isEditing = editingId === task.id
            const mode = task.payload?.execution_mode ?? 'llm_prompt'
            return (
              <div
                key={task.id}
                className={cn(
                  'bg-white border rounded-xl p-4 transition-all',
                  task.is_enabled ? 'border-surface-200' : 'border-surface-100 opacity-60'
                )}
              >
                {isEditing ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-purple-400"
                      />
                      <select
                        value={editMode}
                        onChange={(e) => setEditMode(e.target.value as TaskExecutionMode)}
                        className="px-3 py-2 border border-surface-200 rounded-lg text-sm"
                      >
                        {TASK_EXECUTION_MODES.map((m) => (
                          <option key={m} value={m}>{t(MODE_KEYS[m])}</option>
                        ))}
                      </select>
                    </div>
                    <input
                      type="text"
                      value={editCron}
                      onChange={(e) => setEditCron(e.target.value)}
                      placeholder={t('cronScheduler.cronSchedulerView.cronExpression')}
                      className={cn(
                        'w-full px-3 py-2 border rounded-lg text-sm',
                        editCronIsValid ? 'border-surface-200' : 'border-red-300'
                      )}
                    />
                    <input
                      type="text"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder={t('cronScheduler.cronSchedulerView.taskDescription')}
                      className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm"
                    />
                    {editMode === 'dag_workflow' ? (
                      <>
                        <select
                          value={editDagWorkflowId}
                          onChange={(e) => setEditDagWorkflowId(e.target.value)}
                          className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-purple-400"
                        >
                          <option value="">{t('cronScheduler.cronSchedulerView.selectDagWorkflow')}</option>
                          {dagWorkflows.map((wf) => (
                            <option key={wf.id} value={wf.id}>{wf.name}</option>
                          ))}
                        </select>
                        <textarea
                          value={editDagInputs}
                          onChange={(e) => setEditDagInputs(e.target.value)}
                          placeholder={t('cronScheduler.cronSchedulerView.dagInputs')}
                          rows={4}
                          className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm font-mono"
                        />
                      </>
                    ) : (
                      <textarea
                        value={editPayload}
                        onChange={(e) => setEditPayload(e.target.value)}
                        placeholder={t('cronScheduler.cronSchedulerView.payload')}
                        rows={4}
                        className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm font-mono"
                      />
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setEditingId(null)}
                        className="px-3 py-1.5 text-xs text-surface-500 hover:bg-surface-100 rounded-lg"
                      >{t('cronScheduler.cronSchedulerView.cancelEdit')}</button>
                      <button
                        onClick={() => handleSaveEdit(task.id)}
                        disabled={!editName.trim() || !editCronIsValid || (editMode === 'dag_workflow' ? !editDagWorkflowId || !validateDagInputs(editDagInputs) : false)}
                        className="px-3 py-1.5 text-xs bg-purple-500 text-white rounded-lg hover:bg-purple-600 disabled:opacity-50"
                      >{t('cronScheduler.cronSchedulerView.save')}</button>
                    </div>
                  </div>
                ) : (
                  <>
                    {(() => {
                      const result = getTaskResult(task.id)
                      const isExpanded = expandedTaskId === task.id
                      const statusColor =
                        result?.status === 'completed'
                          ? 'bg-green-100 text-green-700'
                          : result?.status === 'failed'
                            ? 'bg-red-100 text-red-700'
                            : result?.status === 'cancelled'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-surface-100 text-surface-500'
                      return (
                        <>
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <span className={cn('w-2 h-2 rounded-full', task.is_enabled ? 'bg-green-500' : 'bg-surface-300')} />
                                <h3 className="text-sm font-medium text-surface-800">{task.name}</h3>
                                <span className="text-xs px-1.5 py-0.5 rounded-full bg-surface-100 text-surface-500">
                                  {task.cron?.expression}
                                </span>
                                <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600 flex items-center gap-1">
                                  {MODE_ICONS[mode]}
                                  {t(MODE_KEYS[mode])}
                                </span>
                                <span className={cn('text-xs px-1.5 py-0.5 rounded-full capitalize', statusColor)}>
                                  {result?.status || task.status || 'pending'}
                                </span>
                              </div>
                              {task.description && <p className="text-xs text-surface-400 mb-2">{task.description}</p>}
                              <div className="flex items-center gap-4 text-xs text-surface-400">
                                <span className="flex items-center gap-1">
                                  <Clock size={12} />
                                  {t('cronScheduler.cronSchedulerView.nextRun', { time: formatTime(task.next_run_at) })}
                                </span>
                                <span className="flex items-center gap-1">
                                  <CheckCircle2 size={12} />
                                  {t('cronScheduler.cronSchedulerView.lastRun', { time: formatTime(result?.ranAt ? new Date(result.ranAt).toISOString() : task.last_run_at) })}
                                </span>
                              </div>
                              {result?.error_message && (
                                <p className="mt-2 text-xs text-red-600 line-clamp-2">{result.error_message}</p>
                              )}
                            </div>

                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button
                                onClick={() => runTask(task.id)}
                                disabled={task.isRunning}
                                className="p-1.5 rounded-lg text-surface-400 hover:text-purple-500 hover:bg-purple-50 transition-colors"
                                title={t('cronScheduler.cronSchedulerView.executeNow')}
                              >
                                {task.isRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                              </button>
                              <button
                                onClick={() => startEdit(task)}
                                className="p-1.5 rounded-lg text-surface-400 hover:text-primary-500 hover:bg-primary-50 transition-colors"
                                title={t('cronScheduler.cronSchedulerView.edit')}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                onClick={() => toggleTask(task.id)}
                                className={cn(
                                  'p-1.5 rounded-lg transition-colors',
                                  task.is_enabled ? 'text-green-500 hover:bg-green-50' : 'text-surface-400 hover:bg-surface-100'
                                )}
                                title={task.is_enabled ? t('cronScheduler.cronSchedulerView.disable') : t('cronScheduler.cronSchedulerView.enable')}
                              >
                                {task.is_enabled ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                              </button>
                              <button
                                onClick={() => deleteTask(task.id)}
                                className="p-1.5 rounded-lg text-surface-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                                title={t('cronScheduler.cronSchedulerView.delete')}
                              >
                                <Trash2 size={14} />
                              </button>
                              {(result?.logs?.length && result.logs.length > 0) || result?.error ? (
                                <button
                                  onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}
                                  className={cn(
                                    'flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-colors',
                                    isExpanded
                                      ? 'bg-surface-100 text-surface-600'
                                      : result?.status === 'failed'
                                        ? 'bg-red-50 text-red-600 hover:bg-red-100'
                                        : 'bg-surface-50 text-surface-600 hover:bg-surface-100'
                                  )}
                                  title={isExpanded ? '收起日志' : '查看执行日志'}
                                >
                                  {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                  {isExpanded ? '收起' : '日志'}
                                </button>
                              ) : null}
                            </div>
                          </div>

                          {isExpanded && ((result?.logs?.length && result.logs.length > 0) || result?.error) && (
                            <div className="mt-3 pt-3 border-t border-surface-100 space-y-2">
                              {result.error && (
                                <div className="p-2 bg-red-50 rounded-lg">
                                  <p className="text-xs font-medium text-red-700 mb-1">错误详情</p>
                                  <pre className="text-xs text-red-600 whitespace-pre-wrap break-words">{result.error}</pre>
                                </div>
                              )}
                              {result.logs && result.logs.length > 0 && (
                                <div className="p-2 bg-surface-50 rounded-lg">
                                  <p className="text-xs font-medium text-surface-700 mb-1">运行日志</p>
                                  <div className="max-h-48 overflow-auto space-y-0.5">
                                    {result.logs.slice(-30).map((log, idx) => (
                                      <pre key={idx} className="text-xs text-surface-600 whitespace-pre-wrap break-words">{log}</pre>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )
                    })()}
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

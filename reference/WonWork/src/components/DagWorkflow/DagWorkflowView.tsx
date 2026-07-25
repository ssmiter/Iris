import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { useDagWorkflowStore } from '@/stores/dagWorkflowStore'
import { useChatStore } from '@/stores/chatStore'
import { DagEditor } from './DagEditor'
import { Plus, Play, Copy, Trash2, GitBranch, Loader2, LayoutTemplate, Wand2, Sparkles, X, Upload, Download } from 'lucide-react'
import type { DagNodeType, DagWorkflow, ExecutionPlan } from '@/types/dagWorkflow'
import { type DagIntentField } from '@/utils/intentToDag'
import { runDagWorkflowGenerationAgent, type DagWorkflowGenerationState } from '@/utils/dagWorkflowGenerationAgent'
import { planToDag } from '@/utils/planToDag'
import { validateExecutionPlanAgainstCatalog, type PlanValidationIssue } from '@/utils/planValidator'
import { ExecutionPlanPreview } from './ExecutionPlanPreview'
import { DagWorkflowInputDialog } from './DagWorkflowInputDialog'
import { useAuthStore } from '@/stores/authStore'
import { setRecentValue } from '@/utils/workflowInputCache'
import { normalizeInputSchema } from '@/types/dagWorkflow'
import type { PlanValidationState } from '@/utils/sqlValidator'
import type { SandboxResult } from '@/utils/dagSandboxExecutor'

type TabId = 'list' | 'editor'
type CreateMode = 'manual' | 'intent' | null

const INTENT_DOMAINS = [
  { value: '', label: '通用' },
  { value: 'data_extraction', label: '数据提取' },
  { value: 'report_generation', label: '报表生成' },
  { value: 'form_automation', label: '表单自动化' },
  { value: 'system_monitoring', label: '系统监控' },
  { value: 'rd_assistant', label: '研发助手' },
]

const INPUT_TYPES = ['string', 'number', 'boolean', 'date', 'datetime', 'select', 'array', 'object'] as const

interface DagWorkflowViewProps {
  onNavigate?: (view: string) => void
}

export function DagWorkflowView({ onNavigate }: DagWorkflowViewProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<TabId>('list')
  const [createMode, setCreateMode] = useState<CreateMode>(null)

  // Manual form
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // Intent form
  const [intentName, setIntentName] = useState('')
  const [intentDescription, setIntentDescription] = useState('')
  const [intentExpectedOutput, setIntentExpectedOutput] = useState('')
  const [intentDomain, setIntentDomain] = useState('')
  const [intentInputs, setIntentInputs] = useState<DagIntentField[]>([])

  const [isGenerating, setIsGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [pendingPlan, setPendingPlan] = useState<ExecutionPlan | null>(null)
  const [pendingPlanIssues, setPendingPlanIssues] = useState<PlanValidationIssue[]>([])
  const [sqlValidationState, setSqlValidationState] = useState<PlanValidationState>({ sqlResults: [], overallSqlValid: true })
  const [dryRunStatus, setDryRunStatus] = useState<DagWorkflowGenerationState['dryRunStatus']>('pending')
  const [sandboxResult, setSandboxResult] = useState<SandboxResult | undefined>(undefined)
  const [runningWorkflowForInputs, setRunningWorkflowForInputs] = useState<DagWorkflow | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const {
    workflows,
    activeWorkflowId,
    isExecuting,
    loadWorkflows,
    createWorkflow,
    deleteWorkflow,
    duplicateWorkflow,
    exportAll,
    importWorkflows,
    runWorkflow,
    setActiveWorkflow,
  } = useDagWorkflowStore()

  const runDagWorkflowAsAgent = useChatStore((s) => s.runDagWorkflowAsAgent)

  useEffect(() => {
    loadWorkflows()
  }, [loadWorkflows])

  const resetForms = () => {
    setName('')
    setDescription('')
    setIntentName('')
    setIntentDescription('')
    setIntentExpectedOutput('')
    setIntentDomain('')
    setIntentInputs([])
    setGenerateError(null)
    setPendingPlan(null)
    setPendingPlanIssues([])
    setSqlValidationState({ sqlResults: [], overallSqlValid: true })
    setDryRunStatus('pending')
    setSandboxResult(undefined)
  }

  const handleCreate = async () => {
    if (!name.trim()) return
    const created = await createWorkflow({
      name: name.trim(),
      description: description.trim(),
      version: '1.0.0',
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } },
        { id: 'end', type: 'end', position: { x: 600, y: 0 }, data: { label: 'End' } },
      ],
      edges: [{ id: 'e-start-end', source: 'start', target: 'end' }],
    })
    resetForms()
    setCreateMode(null)
    setActiveTab('editor')
  }

  const handleGenerateFromIntent = async () => {
    if (!intentName.trim() || !intentDescription.trim() || isGenerating) return
    setIsGenerating(true)
    setGenerateError(null)
    setPendingPlan(null)
    setPendingPlanIssues([])
    setSqlValidationState({ sqlResults: [], overallSqlValid: true })
    setDryRunStatus('pending')
    setSandboxResult(undefined)
    try {
      const systemCode = useAuthStore.getState().user?.systemCode
      const result = await runDagWorkflowGenerationAgent(
        {
          name: intentName.trim(),
          description: intentDescription.trim(),
          expectedOutput: intentExpectedOutput.trim() || undefined,
          domain: intentDomain || undefined,
          inputs: intentInputs.length > 0 ? intentInputs : undefined,
        },
        { systemCode, maxRetries: 3 }
      )
      setPendingPlan(result.plan)
      setPendingPlanIssues(result.allIssues)
      setSqlValidationState(result.sqlState)
      setDryRunStatus(result.dryRunStatus)
      setSandboxResult(result.sandboxResult)
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleConfirmPlan = async () => {
    if (!pendingPlan || isGenerating) return
    setIsGenerating(true)
    try {
      const draft = planToDag(pendingPlan)
      const created = await createWorkflow(draft)
      resetForms()
      setCreateMode(null)
      setActiveTab('editor')

      // 自动生成后交给对话 Agent 执行
      if (created) {
        const schema = normalizeInputSchema(created.inputSchema)
        if (schema.length > 0) {
          setRunningWorkflowForInputs(created)
        } else {
          onNavigate?.('chat')
          await runDagWorkflowAsAgent(created, {})
        }
      }
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : '生成 DAG 失败')
    } finally {
      setIsGenerating(false)
    }
  }

  const handleOpenEditor = (id: string) => {
    setActiveWorkflow(id)
    setActiveTab('editor')
  }

  const handleExport = async () => {
    const blob = await exportAll()
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `wonwork-dag-workflows-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const imported = await importWorkflows(file)
    if (imported && imported.length > 0) {
      setActiveTab('list')
    }
  }

  const addIntentInput = () => {
    setIntentInputs((prev) => [
      ...prev,
      { name: '', type: 'string', required: true, description: '' },
    ])
  }

  const updateIntentInput = (index: number, patch: Partial<DagIntentField>) => {
    setIntentInputs((prev) => {
      const next = [...prev]
      next[index] = { ...next[index], ...patch }
      return next
    })
  }

  const removeIntentInput = (index: number) => {
    setIntentInputs((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <div className="flex flex-col h-full bg-surface-50">
      <header className="flex-none px-6 py-4 border-b border-surface-200 bg-white">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-surface-900">{t('visualWorkflow.title')}</h1>
            <p className="text-sm text-surface-500 mt-1">{t('visualWorkflow.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCreateMode(createMode === 'manual' ? null : 'manual')}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                createMode === 'manual'
                  ? 'bg-primary-100 text-primary-700'
                  : 'bg-primary-600 hover:bg-primary-500 text-white'
              )}
            >
              <Plus size={16} />
              {t('visualWorkflow.newWorkflow')}
            </button>
            <button
              onClick={() => setCreateMode(createMode === 'intent' ? null : 'intent')}
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                createMode === 'intent'
                  ? 'bg-purple-100 text-purple-700'
                  : 'bg-purple-600 hover:bg-purple-500 text-white'
              )}
            >
              <Sparkles size={16} />
              AI 创建工作流
            </button>
            <button
              onClick={handleExport}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors bg-surface-100 hover:bg-surface-200 text-surface-700"
              title="导出全部工作流"
            >
              <Download size={16} />
              导出
            </button>
            <button
              onClick={handleImportClick}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors bg-surface-100 hover:bg-surface-200 text-surface-700"
              title="从 JSON 文件导入工作流"
            >
              <Upload size={16} />
              导入
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleFileSelected}
              className="hidden"
            />
          </div>
        </div>

        <nav className="flex gap-1 mt-4">
          <button
            onClick={() => setActiveTab('list')}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
              activeTab === 'list'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-surface-500 hover:text-surface-700 hover:border-surface-300'
            )}
          >
            {t('visualWorkflow.listTab')}
          </button>
          <button
            onClick={() => activeWorkflowId && setActiveTab('editor')}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
              activeTab === 'editor'
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-surface-500 hover:text-surface-700 hover:border-surface-300',
              !activeWorkflowId && 'opacity-50 cursor-not-allowed'
            )}
          >
            {t('visualWorkflow.editorTab')}
          </button>
        </nav>
      </header>

      {createMode === 'manual' && activeTab === 'list' && (
        <div className="flex-none px-6 py-4 bg-white border-b border-surface-200">
          <div className="max-w-2xl space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('visualWorkflow.namePlaceholder')}
                className="px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('visualWorkflow.descriptionPlaceholder')}
                className="px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                className="px-4 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {t('visualWorkflow.create')}
              </button>
              <button
                onClick={() => { setCreateMode(null); resetForms() }}
                className="px-4 py-2 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg text-sm font-medium transition-colors"
              >
                {t('visualWorkflow.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {createMode === 'intent' && activeTab === 'list' && (
        <div className="flex-none px-6 py-4 bg-white border-b border-surface-200 overflow-y-auto max-h-[calc(100vh-8rem)]">
          <div className="max-w-3xl space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                value={intentName}
                onChange={(e) => setIntentName(e.target.value)}
                placeholder="工作流名称"
                className="px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              <select
                value={intentDomain}
                onChange={(e) => setIntentDomain(e.target.value)}
                className="px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                {INTENT_DOMAINS.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </div>
            <textarea
              value={intentDescription}
              onChange={(e) => setIntentDescription(e.target.value)}
              placeholder="描述工作流要完成的任务，例如：每天从 ERP 查询昨日工单，生成 Excel 报表并发送邮件给生产主管"
              rows={3}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
            />

            <input
              type="text"
              value={intentExpectedOutput}
              onChange={(e) => setIntentExpectedOutput(e.target.value)}
              placeholder="期望输出（可选），例如：一个包含昨日工单汇总数据的 Excel 文件"
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            />

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-surface-700">输入变量</span>
                <button
                  onClick={addIntentInput}
                  className="text-xs px-2 py-1 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded transition-colors"
                >
                  + 添加变量
                </button>
              </div>
              {intentInputs.map((input, index) => (
                <div key={index} className="grid grid-cols-12 gap-2 items-center">
                  <input
                    type="text"
                    value={input.name}
                    onChange={(e) => updateIntentInput(index, { name: e.target.value })}
                    placeholder="变量名"
                    className="col-span-3 px-3 py-1.5 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <select
                    value={input.type}
                    onChange={(e) => updateIntentInput(index, { type: e.target.value as DagIntentField['type'] })}
                    className="col-span-2 px-3 py-1.5 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  >
                    {INPUT_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={input.description || ''}
                    onChange={(e) => updateIntentInput(index, { description: e.target.value })}
                    placeholder="描述（可选）"
                    className="col-span-4 px-3 py-1.5 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <label className="col-span-2 flex items-center gap-1 text-sm text-surface-700">
                    <input
                      type="checkbox"
                      checked={input.required}
                      onChange={(e) => updateIntentInput(index, { required: e.target.checked })}
                      className="rounded border-surface-300 text-purple-600 focus:ring-purple-500"
                    />
                    必填
                  </label>
                  <button
                    onClick={() => removeIntentInput(index)}
                    className="col-span-1 p-1.5 text-surface-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>

            {generateError && (
              <p className="text-xs text-red-600">{generateError}</p>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleGenerateFromIntent}
                disabled={isGenerating || !intentName.trim() || !intentDescription.trim() || !!pendingPlan}
                className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {isGenerating ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Wand2 size={16} />
                )}
                {isGenerating ? t('visualWorkflow.generating') : 'AI 生成执行计划'}
              </button>
              <button
                onClick={() => { setCreateMode(null); resetForms() }}
                className="px-4 py-2 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg text-sm font-medium transition-colors"
              >
                {t('visualWorkflow.cancel')}
              </button>
            </div>

            {pendingPlan && (
              <div className="mt-4 h-[50vh]">
                <ExecutionPlanPreview
                  plan={pendingPlan}
                  issues={pendingPlanIssues}
                  sqlValidationState={sqlValidationState}
                  dryRunStatus={dryRunStatus}
                  sandboxResult={sandboxResult}
                  onConfirm={handleConfirmPlan}
                  onCancel={() => setPendingPlan(null)}
                  isGenerating={isGenerating}
                />
              </div>
            )}
          </div>
        </div>
      )}

<div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'list' ? (
          <div className="h-full overflow-auto p-6">
            <div className="max-w-4xl mx-auto">
              {workflows.length === 0 ? (
                <div className="p-8 text-center text-surface-500 text-sm bg-white rounded-xl border border-surface-200">
                  {t('visualWorkflow.empty')}
                </div>
              ) : (
                <ul className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden divide-y divide-surface-100">
                  {workflows.map((wf) => (
                    <li key={wf.id} className="p-4 hover:bg-surface-50 transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <button
                          onClick={() => handleOpenEditor(wf.id)}
                          className="flex items-start gap-3 min-w-0 text-left"
                        >
                          <span className="p-1.5 bg-primary-50 text-primary-500 rounded-lg flex-shrink-0">
                            <GitBranch size={16} />
                          </span>
                          <div className="min-w-0">
                            <p className="font-medium text-surface-900 truncate">{wf.name}</p>
                            <p className="text-xs text-surface-500 truncate">
                              {wf.description || t('visualWorkflow.noDescription')}
                            </p>
                            <p className="text-xs text-surface-400 mt-1">
                              {wf.nodes.length} 节点 · {wf.edges.length} 边
                            </p>
                          </div>
                        </button>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => {
                              const schema = normalizeInputSchema(wf.inputSchema)
                              if (schema.length > 0) {
                                setRunningWorkflowForInputs(wf)
                              } else {
                                onNavigate?.('chat')
                                runDagWorkflowAsAgent(wf, {})
                              }
                            }}
                            disabled={isExecuting}
                            className="p-2 bg-green-50 hover:bg-green-100 text-green-600 rounded-lg transition-colors disabled:opacity-50"
                            title={t('visualWorkflow.run')}
                          >
                            {isExecuting && activeWorkflowId === wf.id ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              <Play size={16} />
                            )}
                          </button>
                          <button
                            onClick={() => handleOpenEditor(wf.id)}
                            className="p-2 bg-surface-100 hover:bg-surface-200 text-surface-600 rounded-lg transition-colors"
                            title={t('visualWorkflow.edit')}
                          >
                            <LayoutTemplate size={16} />
                          </button>
                          <button
                            onClick={() => duplicateWorkflow(wf.id)}
                            className="p-2 bg-surface-100 hover:bg-surface-200 text-surface-600 rounded-lg transition-colors"
                            title={t('visualWorkflow.duplicate')}
                          >
                            <Copy size={16} />
                          </button>
                          <button
                            onClick={() => deleteWorkflow(wf.id)}
                            className="p-2 bg-surface-100 hover:bg-red-100 text-surface-600 hover:text-red-600 rounded-lg transition-colors"
                            title={t('visualWorkflow.delete')}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : activeWorkflowId ? (
          <DagEditor workflowId={activeWorkflowId} onNavigate={onNavigate} />
        ) : (
          <div className="h-full flex items-center justify-center text-surface-500">
            {t('visualWorkflow.selectWorkflow')}
          </div>
        )}
      </div>
      {runningWorkflowForInputs && (
        <DagWorkflowInputDialog
          workflow={runningWorkflowForInputs}
          onConfirm={async (inputs) => {
            const wf = runningWorkflowForInputs
            setRunningWorkflowForInputs(null)
            onNavigate?.('chat')
            for (const [key, value] of Object.entries(inputs)) {
              setRecentValue(wf.id, key, value)
            }
            await runDagWorkflowAsAgent(wf, inputs)
          }}
          onCancel={() => setRunningWorkflowForInputs(null)}
        />
      )}
    </div>
  )
}

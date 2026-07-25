import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { cn } from '@/utils'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { useDagWorkflowStore } from '@/stores/dagWorkflowStore'
import { WorkflowTemplateLibrary } from './WorkflowTemplateLibrary'
import { WORKFLOW_TEMPLATES } from './WorkflowTemplates'
import type { WorkflowDefinition, WorkflowType } from '@/types/webbridge'
import { WORKFLOW_TYPES } from '@/types/webbridge'
import {
  Plus,
  Play,
  Square,
  Trash2,
  Copy,
  Bot,
  FileText,
  Search,
  Activity,
  Settings,
  Loader2,
  Pencil,
  LayoutGrid,
} from 'lucide-react'

const WORKFLOW_TYPE_ICONS: Record<WorkflowType, React.ReactNode> = {
  data_extraction: <FileText size={14} />,
  form_automation: <Bot size={14} />,
  monitoring: <Activity size={14} />,
  research: <Search size={14} />,
  comparison: <Settings size={14} />,
  custom: <Bot size={14} />,
}

interface WorkflowPanelProps {
  onNavigate?: (view: string) => void
}

export function WorkflowPanel({ onNavigate }: WorkflowPanelProps) {
  const { t } = useTranslation()
  const {
    workflows,
    isExecuting,
    currentWorkflowId,
    createWorkflow,
    deleteWorkflow,
    duplicateWorkflow,
    runWorkflow,
    stopWorkflow,
  } = useWebBridgeStore()

  const { importFromWebBridge } = useDagWorkflowStore()

  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [workflowType, setWorkflowType] = useState<WorkflowType>('custom')

  const [showTemplateLibrary, setShowTemplateLibrary] = useState(false)

  const handleOpenInDag = async (workflow: WorkflowDefinition) => {
    await importFromWebBridge(workflow)
    onNavigate?.('dag-workflow')
  }

  const handleCreate = () => {
    if (!name.trim()) return
    createWorkflow({
      name: name.trim(),
      description: description.trim(),
      workflow_type: workflowType,
    })
    setName('')
    setDescription('')
    setWorkflowType('custom')
    setShowForm(false)
  }

  const handleUseTemplate = (workflow: WorkflowDefinition) => {
    createWorkflow({
      name: workflow.name,
      description: workflow.description,
      workflow_type: workflow.workflow_type,
      steps: workflow.steps,
      input_schema: workflow.input_schema,
      output_format: workflow.output_format,
      require_login: workflow.require_login,
      target_sites: workflow.target_sites,
      estimated_duration_seconds: workflow.estimated_duration_seconds,
      security_policy: workflow.security_policy,
    })
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-surface-900">{t('webbridge.workflowPanel.title')}</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTemplateLibrary(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg text-sm font-medium transition-colors"
          >
            <LayoutGrid size={16} />
            {t('webbridge.templateLibrary.title')}
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 px-3 py-1.5 bg-primary-600 hover:bg-primary-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus size={16} />
            {t('webbridge.workflowPanel.newWorkflow')}
          </button>
        </div>
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-4 space-y-3">
          <div>
            <label className="block text-sm font-medium text-surface-700 mb-1">{t('webbridge.workflowPanel.name')}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              placeholder={t('webbridge.workflowPanel.namePlaceholder')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-surface-700 mb-1">{t('webbridge.workflowPanel.description')}</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              placeholder={t('webbridge.workflowPanel.descriptionPlaceholder')}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-surface-700 mb-1">{t('webbridge.workflowPanel.type')}</label>
            <select
              value={workflowType}
              onChange={(e) => setWorkflowType(e.target.value as WorkflowType)}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {WORKFLOW_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`webbridge.workflowTypes.${type}`, type)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              className="px-4 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {t('webbridge.workflowPanel.create')}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg text-sm font-medium transition-colors"
            >
              {t('webbridge.workflowPanel.cancel')}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
        {workflows.length === 0 ? (
          <div className="p-8 text-center text-surface-500 text-sm">
            {t('webbridge.workflowPanel.empty')}
          </div>
        ) : (
          <ul className="divide-y divide-surface-100">
            {workflows.map((workflow) => {
              const isRunning = isExecuting && currentWorkflowId === workflow.id
              return (
                <li key={workflow.id} className="p-4 hover:bg-surface-50 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <button
                      onClick={() => handleOpenInDag(workflow)}
                      className="flex items-start gap-3 min-w-0 text-left"
                    >
                      <span className="p-1.5 bg-surface-100 rounded text-surface-500 flex-shrink-0">
                        {WORKFLOW_TYPE_ICONS[workflow.workflow_type]}
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium text-surface-900 truncate">{workflow.name}</p>
                        <p className="text-xs text-surface-500 truncate">{workflow.description || t('webbridge.workflowPanel.noDescription')}</p>
                        <p className="text-xs text-surface-400 mt-1">
                          {workflow.workflow_type} · {workflow.steps?.length || 0} {t('webbridge.workflowPanel.steps')}
                        </p>
                      </div>
                    </button>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {isRunning ? (
                        <button
                          onClick={stopWorkflow}
                          className="p-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg transition-colors"
                          title={t('webbridge.workflowPanel.stop')}
                        >
                          <Square size={16} />
                        </button>
                      ) : (
                        <button
                          onClick={() => runWorkflow(workflow.id, { onNavigateToChat: onNavigate ? () => onNavigate('chat') : undefined })}
                          disabled={isExecuting}
                          className="p-2 bg-green-50 hover:bg-green-100 text-green-600 rounded-lg transition-colors disabled:opacity-50"
                          title={t('webbridge.workflowPanel.run')}
                        >
                          {isRunning ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <Play size={16} />
                          )}
                        </button>
                      )}
                      <button
                        onClick={() => handleOpenInDag(workflow)}
                        className="p-2 bg-surface-100 hover:bg-surface-200 text-surface-600 rounded-lg transition-colors"
                        title={t('webbridge.workflowPanel.edit')}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => duplicateWorkflow(workflow.id)}
                        className="p-2 bg-surface-100 hover:bg-surface-200 text-surface-600 rounded-lg transition-colors"
                        title={t('webbridge.workflowPanel.duplicate')}
                      >
                        <Copy size={16} />
                      </button>
                      <button
                        onClick={() => deleteWorkflow(workflow.id)}
                        className="p-2 bg-surface-100 hover:bg-red-100 text-surface-600 hover:text-red-600 rounded-lg transition-colors"
                        title={t('webbridge.workflowPanel.delete')}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {showTemplateLibrary && (
        <WorkflowTemplateLibrary
          templates={WORKFLOW_TEMPLATES}
          onUseTemplate={handleUseTemplate}
          onClose={() => setShowTemplateLibrary(false)}
        />
      )}
    </div>
  )
}

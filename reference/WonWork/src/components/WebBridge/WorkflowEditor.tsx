import { useTranslation } from 'react-i18next'
import { useState, useEffect } from 'react'
import { cn } from '@/utils'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { ActionRecorderPanel } from '@/components/WebBridge/ActionRecorderPanel'
import { VisualSelectorPicker } from '@/components/WebBridge/VisualSelectorPicker'
import type {
  WorkflowDefinition,
  WorkflowStep,
  BrowserAction,
  ActionType,
  SelectorType,
  ErrorHandlingMode,
  ElementSelector,
} from '@/types/webbridge'
import {
  ACTION_TYPES,
  SELECTOR_TYPES,
  ERROR_HANDLING_MODES,
  WORKFLOW_TYPES,
} from '@/types/webbridge'
import {
  ArrowLeft,
  Plus,
  Trash2,
  Save,
  GripVertical,
  ChevronDown,
  ChevronRight,
  Play,
} from 'lucide-react'

interface WorkflowEditorProps {
  workflow: WorkflowDefinition
  onBack: () => void
}

const actionNeedsSelector = (type: ActionType) =>
  ['click', 'double_click', 'right_click', 'hover', 'type', 'clear', 'select', 'check', 'upload', 'wait_for_element'].includes(type)

const actionNeedsValue = (type: ActionType) =>
  ['navigate', 'type', 'clear', 'select', 'check', 'upload', 'wait', 'evaluate', 'download', 'save_page'].includes(type)

export function WorkflowEditor({ workflow, onBack }: WorkflowEditorProps) {
  const { t } = useTranslation()
  const { updateWorkflow, runWorkflow, isExecuting, currentScreenshot } = useWebBridgeStore()

  const [draft, setDraft] = useState<WorkflowDefinition>(workflow)
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set([0]))
  const [selectorPickerTarget, setSelectorPickerTarget] = useState<{ stepIndex: number; actionIndex: number } | null>(null)

  useEffect(() => {
    setDraft(workflow)
  }, [workflow])

  const handleSave = () => {
    updateWorkflow(workflow.id, draft)
  }

  const updateStep = (index: number, updates: Partial<WorkflowStep>) => {
    setDraft((prev) => {
      const steps = [...(prev.steps || [])]
      steps[index] = { ...steps[index], ...updates }
      return { ...prev, steps }
    })
  }

  const addStep = () => {
    setDraft((prev) => {
      const steps = [...(prev.steps || [])]
      steps.push({
        step_id: `step-${Date.now()}`,
        description: `Step ${steps.length + 1}`,
        actions: [],
        on_error: 'stop',
      })
      return { ...prev, steps }
    })
  }

  const removeStep = (index: number) => {
    setDraft((prev) => {
      const steps = [...(prev.steps || [])]
      steps.splice(index, 1)
      return { ...prev, steps }
    })
  }

  const moveStep = (index: number, direction: -1 | 1) => {
    setDraft((prev) => {
      const steps = [...(prev.steps || [])]
      const newIndex = index + direction
      if (newIndex < 0 || newIndex >= steps.length) return prev
      const [moved] = steps.splice(index, 1)
      steps.splice(newIndex, 0, moved)
      return { ...prev, steps }
    })
  }

  const addAction = (stepIndex: number) => {
    setDraft((prev) => {
      const steps = [...(prev.steps || [])]
      const actions = [...(steps[stepIndex].actions || [])]
      actions.push({ action_type: 'navigate' })
      steps[stepIndex] = { ...steps[stepIndex], actions }
      return { ...prev, steps }
    })
  }

  const updateAction = (
    stepIndex: number,
    actionIndex: number,
    updates: Partial<BrowserAction>
  ) => {
    setDraft((prev) => {
      const steps = [...(prev.steps || [])]
      const actions = [...(steps[stepIndex].actions || [])]
      actions[actionIndex] = { ...actions[actionIndex], ...updates }
      steps[stepIndex] = { ...steps[stepIndex], actions }
      return { ...prev, steps }
    })
  }

  const removeAction = (stepIndex: number, actionIndex: number) => {
    setDraft((prev) => {
      const steps = [...(prev.steps || [])]
      const actions = [...(steps[stepIndex].actions || [])]
      actions.splice(actionIndex, 1)
      steps[stepIndex] = { ...steps[stepIndex], actions }
      return { ...prev, steps }
    })
  }

  const toggleStep = (index: number) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const importRecordedActions = (actions: BrowserAction[]) => {
    if (actions.length === 0) return
    setDraft((prev) => {
      const steps = [...(prev.steps || [])]
      const stepIndex = steps.length
      steps.push({
        step_id: `step-${Date.now()}`,
        description: t('webbridge.recorder.title'),
        actions: actions.map((a) => ({ ...a })),
        on_error: 'stop',
      })
      return { ...prev, steps }
    })
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      next.add((draft.steps?.length || 0))
      return next
    })
  }

  const handleSelectorPicked = (selector: ElementSelector | null) => {
    if (!selector || !selectorPickerTarget) return
    const { stepIndex, actionIndex } = selectorPickerTarget
    updateAction(stepIndex, actionIndex, {
      selector: {
        selector_type: selector.selector_type,
        value: selector.value,
      },
    })
    setSelectorPickerTarget(null)
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-sm text-surface-600 hover:text-surface-900 transition-colors"
        >
          <ArrowLeft size={16} />
          {t('webbridge.workflowEditor.back')}
        </button>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Save size={16} />
            {t('webbridge.workflowEditor.save')}
          </button>
          <button
            onClick={() => runWorkflow(workflow.id)}
            disabled={isExecuting}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
          >
            <Play size={16} />
            {t('webbridge.workflowPanel.run')}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-surface-700 mb-1">{t('webbridge.workflowPanel.name')}</label>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-surface-700 mb-1">{t('webbridge.workflowPanel.type')}</label>
            <select
              value={draft.workflow_type}
              onChange={(e) => setDraft((prev) => ({ ...prev, workflow_type: e.target.value as typeof draft.workflow_type }))}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {WORKFLOW_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`webbridge.workflowTypes.${type}`, type)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-surface-700 mb-1">{t('webbridge.workflowPanel.description')}</label>
          <input
            type="text"
            value={draft.description}
            onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
            className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
      </div>

      <div className="space-y-3">
        {(draft.steps || []).map((step, stepIndex) => {
          const expanded = expandedSteps.has(stepIndex)
          return (
            <div key={step.step_id} className="bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
              <div className="flex items-center gap-2 p-3 bg-surface-50 border-b border-surface-100">
                <GripVertical size={16} className="text-surface-300" />
                <button
                  onClick={() => toggleStep(stepIndex)}
                  className="flex items-center gap-1 text-surface-500 hover:text-surface-700"
                >
                  {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <input
                  type="text"
                  value={step.description}
                  onChange={(e) => updateStep(stepIndex, { description: e.target.value })}
                  className="flex-1 min-w-0 px-2 py-1 bg-transparent border-b border-transparent hover:border-surface-300 focus:border-primary-500 focus:outline-none text-sm font-medium text-surface-900"
                />
                <select
                  value={step.on_error || 'stop'}
                  onChange={(e) => updateStep(stepIndex, { on_error: e.target.value as ErrorHandlingMode })}
                  className="px-2 py-1 bg-surface-100 border border-surface-200 rounded text-xs"
                  title={t('webbridge.workflowEditor.onError')}
                >
                  {ERROR_HANDLING_MODES.map((mode) => (
                    <option key={mode} value={mode}>{mode}</option>
                  ))}
                </select>
                <button
                  onClick={() => moveStep(stepIndex, -1)}
                  disabled={stepIndex === 0}
                  className="text-xs px-2 py-1 bg-surface-100 rounded disabled:opacity-40"
                >
                  ▲
                </button>
                <button
                  onClick={() => moveStep(stepIndex, 1)}
                  disabled={stepIndex === (draft.steps?.length || 0) - 1}
                  className="text-xs px-2 py-1 bg-surface-100 rounded disabled:opacity-40"
                >
                  ▼
                </button>
                <button
                  onClick={() => removeStep(stepIndex)}
                  className="p-1.5 text-surface-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {expanded && (
                <div className="p-3 space-y-3">
                  {(step.actions || []).map((action, actionIndex) => (
                    <div key={actionIndex} className="p-3 bg-surface-50 rounded-lg border border-surface-100 space-y-2">
                      <div className="flex items-center gap-2">
                        <select
                          value={action.action_type}
                          onChange={(e) => updateAction(stepIndex, actionIndex, { action_type: e.target.value as ActionType })}
                          className="px-2 py-1.5 bg-white border border-surface-300 rounded text-sm"
                        >
                          {ACTION_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {t(`webbridge.actionTypes.${type}`, type)}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => removeAction(stepIndex, actionIndex)}
                          className="ml-auto p-1.5 text-surface-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      {actionNeedsSelector(action.action_type) && (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2"
                        >
                          <select
                            value={action.selector?.selector_type || 'css'}
                            onChange={(e) => updateAction(stepIndex, actionIndex, {
                              selector: {
                                selector_type: e.target.value as SelectorType,
                                value: action.selector?.value || '',
                              },
                            })}
                            className="md:col-span-1 px-2 py-1.5 bg-white border border-surface-300 rounded text-sm"
                          >
                            {SELECTOR_TYPES.map((type) => (
                              <option key={type} value={type}>{type}</option>
                            ))}
                          </select>
                          <div className="md:col-span-2 flex gap-2">
                            <input
                              type="text"
                              value={action.selector?.value || ''}
                              onChange={(e) => updateAction(stepIndex, actionIndex, {
                                selector: {
                                  selector_type: action.selector?.selector_type || 'css',
                                  value: e.target.value,
                                },
                              })}
                              placeholder="#id, .class, //xpath"
                              className="flex-1 px-2 py-1.5 bg-white border border-surface-300 rounded text-sm"
                            />
                            <button
                              onClick={() => setSelectorPickerTarget({ stepIndex, actionIndex })}
                              disabled={!currentScreenshot}
                              className="px-2 py-1.5 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded text-xs font-medium transition-colors disabled:opacity-60 whitespace-nowrap"
                            >
                              {t('webbridge.visualSelector.title')}
                            </button>
                          </div>
                        </div>
                      )}

                      {actionNeedsValue(action.action_type) && action.action_type !== 'wait' && (
                        <input
                          type="text"
                          value={action.value || ''}
                          onChange={(e) => updateAction(stepIndex, actionIndex, { value: e.target.value })}
                          placeholder={action.action_type === 'navigate' ? 'https://example.com' : ''}
                          className="w-full px-2 py-1.5 bg-white border border-surface-300 rounded text-sm"
                        />
                      )}

                      {action.action_type === 'wait' && (
                        <input
                          type="number"
                          value={action.delay_ms || 1000}
                          onChange={(e) => updateAction(stepIndex, actionIndex, { delay_ms: parseInt(e.target.value, 10) || 0 })}
                          className="w-full px-2 py-1.5 bg-white border border-surface-300 rounded text-sm"
                        />
                      )}
                    </div>
                  ))}

                  <button
                    onClick={() => addAction(stepIndex)}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                  >
                    <Plus size={14} />
                    {t('webbridge.workflowEditor.addAction')}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <button
        onClick={addStep}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-surface-300 hover:border-primary-400 text-surface-500 hover:text-primary-600 rounded-xl transition-colors"
      >
        <Plus size={18} />
        {t('webbridge.workflowEditor.addStep')}
      </button>

      <ActionRecorderPanel onExportToWorkflow={importRecordedActions} />

      {selectorPickerTarget && currentScreenshot && (
        <VisualSelectorPicker
          screenshotUrl={currentScreenshot}
          onSelect={handleSelectorPicked}
          onClose={() => setSelectorPickerTarget(null)}
        />
      )}
    </div>
  )
}

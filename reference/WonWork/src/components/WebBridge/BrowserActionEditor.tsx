import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { VisualSelectorPicker } from '@/components/WebBridge/VisualSelectorPicker'
import { ActionRecorderPanel } from '@/components/WebBridge/ActionRecorderPanel'
import type {
  BrowserAction,
  ActionType,
  SelectorType,
  ElementSelector,
} from '@/types/webbridge'
import { ACTION_TYPES, SELECTOR_TYPES } from '@/types/webbridge'
import { Plus, Trash2 } from 'lucide-react'

const actionNeedsSelector = (type: ActionType) =>
  [
    'click',
    'double_click',
    'right_click',
    'hover',
    'type',
    'clear',
    'select',
    'check',
    'upload',
    'wait_for_element',
  ].includes(type)

const actionNeedsValue = (type: ActionType) =>
  ['navigate', 'type', 'clear', 'select', 'check', 'upload', 'wait', 'evaluate', 'download', 'save_page'].includes(
    type
  )

interface BrowserActionEditorProps {
  actions: BrowserAction[]
  onChange: (actions: BrowserAction[]) => void
}

export function BrowserActionEditor({ actions, onChange }: BrowserActionEditorProps) {
  const { t } = useTranslation()
  const currentScreenshot = useWebBridgeStore((state) => state.currentScreenshot)
  const [selectorPickerIndex, setSelectorPickerIndex] = useState<number | null>(null)

  const updateAction = (index: number, updates: Partial<BrowserAction>) => {
    const next = [...actions]
    next[index] = { ...next[index], ...updates }
    onChange(next)
  }

  const addAction = () => {
    onChange([...actions, { action_type: 'navigate' }])
  }

  const removeAction = (index: number) => {
    const next = [...actions]
    next.splice(index, 1)
    onChange(next)
  }

  const importRecorded = (recorded: BrowserAction[]) => {
    if (recorded.length === 0) return
    onChange([...actions, ...recorded.map((a) => ({ ...a }))])
  }

  const handleSelectorPicked = (selector: ElementSelector | null) => {
    if (selectorPickerIndex == null || !selector) return
    updateAction(selectorPickerIndex, {
      selector: {
        selector_type: selector.selector_type,
        value: selector.value,
      },
    })
    setSelectorPickerIndex(null)
  }

  return (
    <div className="space-y-3">
      {actions.map((action, index) => (
        <div key={index} className="p-3 bg-surface-50 rounded-lg border border-surface-100 space-y-2">
          <div className="flex items-center gap-2">
            <select
              value={action.action_type}
              onChange={(e) => updateAction(index, { action_type: e.target.value as ActionType })}
              className="px-2 py-1.5 bg-white border border-surface-300 rounded text-sm"
            >
              {ACTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`webbridge.actionTypes.${type}`, type)}
                </option>
              ))}
            </select>
            <button
              onClick={() => removeAction(index)}
              className="ml-auto p-1.5 text-surface-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>

          {actionNeedsSelector(action.action_type) && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <select
                value={action.selector?.selector_type || 'css'}
                onChange={(e) =>
                  updateAction(index, {
                    selector: {
                      selector_type: e.target.value as SelectorType,
                      value: action.selector?.value || '',
                    },
                  })
                }
                className="md:col-span-1 px-2 py-1.5 bg-white border border-surface-300 rounded text-sm"
              >
                {SELECTOR_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <div className="md:col-span-2 flex gap-2">
                <input
                  type="text"
                  value={action.selector?.value || ''}
                  onChange={(e) =>
                    updateAction(index, {
                      selector: {
                        selector_type: action.selector?.selector_type || 'css',
                        value: e.target.value,
                      },
                    })
                  }
                  placeholder="#id, .class, //xpath"
                  className="flex-1 px-2 py-1.5 bg-white border border-surface-300 rounded text-sm"
                />
                <button
                  onClick={() => setSelectorPickerIndex(index)}
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
              onChange={(e) => updateAction(index, { value: e.target.value })}
              placeholder={action.action_type === 'navigate' ? 'https://example.com' : ''}
              className="w-full px-2 py-1.5 bg-white border border-surface-300 rounded text-sm"
            />
          )}

          {action.action_type === 'wait' && (
            <input
              type="number"
              value={action.delay_ms || 1000}
              onChange={(e) => updateAction(index, { delay_ms: parseInt(e.target.value, 10) || 0 })}
              className="w-full px-2 py-1.5 bg-white border border-surface-300 rounded text-sm"
            />
          )}
        </div>
      ))}

      <button
        onClick={addAction}
        className="flex items-center gap-2 px-3 py-1.5 text-sm text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
      >
        <Plus size={14} />
        {t('webbridge.workflowEditor.addAction')}
      </button>

      <ActionRecorderPanel onExportToWorkflow={importRecorded} />

      {selectorPickerIndex != null && currentScreenshot && (
        <VisualSelectorPicker
          screenshotUrl={currentScreenshot}
          onSelect={handleSelectorPicked}
          onClose={() => setSelectorPickerIndex(null)}
        />
      )}
    </div>
  )
}

import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { cn } from '@/utils'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { ActionRecorderPanel } from '@/components/WebBridge/ActionRecorderPanel'
import { VisualSelectorPicker } from '@/components/WebBridge/VisualSelectorPicker'
import { WorkspaceFilePicker } from '@/components/WebBridge/WorkspaceFilePicker'
import type { BrowserAction, ActionType, SelectorType, ElementSelector } from '@/types/webbridge'
import { ACTION_TYPES, SELECTOR_TYPES } from '@/types/webbridge'
import {
  Play,
  MousePointerClick,
  Type,
  Camera,
  FileText,
  Globe,
  Clock,
  Code,
  Download,
  Loader2,
} from 'lucide-react'

const ACTION_ICONS: Record<ActionType, React.ReactNode> = {
  navigate: <Globe size={14} />,
  refresh: <Globe size={14} />,
  go_back: <Globe size={14} />,
  go_forward: <Globe size={14} />,
  click: <MousePointerClick size={14} />,
  double_click: <MousePointerClick size={14} />,
  right_click: <MousePointerClick size={14} />,
  hover: <MousePointerClick size={14} />,
  type: <Type size={14} />,
  clear: <Type size={14} />,
  select: <Type size={14} />,
  check: <Type size={14} />,
  upload: <FileText size={14} />,
  extract_text: <FileText size={14} />,
  extract_table: <FileText size={14} />,
  extract_html: <FileText size={14} />,
  export_table: <Download size={14} />,
  screenshot: <Camera size={14} />,
  get_url: <Globe size={14} />,
  get_title: <Globe size={14} />,
  scroll: <MousePointerClick size={14} />,
  scroll_to: <MousePointerClick size={14} />,
  scroll_to_top: <MousePointerClick size={14} />,
  scroll_to_bottom: <MousePointerClick size={14} />,
  new_tab: <Globe size={14} />,
  switch_tab: <Globe size={14} />,
  close_tab: <Globe size={14} />,
  list_tabs: <Globe size={14} />,
  wait: <Clock size={14} />,
  wait_for_element: <Clock size={14} />,
  wait_for_navigation: <Clock size={14} />,
  evaluate: <Code size={14} />,
  download: <Download size={14} />,
  save_page: <Download size={14} />,
}

const ACTION_NEEDS_VALUE: ActionType[] = ['navigate', 'type', 'clear', 'select', 'check', 'upload', 'wait', 'evaluate', 'download', 'save_page', 'export_table']
const ACTION_NEEDS_SELECTOR: ActionType[] = ['click', 'double_click', 'right_click', 'hover', 'type', 'clear', 'select', 'check', 'upload', 'wait_for_element', 'export_table']

export function ActionPanel() {
  const { t } = useTranslation()
  const { sendAction, pageState, currentScreenshot, isExecuting, status } = useWebBridgeStore()

  const [actionType, setActionType] = useState<ActionType>('navigate')
  const [selectorType, setSelectorType] = useState<SelectorType>('css')
  const [selectorValue, setSelectorValue] = useState('')
  const [value, setValue] = useState('')
  const [delayMs, setDelayMs] = useState(1000)
  const [result, setResult] = useState<{ success: boolean; message: string; data?: unknown } | null>(null)
  const [isSelectorPickerOpen, setIsSelectorPickerOpen] = useState(false)
  const [isFilePickerOpen, setIsFilePickerOpen] = useState(false)

  const isConnected = status === 'connected'

  const handleSelectorPicked = (selector: ElementSelector | null) => {
    if (selector) {
      setSelectorType(selector.selector_type)
      setSelectorValue(selector.value)
    }
  }

  const handleFilePicked = (relativePath: string) => {
    setValue(relativePath)
    setIsFilePickerOpen(false)
  }

  const handleExecute = async () => {
    const action: BrowserAction = { action_type: actionType }

    if (ACTION_NEEDS_SELECTOR.includes(actionType) && selectorValue.trim()) {
      action.selector = {
        selector_type: selectorType,
        value: selectorValue.trim(),
      }
    }

    if (ACTION_NEEDS_VALUE.includes(actionType) && value.trim()) {
      action.value = value.trim()
    }

    if (actionType === 'wait') {
      action.delay_ms = delayMs
    }

    const res = await sendAction(action)
    if (res) {
      setResult({
        success: res.success,
        message: res.success ? '执行成功' : res.error_message || '执行失败',
        data: res.data,
      })
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-6">
        <h2 className="text-lg font-semibold text-surface-900 mb-4">{t('webbridge.actionPanel.title')}</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-surface-700 mb-1">
              {t('webbridge.actionPanel.actionType')}
            </label>
            <select
              value={actionType}
              onChange={(e) => setActionType(e.target.value as ActionType)}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              {ACTION_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`webbridge.actionTypes.${type}`, type)}
                </option>
              ))}
            </select>
          </div>

          {ACTION_NEEDS_SELECTOR.includes(actionType) && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-1">
                <label className="block text-sm font-medium text-surface-700 mb-1">
                  {t('webbridge.actionPanel.selectorType')}
                </label>
                <select
                  value={selectorType}
                  onChange={(e) => setSelectorType(e.target.value as SelectorType)}
                  className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {SELECTOR_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-surface-700 mb-1">
                  {t('webbridge.actionPanel.selectorValue')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={selectorValue}
                    onChange={(e) => setSelectorValue(e.target.value)}
                    className="flex-1 px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                    placeholder="#id, .class, //xpath"
                  />
                  <button
                    onClick={() => setIsSelectorPickerOpen(true)}
                    disabled={!currentScreenshot}
                    className="px-3 py-2 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg text-sm font-medium transition-colors disabled:opacity-60 whitespace-nowrap"
                  >
                    {t('webbridge.visualSelector.title')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {ACTION_NEEDS_VALUE.includes(actionType) && actionType !== 'wait' && (
            <div>
              <label className="block text-sm font-medium text-surface-700 mb-1">
                {t('webbridge.actionPanel.value')}
              </label>
              {actionType === 'evaluate' ? (
                <textarea
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="return document.title;"
                />
              ) : (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="flex-1 px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                    placeholder={actionType === 'navigate' ? 'https://example.com' : actionType === 'export_table' ? 'csv 或 xlsx' : actionType === 'upload' ? '从工作区选择文件' : ''}
                    readOnly={actionType === 'upload'}
                  />
                  {actionType === 'upload' && (
                    <button
                      onClick={() => setIsFilePickerOpen(true)}
                      className="px-3 py-2 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
                    >
                      选择文件
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {actionType === 'wait' && (
            <div>
              <label className="block text-sm font-medium text-surface-700 mb-1">
                {t('webbridge.actionPanel.delayMs')}
              </label>
              <input
                type="number"
                value={delayMs}
                onChange={(e) => setDelayMs(parseInt(e.target.value, 10) || 0)}
                className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          )}

          <button
            onClick={handleExecute}
            disabled={!isConnected || isExecuting}
            className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
          >
            {isExecuting ? <Loader2 size={16} className="animate-spin" /> : ACTION_ICONS[actionType]}
            {isExecuting ? t('webbridge.actionPanel.executing') : t('webbridge.actionPanel.execute')}
          </button>
        </div>

        {result && (
          <div
            className={cn(
              'mt-4 p-3 rounded-lg text-sm border',
              result.success
                ? 'bg-green-50 border-green-200 text-green-800'
                : 'bg-red-50 border-red-200 text-red-800'
            )}
          >
            <p className="font-medium">{result.message}</p>
            {result.data !== undefined && result.data !== null && (
              <pre className="mt-2 p-2 bg-black/5 rounded text-xs overflow-auto max-h-40">
                {typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>

      <ActionRecorderPanel />

      {pageState && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-surface-700 mb-2">{t('webbridge.actionPanel.pageState')}</h3>
            <div className="text-sm space-y-1 text-surface-600">
              <p><span className="text-surface-400">URL:</span> {pageState.url}</p>
              <p><span className="text-surface-400">Title:</span> {pageState.title}</p>
              <p><span className="text-surface-400">Viewport:</span> {pageState.viewport_width} x {pageState.viewport_height}</p>
              <p><span className="text-surface-400">Scroll:</span> {pageState.scroll_x}, {pageState.scroll_y}</p>
              <p><span className="text-surface-400">Ready:</span> {pageState.ready_state}</p>
            </div>
          </div>

          {currentScreenshot && (
            <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-4">
              <h3 className="text-sm font-semibold text-surface-700 mb-2">{t('webbridge.actionPanel.screenshot')}</h3>
              <img
                src={currentScreenshot}
                alt="screenshot"
                className="w-full rounded border border-surface-200"
              />
            </div>
          )}
        </div>
      )}

      {isSelectorPickerOpen && currentScreenshot && (
        <VisualSelectorPicker
          screenshotUrl={currentScreenshot}
          onSelect={handleSelectorPicked}
          onClose={() => setIsSelectorPickerOpen(false)}
        />
      )}

      {isFilePickerOpen && (
        <WorkspaceFilePicker
          onSelect={handleFilePicked}
          onCancel={() => setIsFilePickerOpen(false)}
        />
      )}
    </div>
  )
}

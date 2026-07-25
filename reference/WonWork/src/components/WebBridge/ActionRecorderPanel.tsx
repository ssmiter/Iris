import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import type { BrowserAction } from '@/types/webbridge'
import { cn } from '@/utils'
import {
  Circle,
  Square,
  Trash2,
  GripVertical,
  Copy,
  Save,
  Play,
  Loader2,
} from 'lucide-react'

interface ActionRecorderPanelProps {
  onExportToWorkflow?: (actions: BrowserAction[]) => void
}

function formatActionSummary(action: BrowserAction): string {
  const parts: string[] = [action.action_type]
  if (action.selector?.value) parts.push(`on "${action.selector.value}"`)
  if (action.value) parts.push(`"${action.value.slice(0, 40)}"`)
  return parts.join(' ')
}

export function ActionRecorderPanel({ onExportToWorkflow }: ActionRecorderPanelProps) {
  const { t } = useTranslation()
  const {
    isRecording,
    recordedActions,
    startRecording,
    stopRecording,
    clearRecordedActions,
    removeRecordedAction,
    reorderRecordedActions,
    runActionsOnce,
    isExecuting,
  } = useWebBridgeStore()

  const [copied, setCopied] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [isReplaying, setIsReplaying] = useState(false)

  const handleToggleRecording = async () => {
    if (isRecording) {
      await stopRecording()
    } else {
      await startRecording()
    }
  }

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(recordedActions, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore clipboard errors
    }
  }

  const handleReplay = async () => {
    if (recordedActions.length === 0) return
    setIsReplaying(true)
    try {
      await runActionsOnce(recordedActions)
    } finally {
      setIsReplaying(false)
    }
  }

  const handleDragStart = (index: number) => {
    setDragIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (dragIndex === null || dragIndex === index) return
    reorderRecordedActions(dragIndex, index)
    setDragIndex(index)
  }

  const handleDragEnd = () => {
    setDragIndex(null)
  }

  return (
    <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-surface-900">
          {t('webbridge.recorder.title')}
        </h2>
        <div className="flex items-center gap-2">
          {isRecording && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-red-600">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
              </span>
              {t('webbridge.recorder.recording')}
            </span>
          )}
          <button
            onClick={handleToggleRecording}
            disabled={isExecuting || isReplaying}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-60',
              isRecording
                ? 'bg-red-50 text-red-700 hover:bg-red-100 border border-red-200'
                : 'bg-primary-600 text-white hover:bg-primary-500'
            )}
          >
            {isRecording ? (
              <>
                <Square size={14} /> {t('webbridge.recorder.stop')}
              </>
            ) : (
              <>
                <Circle size={14} className="fill-current" /> {t('webbridge.recorder.start')}
              </>
            )}
          </button>
        </div>
      </div>

      <p className="text-sm text-surface-500">
        {t('webbridge.recorder.description')}
      </p>

      {recordedActions.length === 0 ? (
        <div className="py-8 text-center text-sm text-surface-400 border border-dashed border-surface-300 rounded-lg">
          {t('webbridge.recorder.empty')}
        </div>
      ) : (
        <div className="space-y-2">
          {recordedActions.map((action, index) => (
            <div
              key={`${action.action_type}-${index}`}
              draggable
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragEnd={handleDragEnd}
              className={cn(
                'flex items-center gap-2 p-2.5 bg-surface-50 border border-surface-200 rounded-lg text-sm group',
                dragIndex === index && 'opacity-50 border-primary-300 bg-primary-50'
              )}
            >
              <GripVertical size={14} className="text-surface-300 cursor-grab" />
              <span className="font-mono text-xs text-surface-400 w-6">{index + 1}</span>
              <span className="flex-1 truncate text-surface-700">{formatActionSummary(action)}</span>
              <button
                onClick={() => removeRecordedAction(index)}
                className="p-1.5 text-surface-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors opacity-0 group-hover:opacity-100"
                title={t('webbridge.recorder.delete')}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {recordedActions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <button
            onClick={handleReplay}
            disabled={isReplaying || isExecuting}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
          >
            {isReplaying ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {t('webbridge.recorder.replay')}
          </button>

          {onExportToWorkflow && (
            <button
              onClick={() => onExportToWorkflow(recordedActions)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-50 text-primary-700 hover:bg-primary-100 rounded-lg text-sm font-medium transition-colors"
            >
              <Save size={14} />
              {t('webbridge.recorder.exportToWorkflow')}
            </button>
          )}

          <button
            onClick={handleCopyJson}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-100 text-surface-700 hover:bg-surface-200 rounded-lg text-sm font-medium transition-colors"
          >
            <Copy size={14} />
            {copied ? t('webbridge.recorder.copied') : t('webbridge.recorder.copyJson')}
          </button>

          <button
            onClick={clearRecordedActions}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            <Trash2 size={14} />
            {t('webbridge.recorder.clear')}
          </button>
        </div>
      )}
    </div>
  )
}

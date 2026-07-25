import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { Trash2, AlertCircle, Play, Activity, Settings } from 'lucide-react'

export function LogPanel() {
  const { t } = useTranslation()
  const { logs, clearLogs } = useWebBridgeStore()

  const typeIcons: Record<typeof logs[number]['type'], React.ReactNode> = {
    action: <Play size={14} />,
    workflow: <Activity size={14} />,
    system: <Settings size={14} />,
    error: <AlertCircle size={14} />,
  }

  return (
    <div className="max-w-4xl mx-auto h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-surface-900">{t('webbridge.logPanel.title')}</h2>
        <button
          onClick={clearLogs}
          disabled={logs.length === 0}
          className="flex items-center gap-2 px-3 py-1.5 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          <Trash2 size={14} />
          {t('webbridge.logPanel.clear')}
        </button>
      </div>

      <div className="flex-1 bg-white rounded-xl border border-surface-200 shadow-sm overflow-hidden">
        {logs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-surface-400 text-sm">
            <Activity size={32} className="mb-2 opacity-50" />
            {t('webbridge.logPanel.empty')}
          </div>
        ) : (
          <div className="h-full overflow-auto p-4 space-y-2">
            {logs.map((log) => (
              <div
                key={log.id}
                className={cn(
                  'p-3 rounded-lg border text-sm',
                  log.type === 'error'
                    ? 'bg-red-50 border-red-100'
                    : log.type === 'workflow'
                      ? 'bg-blue-50 border-blue-100'
                      : 'bg-surface-50 border-surface-100'
                )}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-surface-400">{typeIcons[log.type]}</span>
                  <span className="text-xs text-surface-400">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  {log.workflowId && (
                    <span className="text-xs text-surface-400">· workflow:{log.workflowId.slice(0, 8)}</span>
                  )}
                </div>
                <p className="text-surface-700">{log.message}</p>
                {log.result && (
                  <pre className="mt-2 p-2 bg-black/5 rounded text-xs overflow-auto max-h-32">
                    {log.result.success
                      ? log.result.data !== undefined
                        ? typeof log.result.data === 'string'
                          ? log.result.data
                          : JSON.stringify(log.result.data, null, 2)
                        : 'OK'
                      : log.result.error_message || 'Failed'}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

import { useContextPanelStore } from '@/stores/contextPanelStore'
import { cn } from '@/utils'
import { Loader2, CheckCircle2, XCircle, Circle, ClipboardList } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function TaskProgressList() {
  const { tasks } = useContextPanelStore()
  const { t } = useTranslation()

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-surface-200 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <ClipboardList size={14} className="text-surface-500" />
          <span className="text-xs font-semibold text-surface-700">{t('chat.taskProgressList.title')}</span>
        </div>
        {tasks.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-100 text-surface-500">
            {tasks.length}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-surface-400 gap-1">
            <ClipboardList size={20} />
            <span className="text-[11px]">{t('chat.taskProgressList.noTasks')}</span>
          </div>
        ) : (
          <div className="space-y-1">
            {tasks.map((task) => (
              <div
                key={task.id}
                className={cn(
                  'flex items-start gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors',
                  task.status === 'completed'
                    ? 'bg-green-50/50'
                    : task.status === 'running'
                      ? 'bg-primary-50'
                      : task.status === 'error'
                        ? 'bg-red-50'
                        : 'bg-surface-50'
                )}
              >
                <div className="mt-0.5 flex-shrink-0">
                  {task.status === 'pending' && (
                    <Circle size={14} className="text-surface-400" />
                  )}
                  {task.status === 'running' && (
                    <Loader2 size={14} className="animate-spin text-primary-500" />
                  )}
                  {task.status === 'completed' && (
                    <CheckCircle2 size={14} className="text-green-500" />
                  )}
                  {task.status === 'error' && (
                    <XCircle size={14} className="text-red-500" />
                  )}
                </div>
                <span
                  className={cn(
                    'flex-1 leading-relaxed',
                    task.status === 'completed'
                      ? 'line-through text-surface-400'
                      : task.status === 'running'
                        ? 'text-primary-700 font-medium'
                        : task.status === 'error'
                          ? 'text-red-600'
                          : 'text-surface-600'
                  )}
                >
                  {task.title}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

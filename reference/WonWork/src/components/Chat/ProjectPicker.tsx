import { useEffect, useState } from 'react'
import { FolderOpen, HardDrive, ChevronRight, X, Check, Loader2, AlertCircle } from 'lucide-react'
import { workspaceApi } from '@/api/client'
import { useProjectStore } from '@/stores/projectStore'
import { useConversationStore } from '@/stores/conversationStore'
import { cn } from '@/utils'
import { useTranslation } from 'react-i18next'

interface BrowseEntry {
  name: string
  path: string
  isDirectory: boolean
}

interface ProjectPickerProps {
  onClose: () => void
}

/**
 * S4 项目选择器（仅 MESCLI Local 可用）。
 * 盘符列表 → 逐级下钻，也支持手动输入路径。
 * 选定后绑定到当前会话（useProjectStore.bindProject，后端幂等断言）。
 */
export function ProjectPicker({ onClose }: ProjectPickerProps) {
  const { t } = useTranslation()
  const [currentPath, setCurrentPath] = useState<string | null>(null) // null = 盘符列表
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')
  const [binding, setBinding] = useState(false)
  const bindProject = useProjectStore((s) => s.bindProject)
  const currentConversationId = useConversationStore((s) => s.currentConversationId)

  const loadDir = async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await workspaceApi.browse(path)
      setCurrentPath(result.path || null)
      setEntries(result.entries)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setEntries([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadDir()
  }, [])

  // 面包屑：C:\foo\bar → [C:\, foo, bar]
  const breadcrumbs = (() => {
    if (!currentPath) return []
    const parts = currentPath.replace(/[/\\]+$/, '').split(/[/\\]/)
    const crumbs: { label: string; path: string }[] = []
    let acc = ''
    for (let i = 0; i < parts.length; i++) {
      if (i === 0) {
        acc = parts[0] + '\\'
      } else {
        acc = acc + parts[i] + '\\'
      }
      crumbs.push({ label: parts[i], path: acc.replace(/\\$/, i === 0 ? '\\' : '') })
    }
    return crumbs
  })()

  const handleBind = async (path: string) => {
    setBinding(true)
    setError(null)
    try {
      await bindProject(currentConversationId, path)
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
    } finally {
      setBinding(false)
    }
  }

  const handleManualSubmit = () => {
    const trimmed = manualPath.trim()
    if (trimmed) handleBind(trimmed)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-200">
          <div className="flex items-center gap-2">
            <FolderOpen size={16} className="text-primary-500" />
            <span className="text-sm font-medium text-surface-800">
              {t('chat.projectPicker.title', '选择项目目录')}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-surface-100 text-surface-500"
          >
            <X size={16} />
          </button>
        </div>

        {/* 面包屑 */}
        <div className="px-4 py-2 border-b border-surface-100 flex items-center gap-1 text-xs text-surface-500 overflow-x-auto">
          <button
            onClick={() => loadDir()}
            className="flex items-center gap-1 hover:text-primary-600 flex-shrink-0"
          >
            <HardDrive size={12} />
            <span>{t('chat.projectPicker.computer', '此电脑')}</span>
          </button>
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1 flex-shrink-0">
              <ChevronRight size={10} className="text-surface-300" />
              <button
                onClick={() => loadDir(crumb.path)}
                className={cn(
                  'hover:text-primary-600 max-w-[120px] truncate',
                  i === breadcrumbs.length - 1 && 'text-surface-700 font-medium'
                )}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>

        {/* 目录列表 */}
        <div className="flex-1 overflow-auto min-h-[200px]">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-surface-400">
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : entries.length === 0 ? (
            <div className="text-xs text-surface-400 text-center py-10">
              {t('chat.projectPicker.empty', '此目录没有可进入的子目录')}
            </div>
          ) : (
            <div className="py-1">
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => entry.isDirectory && loadDir(entry.path)}
                  className="w-full flex items-center gap-2 px-4 py-1.5 text-xs text-surface-700 hover:bg-surface-50 transition-colors"
                >
                  {entry.isDirectory ? (
                    <FolderOpen size={14} className="text-amber-500 flex-shrink-0" />
                  ) : (
                    <HardDrive size={14} className="text-surface-400 flex-shrink-0" />
                  )}
                  <span className="truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="px-4 py-2 flex items-start gap-1.5 text-xs text-red-600 bg-red-50 border-t border-red-100">
            <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* 手动输入 */}
        <div className="px-4 py-2 border-t border-surface-100">
          <input
            type="text"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleManualSubmit()}
            placeholder={t('chat.projectPicker.manualPlaceholder', '或直接输入路径，如 D:\\projects\\mes')}
            className="w-full text-xs px-2.5 py-1.5 border border-surface-200 rounded-md focus:outline-none focus:border-primary-400 text-surface-700"
          />
        </div>

        {/* 底部操作 */}
        <div className="px-4 py-3 border-t border-surface-200 flex items-center justify-between gap-2">
          <span className="text-[10px] text-surface-400 truncate flex-1" title={currentPath ?? ''}>
            {currentPath || t('chat.projectPicker.pickDrive', '请选择盘符')}
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-surface-600 hover:bg-surface-100 rounded-md transition-colors"
            >
              {t('common.cancel', '取消')}
            </button>
            <button
              onClick={() => (manualPath.trim() ? handleManualSubmit() : currentPath && handleBind(currentPath))}
              disabled={binding || (!currentPath && !manualPath.trim())}
              className="px-3 py-1.5 text-xs bg-primary-500 text-white rounded-md hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 transition-colors"
            >
              {binding ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              {t('chat.projectPicker.select', '选择此目录')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

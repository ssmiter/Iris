import { useEffect, useMemo, useState } from 'react'
import {
  useWorkspaceFileStore,
  type FileNode,
} from '@/stores/workspaceFileStore'
import {
  Folder,
  FolderOpen,
  FileText,
  RefreshCw,
  FolderSync,
  Unlink,
  Eye,
  Trash2,
  X,
  ChevronRight,
  ChevronDown,
  HardDrive,
  Search,
  Copy,
  Download,
} from 'lucide-react'
import { cn } from '@/utils'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { formatFileSize } from '@/utils/formatFileSize'
import { getFileIconInfo, getSourceBadge } from '@/utils/fileIcon'
import { useProjectStore } from '@/stores/projectStore'
import { useConversationStore } from '@/stores/conversationStore'
import { workspaceApi } from '@/api/client'
import { ProjectPicker } from './ProjectPicker'

function FileExtensionChip({ name }: { name: string }) {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : ''
  if (!ext) return null
  return (
    <span className="text-[9px] uppercase px-1 py-0 rounded bg-surface-100 text-surface-500 flex-shrink-0">
      {ext}
    </span>
  )
}

function FileTreeNode({
  node,
  depth = 0,
}: {
  node: FileNode
  depth?: number
}) {
  const {
    expandedPaths,
    selectedPath,
    toggleExpanded,
    selectPath,
    previewFile,
  } = useWorkspaceFileStore()
  const isExpanded = expandedPaths.has(node.path)
  const isSelected = selectedPath === node.path
  const isDirectory = node.type === 'directory'
  const iconInfo = isDirectory ? null : getFileIconInfo(node.name)
  const sourceBadge = !isDirectory && node.source ? getSourceBadge(node.source) : null

  return (
    <div className="select-none">
      <div
        className={cn(
          'group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer transition-colors',
          isSelected ? 'bg-primary-50 text-primary-700' : 'hover:bg-surface-50'
        )}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => {
          if (isDirectory) {
            toggleExpanded(node.path)
            selectPath(node.path)
          } else {
            selectPath(node.path)
          }
        }}
      >
        {isDirectory ? (
          isExpanded ? (
            <ChevronDown size={12} className="text-surface-400 flex-shrink-0" />
          ) : (
            <ChevronRight size={12} className="text-surface-400 flex-shrink-0" />
          )
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}

        {isDirectory ? (
          isExpanded ? (
            <FolderOpen size={14} className="text-amber-500 flex-shrink-0" />
          ) : (
            <Folder size={14} className="text-amber-500 flex-shrink-0" />
          )
        ) : iconInfo ? (
          <iconInfo.icon size={14} className={cn('flex-shrink-0', iconInfo.colorClass)} />
        ) : (
          <FileText size={14} className="text-primary-500 flex-shrink-0" />
        )}

        <span className="text-xs truncate flex-1 min-w-0" title={node.path}>
          {node.name}
        </span>

        {!isDirectory && <FileExtensionChip name={node.name} />}

        {sourceBadge && (
          <span
            className={cn(
              'text-[9px] px-1 py-0 rounded flex-shrink-0',
              sourceBadge.colorClass
            )}
            title={`来源: ${node.source}`}
          >
            {sourceBadge.label}
          </span>
        )}

        {!isDirectory && node.size !== undefined && node.size > 0 && (
          <span className="text-[10px] text-surface-400 flex-shrink-0">
            {formatFileSize(node.size)}
          </span>
        )}

        {!isDirectory && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              previewFile(node.path)
            }}
            className="p-0.5 rounded hover:bg-primary-100 text-surface-400 hover:text-primary-600 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
            title="预览"
          >
            <Eye size={12} />
          </button>
        )}
      </div>

      {isDirectory && isExpanded && node.children && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <FileTreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  const q = query.toLowerCase()
  return nodes
    .map((node) => {
      if (node.type === 'directory') {
        const filteredChildren = node.children ? filterTree(node.children, q) : []
        const selfMatch = node.name.toLowerCase().includes(q)
        if (selfMatch || filteredChildren.length > 0) {
          return { ...node, children: filteredChildren }
        }
        return null
      }
      return node.name.toLowerCase().includes(q) ? node : null
    })
    .filter((n): n is FileNode => n !== null)
}

function collectFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.type === 'file') files.push(node)
    if (node.children) files.push(...collectFiles(node.children))
  }
  return files
}

export function WorkspaceFilesPanel() {
  const { t } = useTranslation()
  const {
    tree,
    entries,
    isLoading,
    error,
    isConnected,
    isFallbackMode,
    workspacePath,
    refresh,
    init,
    connectWorkspace,
    disconnectWorkspace,
    deleteFile,
    previewPath,
    previewContent,
    closePreview,
    selectedPath,
  } = useWorkspaceFileStore()

  const [query, setQuery] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const activeProject = useProjectStore((s) => s.activeProject)
  const isProjectModeAvailable = useProjectStore((s) => s.isProjectModeAvailable())
  const refreshActiveProject = useProjectStore((s) => s.refreshActiveProject)
  const unbindProject = useProjectStore((s) => s.unbindProject)
  const currentConversationId = useConversationStore((s) => s.currentConversationId)

  useEffect(() => {
    init()
  }, [init])

  // S4：面板挂载时同步后端活跃项目根（仅 Local 生效，其他模式静默 no-op）
  useEffect(() => {
    refreshActiveProject()
  }, [refreshActiveProject])

  const totalSize = useMemo(
    () => entries.reduce((sum, e) => sum + (e.size || 0), 0),
    [entries]
  )
  const fileCount = entries.filter((e) => !e.path.endsWith('/')).length

  const filteredTree = useMemo(
    () => (query.trim() ? filterTree(tree, query.trim()) : tree),
    [tree, query]
  )

  const selectedEntry = useMemo(
    () => entries.find((e) => e.path === selectedPath),
    [entries, selectedPath]
  )

  const handleCopyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
      toast.success(t('chat.workspaceFilesPanel.copied'))
    } catch {
      toast.error(t('chat.workspaceFilesPanel.copyFailed'))
    }
  }

  const handleDownload = (path: string) => {
    // S4 D5：统一走后端下载端点（双根共用）；Standalone 下 downloadUrl 原样透传路径
    const a = document.createElement('a')
    a.href = workspaceApi.downloadUrl(path)
    a.download = path.split('/').pop() || 'download'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const statusText = isConnected
    ? t('chat.workspaceFilesPanel.connected', { path: workspacePath || 'workspace' })
    : isFallbackMode
    ? t('chat.workspaceFilesPanel.fallback')
    : t('chat.workspaceFilesPanel.disconnected')

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-surface-200 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <HardDrive size={14} className="text-surface-500 flex-shrink-0" />
          <span className="text-xs font-semibold text-surface-700 truncate">
            {t('chat.workspaceFilesPanel.title')}
          </span>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={() => refresh()}
            disabled={isLoading}
            className="p-1 rounded hover:bg-surface-100 text-surface-500 hover:text-surface-700 disabled:opacity-50 transition-colors"
            title={t('chat.workspaceFilesPanel.refresh')}
          >
            <RefreshCw size={12} className={cn(isLoading && 'animate-spin')} />
          </button>
          {isConnected ? (
            <button
              onClick={() => disconnectWorkspace()}
              className="p-1 rounded hover:bg-surface-100 text-surface-500 hover:text-red-500 transition-colors"
              title={t('chat.workspaceFilesPanel.disconnect')}
            >
              <Unlink size={12} />
            </button>
          ) : (
            <button
              onClick={() => connectWorkspace()}
              className="p-1 rounded hover:bg-surface-100 text-surface-500 hover:text-primary-600 transition-colors"
              title={t('chat.workspaceFilesPanel.connect')}
            >
              <FolderSync size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="px-3 py-1.5 border-b border-surface-100 text-[10px] text-surface-500 flex items-center justify-between">
        <span className="truncate flex-1 min-w-0" title={statusText}>
          {statusText}
        </span>
        {fileCount > 0 && (
          <span className="flex-shrink-0">
            {t('chat.workspaceFilesPanel.stats', { count: fileCount, size: formatFileSize(totalSize) })}
          </span>
        )}
      </div>

      {/* S4 项目栏：仅 MESCLI Local 显示；选定后 /project 命名空间指向该目录 */}
      {isProjectModeAvailable && (
        <div className="px-3 py-1.5 border-b border-surface-100 flex items-center gap-1.5">
          <FolderOpen size={12} className="text-amber-500 flex-shrink-0" />
          {activeProject ? (
            <>
              <span
                className="text-[10px] text-surface-600 truncate flex-1 min-w-0"
                title={activeProject.path}
              >
                {activeProject.name || activeProject.path}
              </span>
              <button
                onClick={() => setPickerOpen(true)}
                className="text-[10px] text-primary-600 hover:text-primary-700 flex-shrink-0"
              >
                {t('chat.workspaceFilesPanel.switchProject', '切换')}
              </button>
              <button
                onClick={async () => {
                  unbindProject(currentConversationId)
                  try {
                    await workspaceApi.clearProject()
                  } catch {
                    // 清除失败不阻断本地解绑
                  }
                  await refreshActiveProject()
                  refresh()
                }}
                className="text-[10px] text-surface-400 hover:text-red-500 flex-shrink-0"
              >
                {t('chat.workspaceFilesPanel.unbindProject', '解除')}
              </button>
            </>
          ) : (
            <>
              <span className="text-[10px] text-surface-400 flex-1 min-w-0">
                {t('chat.workspaceFilesPanel.noProject', '未绑定项目（/project 不可用）')}
              </span>
              <button
                onClick={() => setPickerOpen(true)}
                className="text-[10px] text-primary-600 hover:text-primary-700 flex-shrink-0"
              >
                {t('chat.workspaceFilesPanel.selectProject', '选择项目')}
              </button>
            </>
          )}
        </div>
      )}

      {pickerOpen && (
        <ProjectPicker
          onClose={() => {
            setPickerOpen(false)
            refreshActiveProject()
            refresh()
          }}
        />
      )}

      <div className="px-3 py-2 border-b border-surface-100">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('chat.workspaceFilesPanel.searchPlaceholder')}
            className="w-full pl-7 pr-2 py-1 text-xs rounded-md border border-surface-200 bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
        {error && (
          <div className="text-[11px] text-red-500 px-2 py-1 mb-2 bg-red-50 rounded">
            {error}
          </div>
        )}

        {filteredTree.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-surface-400 gap-2">
            <Folder size={24} />
            <div className="text-[11px] text-center px-4 leading-relaxed">
              {isLoading
                ? t('chat.workspaceFilesPanel.loading')
                : query.trim()
                ? t('chat.workspaceFilesPanel.noSearchResults')
                : (
                    <>
                      <p className="font-medium text-surface-500">{t('chat.workspaceFilesPanel.emptyTitle')}</p>
                      <p>{t('chat.workspaceFilesPanel.emptyHint')}</p>
                    </>
                  )}
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredTree.map((node) => (
              <FileTreeNode key={node.path} node={node} />
            ))}
          </div>
        )}
      </div>

      {selectedPath && !previewPath && (
        <div className="px-3 py-2 border-t border-surface-200 bg-surface-50 flex items-center gap-1.5">
          <span className="text-[10px] text-surface-500 truncate flex-1" title={selectedPath}>
            {selectedPath}
          </span>
          <button
            onClick={() => handleCopyPath(selectedPath)}
            className="p-1 rounded hover:bg-surface-200 text-surface-400 hover:text-surface-600 transition-colors flex-shrink-0"
            title={t('chat.workspaceFilesPanel.copyPath')}
          >
            <Copy size={12} />
          </button>
          {selectedEntry && (
            <button
              onClick={() => handleDownload(selectedPath)}
              className="p-1 rounded hover:bg-surface-200 text-surface-400 hover:text-surface-600 transition-colors flex-shrink-0"
              title={t('chat.workspaceFilesPanel.download')}
            >
              <Download size={12} />
            </button>
          )}
          <button
            onClick={() => {
              if (selectedPath) deleteFile(selectedPath)
            }}
            className="p-1 rounded hover:bg-red-100 text-surface-400 hover:text-red-500 transition-colors flex-shrink-0"
            title={t('chat.workspaceFilesPanel.delete')}
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}

      {previewPath && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => closePreview()}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-surface-200 gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {(() => {
                  const iconInfo = getFileIconInfo(previewPath)
                  return <iconInfo.icon size={16} className={cn('flex-shrink-0', iconInfo.colorClass)} />
                })()}
                <span className="text-sm font-medium text-surface-800 truncate" title={previewPath}>
                  {previewPath}
                </span>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => handleCopyPath(previewPath)}
                  className="p-1.5 rounded hover:bg-surface-100 text-surface-500 transition-colors"
                  title={t('chat.workspaceFilesPanel.copyPath')}
                >
                  <Copy size={14} />
                </button>
                <button
                  onClick={() => closePreview()}
                  className="p-1.5 rounded hover:bg-surface-100 text-surface-500"
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {previewContent === null || previewContent === '加载中...' ? (
                <div className="text-xs text-surface-400">{t('chat.workspaceFilesPanel.loading')}</div>
              ) : previewContent.startsWith('[') && previewContent.includes('文档:') ? (
                // 后端返回的二进制占位描述（如 [PPT文档: ...]）
                <div className="flex flex-col items-center justify-center gap-3 py-8 text-surface-500">
                  {(() => {
                    const iconInfo = getFileIconInfo(previewPath)
                    return <iconInfo.icon size={48} className={cn(iconInfo.colorClass)} />
                  })()}
                  <p className="text-sm">{previewContent}</p>
                  <p className="text-xs text-surface-400 text-center max-w-md">
                    {t('chat.workspaceFilesPanel.binaryHint')}
                  </p>
                </div>
              ) : (
                <pre className="text-xs text-surface-700 whitespace-pre-wrap font-mono">
                  {previewContent}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

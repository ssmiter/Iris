import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { cn, formatBytes } from '@/utils'
import type { WorkspaceFileInfo } from '@/types/webbridge'

const SUBDIRS = ['downloads', 'snapshots', 'exports', 'recordings'] as const

type Subdir = (typeof SUBDIRS)[number]

const SUBDIR_LABELS: Record<Subdir, string> = {
  downloads: '下载',
  snapshots: '快照',
  exports: '导出',
  recordings: '录制',
}

export function WorkspaceBrowser() {
  const { t } = useTranslation()
  const {
    workspaceFiles,
    workspaceLoading,
    workspaceError,
    listWorkspaceFiles,
    deleteWorkspaceFile,
    readWorkspaceFile,
  } = useWebBridgeStore()

  const [activeSubdir, setActiveSubdir] = useState<Subdir | 'all'>('all')
  const [preview, setPreview] = useState<{ file: WorkspaceFileInfo; base64: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const refresh = useCallback(() => {
    listWorkspaceFiles(activeSubdir === 'all' ? undefined : activeSubdir)
  }, [activeSubdir, listWorkspaceFiles])

  useEffect(() => {
    refresh()
  }, [refresh])

  const filteredFiles = activeSubdir === 'all'
    ? workspaceFiles
    : workspaceFiles.filter((f) => f.subdir === activeSubdir)

  const handleDelete = async (file: WorkspaceFileInfo) => {
    if (!confirm(`确定删除 ${file.name}？`)) return
    setDeleting(file.relativePath)
    try {
      await deleteWorkspaceFile(file.relativePath)
    } finally {
      setDeleting(null)
    }
  }

  const handlePreview = async (file: WorkspaceFileInfo) => {
    try {
      const result = await readWorkspaceFile(file.relativePath)
      setPreview({ file, base64: result.base64 })
    } catch {
      alert('预览失败')
    }
  }

  const renderPreview = () => {
    if (!preview) return null
    const { file, base64 } = preview
    const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)
    const isHtml = /\.html?$/i.test(file.name)
    const isText = /\.(txt|csv|json|md|log)$/i.test(file.name)

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-surface-200">
            <h3 className="font-medium text-surface-900 truncate" title={file.name}>
              {file.name}
            </h3>
            <button
              onClick={() => setPreview(null)}
              className="text-surface-500 hover:text-surface-700"
            >
              关闭
            </button>
          </div>
          <div className="flex-1 min-h-0 p-4 overflow-auto">
            {isImage && (
              <img
                src={`data:image/png;base64,${base64}`}
                alt={file.name}
                className="max-w-full h-auto"
              />
            )}
            {isHtml && (
              <iframe
                srcDoc={atob(base64)}
                title={file.name}
                className="w-full h-[60vh] border border-surface-200 rounded"
              />
            )}
            {isText && (
              <pre className="whitespace-pre-wrap text-sm text-surface-800 bg-surface-50 p-4 rounded">
                {atob(base64)}
              </pre>
            )}
            {!isImage && !isHtml && !isText && (
              <div className="text-surface-500">该文件类型暂不支持预览</div>
            )}
          </div>
          <div className="px-4 py-3 border-t border-surface-200 flex justify-end gap-2">
            <button
              onClick={() => setPreview(null)}
              className="px-4 py-2 text-sm font-medium text-surface-700 bg-surface-100 rounded hover:bg-surface-200"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1">
          <button
            onClick={() => setActiveSubdir('all')}
            className={cn(
              'px-3 py-1.5 text-sm rounded-md transition-colors',
              activeSubdir === 'all'
                ? 'bg-primary-100 text-primary-700'
                : 'text-surface-600 hover:bg-surface-100'
            )}
          >
            全部
          </button>
          {SUBDIRS.map((subdir) => (
            <button
              key={subdir}
              onClick={() => setActiveSubdir(subdir)}
              className={cn(
                'px-3 py-1.5 text-sm rounded-md transition-colors',
                activeSubdir === subdir
                  ? 'bg-primary-100 text-primary-700'
                  : 'text-surface-600 hover:bg-surface-100'
              )}
            >
              {SUBDIR_LABELS[subdir]}
            </button>
          ))}
        </div>
        <button
          onClick={refresh}
          disabled={workspaceLoading}
          className="px-3 py-1.5 text-sm font-medium text-primary-700 bg-primary-50 rounded-md hover:bg-primary-100 disabled:opacity-50"
        >
          {workspaceLoading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {workspaceError && (
        <div className="mb-4 p-3 rounded-md bg-error-50 text-error-700 text-sm">
          {workspaceError}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto border border-surface-200 rounded-lg bg-white">
        {filteredFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-surface-500 text-sm">
            <p>暂无文件</p>
            <p className="mt-1 text-xs">执行 download、save_page 等动作后会自动生成</p>
          </div>
        ) : (
          <table className="w-full text-sm text-left">
            <thead className="bg-surface-50 text-surface-600 sticky top-0">
              <tr>
                <th className="px-4 py-3 font-medium">文件名</th>
                <th className="px-4 py-3 font-medium">目录</th>
                <th className="px-4 py-3 font-medium">大小</th>
                <th className="px-4 py-3 font-medium">修改时间</th>
                <th className="px-4 py-3 font-medium text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-100">
              {filteredFiles.map((file) => (
                <tr key={file.relativePath} className="hover:bg-surface-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-surface-900 truncate max-w-[240px]" title={file.name}>
                      {file.name}
                    </div>
                    <div className="text-xs text-surface-400 truncate max-w-[240px]" title={file.path}>
                      {file.path}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-surface-600">{SUBDIR_LABELS[file.subdir as Subdir] || file.subdir}</td>
                  <td className="px-4 py-3 text-surface-600">{formatBytes(file.size)}</td>
                  <td className="px-4 py-3 text-surface-600">{new Date(file.modifiedAt).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => handlePreview(file)}
                        className="px-2 py-1 text-xs font-medium text-primary-700 bg-primary-50 rounded hover:bg-primary-100"
                      >
                        预览
                      </button>
                      <button
                        onClick={() => handleDelete(file)}
                        disabled={deleting === file.relativePath}
                        className="px-2 py-1 text-xs font-medium text-error-700 bg-error-50 rounded hover:bg-error-100 disabled:opacity-50"
                      >
                        {deleting === file.relativePath ? '删除中...' : '删除'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {preview && renderPreview()}
    </div>
  )
}

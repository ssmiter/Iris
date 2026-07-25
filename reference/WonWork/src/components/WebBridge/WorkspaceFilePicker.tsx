import { useState, useEffect } from 'react'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import type { WorkspaceFileInfo } from '@/types/webbridge'

const SUBDIR_LABELS: Record<string, string> = {
  downloads: '下载',
  snapshots: '快照',
  exports: '导出',
  recordings: '录制',
}

interface WorkspaceFilePickerProps {
  onSelect: (relativePath: string) => void
  onCancel: () => void
}

export function WorkspaceFilePicker({ onSelect, onCancel }: WorkspaceFilePickerProps) {
  const { workspaceFiles, workspaceLoading, listWorkspaceFiles } = useWebBridgeStore()
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    listWorkspaceFiles()
  }, [listWorkspaceFiles])

  const handleConfirm = () => {
    if (selected) {
      onSelect(selected)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-200">
          <h3 className="font-medium text-surface-900">选择工作区文件</h3>
          <button onClick={onCancel} className="text-surface-500 hover:text-surface-700">关闭</button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4">
          {workspaceLoading && <p className="text-sm text-surface-500">加载中...</p>}
          {workspaceFiles.length === 0 && !workspaceLoading && (
            <p className="text-sm text-surface-500">工作区暂无文件。请先执行 download 等动作，或将文件放入 workspace/downloads。</p>
          )}
          <div className="space-y-1">
            {workspaceFiles.map((file) => (
              <button
                key={file.relativePath}
                onClick={() => setSelected(file.relativePath)}
                className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                  selected === file.relativePath
                    ? 'bg-primary-50 text-primary-700'
                    : 'hover:bg-surface-50 text-surface-700'
                }`}
              >
                <div className="font-medium">{file.name}</div>
                <div className="text-xs text-surface-400">
                  {SUBDIR_LABELS[file.subdir] || file.subdir} · {(file.size / 1024).toFixed(1)} KB
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-surface-200 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-surface-700 bg-surface-100 rounded hover:bg-surface-200"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={!selected}
            className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded hover:bg-primary-500 disabled:opacity-50"
          >
            选择
          </button>
        </div>
      </div>
    </div>
  )
}

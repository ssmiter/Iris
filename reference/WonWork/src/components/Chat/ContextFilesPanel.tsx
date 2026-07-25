import { useContextPanelStore } from '@/stores/contextPanelStore'
import { useFileStore } from '@/stores/fileStore'
import { cn } from '@/utils'
import { formatFileSize, resolveDownloadUrl } from '@/utils/fileReader'
import { FileImage, FileText, File, X, FolderOpen, Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function ContextFilesPanel() {
  const { contextFiles, removeContextFile } = useContextPanelStore()
  const { removeAttachment } = useFileStore()
  const { t } = useTranslation()

  const handleRemove = (id: string) => {
    removeContextFile(id)
    removeAttachment(id)
  }

  const handleDownload = (url: string, name: string) => {
    const link = document.createElement('a')
    link.href = resolveDownloadUrl(url)
    link.download = name
    link.target = '_blank'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-surface-200 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <FolderOpen size={14} className="text-surface-500" />
          <span className="text-xs font-semibold text-surface-700">{t('chat.contextFilesPanel.title')}</span>
        </div>
        {contextFiles.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-100 text-surface-500">
            {contextFiles.length}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
        {contextFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-surface-400 gap-1">
            <FolderOpen size={20} />
            <span className="text-[11px]">{t('chat.contextFilesPanel.noFiles')}</span>
          </div>
        ) : (
          <div className="space-y-1">
            {contextFiles.map((file) => (
              <div
                key={file.id}
                className="group flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-50 transition-colors"
              >
                {file.type === 'image' ? (
                  <FileImage size={14} className="text-primary-500 flex-shrink-0" />
                ) : file.type === 'text' ? (
                  <FileText size={14} className="text-green-500 flex-shrink-0" />
                ) : (
                  <File size={14} className="text-amber-500 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  {file.downloadUrl ? (
                    <button
                      onClick={() => handleDownload(file.downloadUrl!, file.name)}
                      className="text-xs text-primary-600 hover:text-primary-700 truncate text-left w-full"
                      title={t('chat.contextFilesPanel.download')}
                    >
                      {file.name}
                    </button>
                  ) : (
                    <p className="text-xs text-surface-700 truncate">{file.name}</p>
                  )}
                  <p className="text-[10px] text-surface-400">
                    {file.size > 0 ? formatFileSize(file.size) : t('chat.contextFilesPanel.systemFile')}
                  </p>
                </div>
                {file.downloadUrl ? (
                  <button
                    onClick={() => handleDownload(file.downloadUrl!, file.name)}
                    className="p-0.5 rounded hover:bg-primary-100 text-primary-500 hover:text-primary-700 transition-all flex-shrink-0"
                    title={t('chat.contextFilesPanel.download')}
                  >
                    <Download size={12} />
                  </button>
                ) : (
                  <button
                    onClick={() => handleRemove(file.id)}
                    className="p-0.5 rounded hover:bg-red-100 text-surface-400 hover:text-red-500 transition-all opacity-0 group-hover:opacity-100 flex-shrink-0"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

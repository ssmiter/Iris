import { Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface FileDropZoneProps {
  isVisible: boolean
}

export function FileDropZone({ isVisible }: FileDropZoneProps) {
  const { t } = useTranslation()

  if (!isVisible) return null

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-primary-500/10 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 px-8 py-6 rounded-2xl border-2 border-dashed border-primary-400 bg-white/90 shadow-lg">
        <Upload size={40} className="text-primary-500" />
        <p className="text-sm font-medium text-primary-700">{t('chat.fileDropZone.dropToUpload')}</p>
        <p className="text-xs text-surface-400">{t('chat.fileDropZone.supportedFiles')}</p>
      </div>
    </div>
  )
}

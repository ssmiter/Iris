import type { PageState } from '@/types/webbridge'
import { useTranslation } from 'react-i18next'
import { Globe, Monitor, ScrollText, Layers } from 'lucide-react'

interface PageStateCardProps {
  pageState: PageState
}

export function PageStateCard({ pageState }: PageStateCardProps) {
  const { t } = useTranslation()

  return (
    <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-green-100 rounded-lg">
          <Globe className="text-green-600" size={20} />
        </div>
        <h3 className="text-lg font-semibold text-surface-900">{t('webbridge.pageStateCard.title')}</h3>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div className="md:col-span-2">
          <p className="text-surface-500">{t('webbridge.pageStateCard.url')}</p>
          <p className="font-medium text-surface-900 truncate" title={pageState.url}>{pageState.url}</p>
        </div>

        <div>
          <p className="text-surface-500">{t('webbridge.pageStateCard.title')}</p>
          <p className="font-medium text-surface-900">{pageState.title}</p>
        </div>

        <div>
          <p className="text-surface-500">{t('webbridge.pageStateCard.readyState')}</p>
          <p className="font-medium text-surface-900 capitalize">{pageState.ready_state}</p>
        </div>

        <div className="flex items-start gap-2">
          <Monitor size={16} className="text-surface-400 mt-0.5" />
          <div>
            <p className="text-surface-500">{t('webbridge.pageStateCard.viewport')}</p>
            <p className="font-medium text-surface-900">{pageState.viewport_width} x {pageState.viewport_height}</p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <ScrollText size={16} className="text-surface-400 mt-0.5" />
          <div>
            <p className="text-surface-500">{t('webbridge.pageStateCard.scroll')}</p>
            <p className="font-medium text-surface-900">{pageState.scroll_x}, {pageState.scroll_y}</p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <Layers size={16} className="text-surface-400 mt-0.5" />
          <div>
            <p className="text-surface-500">{t('webbridge.pageStateCard.tabs')}</p>
            <p className="font-medium text-surface-900">{pageState.tab_index || 1} / {pageState.total_tabs || 1}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

import { cn } from '@/utils'
import { PPT_TEMPLATES, type PptTemplate } from '@/data/pptTemplates'
import { X, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface PptTemplateSelectorProps {
  onSelect: (templateId: string) => void
  onCancel: () => void
}

function TemplateCard({
  template,
  onClick,
}: {
  template: PptTemplate
  onClick: () => void
}) {
  const { colors } = template
  return (
    <button
      onClick={onClick}
      className={cn(
        'group relative flex-shrink-0 w-44 h-28 rounded-xl border-2 transition-all overflow-hidden text-left',
        'hover:scale-[1.02] hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary-400'
      )}
      style={{
        borderColor: colors.accent,
        backgroundColor: colors.background,
      }}
    >
      {/* 模拟封面 */}
      <div
        className="absolute top-0 left-0 right-0 h-16"
        style={{
          backgroundColor: colors.primary,
        }}
      />
      {/* 装饰线 */}
      <div
        className="absolute top-10 left-3 w-10 h-0.5 rounded"
        style={{ backgroundColor: colors.accent }}
      />
      {/* 标题占位 */}
      <div className="absolute top-4 left-3 right-3">
        <div
          className="h-2 w-20 rounded mb-1.5"
          style={{ backgroundColor: 'rgba(255,255,255,0.9)' }}
        />
        <div
          className="h-1.5 w-12 rounded opacity-70"
          style={{ backgroundColor: 'rgba(255,255,255,0.7)' }}
        />
      </div>
      {/* 底部信息区 */}
      <div className="absolute bottom-0 left-0 right-0 h-12 p-2.5 flex flex-col justify-end">
        <span
          className="text-xs font-semibold truncate"
          style={{ color: colors.text }}
        >
          {template.name}
        </span>
        <span className="text-[10px] truncate opacity-70" style={{ color: colors.text }}>
          {template.description}
        </span>
      </div>
      {/* 选中悬浮层 */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors" />
    </button>
  )
}

export function PptTemplateSelector({ onSelect, onCancel }: PptTemplateSelectorProps) {
  const { t } = useTranslation()

  return (
    <div className="w-full bg-white border border-surface-200 rounded-2xl shadow-sm p-4 mb-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="text-sm font-semibold text-surface-800">{t('chat.pptTemplateSelector.title')}</h4>
          <p className="text-xs text-surface-500 mt-0.5">
            {t('chat.pptTemplateSelector.description')}
          </p>
        </div>
        <button
          onClick={onCancel}
          className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400 transition-colors"
          title={t('chat.pptTemplateSelector.cancel')}
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
        {PPT_TEMPLATES.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            onClick={() => onSelect(template.id)}
          />
        ))}
      </div>
    </div>
  )
}

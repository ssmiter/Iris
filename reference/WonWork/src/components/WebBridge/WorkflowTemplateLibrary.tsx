import { useTranslation } from 'react-i18next'
import { useState, useMemo } from 'react'
import type { WorkflowTemplate } from '@/components/WebBridge/WorkflowTemplates'
import { TEMPLATE_CATEGORIES } from '@/components/WebBridge/WorkflowTemplates'
import { Table, FormInput, Camera, Search, FileText, X, Plus, LayoutGrid } from 'lucide-react'

interface WorkflowTemplateLibraryProps {
  templates: WorkflowTemplate[]
  onUseTemplate: (workflow: ReturnType<WorkflowTemplate['build']>) => void
  onClose: () => void
}

function CategoryIcon({ category }: { category: WorkflowTemplate['category'] }) {
  switch (category) {
    case 'data_extraction': return <Table size={18} />
    case 'form_automation': return <FormInput size={18} />
    case 'monitoring': return <Camera size={18} />
    case 'research': return <Search size={18} />
    default: return <FileText size={18} />
  }
}

export function WorkflowTemplateLibrary({ templates, onUseTemplate, onClose }: WorkflowTemplateLibraryProps) {
  const { t } = useTranslation()
  const [selectedCategory, setSelectedCategory] = useState<WorkflowTemplate['category'] | 'all'>('all')
  const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplate | null>(null)
  const [params, setParams] = useState<Record<string, string>>({})

  const filteredTemplates = useMemo(() => {
    if (selectedCategory === 'all') return templates
    return templates.filter((t) => t.category === selectedCategory)
  }, [templates, selectedCategory])

  const handleSelectTemplate = (template: WorkflowTemplate) => {
    setSelectedTemplate(template)
    const defaults: Record<string, string> = {}
    for (const p of template.parameters) {
      defaults[p.key] = p.defaultValue
    }
    setParams(defaults)
  }

  const handleUseTemplate = () => {
    if (!selectedTemplate) return
    const workflow = selectedTemplate.build({ ...params, name: selectedTemplate.name })
    onUseTemplate(workflow)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-200">
          <div className="flex items-center gap-2">
            <LayoutGrid size={18} className="text-primary-600" />
            <h3 className="text-sm font-semibold text-surface-900">{t('webbridge.templateLibrary.title')}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-surface-400 hover:text-surface-700 hover:bg-surface-100 rounded transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {!selectedTemplate ? (
          <>
            <div className="px-4 py-3 border-b border-surface-200 flex flex-wrap gap-2">
              <button
                onClick={() => setSelectedCategory('all')}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  selectedCategory === 'all'
                    ? 'bg-primary-600 text-white'
                    : 'bg-surface-100 text-surface-700 hover:bg-surface-200'
                }`}
              >
                {t('webbridge.templateLibrary.all')}
              </button>
              {TEMPLATE_CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  onClick={() => setSelectedCategory(cat.value)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    selectedCategory === cat.value
                      ? 'bg-primary-600 text-white'
                      : 'bg-surface-100 text-surface-700 hover:bg-surface-200'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-auto p-4">
              {filteredTemplates.length === 0 ? (
                <div className="py-12 text-center text-sm text-surface-400">{t('webbridge.templateLibrary.empty')}</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {filteredTemplates.map((template) => (
                    <button
                      key={template.id}
                      onClick={() => handleSelectTemplate(template)}
                      className="text-left p-4 bg-surface-50 hover:bg-primary-50 border border-surface-200 hover:border-primary-200 rounded-xl transition-colors group"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-primary-600 group-hover:text-primary-700">
                          <CategoryIcon category={template.category} />
                        </span>
                        <span className="text-sm font-semibold text-surface-900">{template.name}</span>
                      </div>
                      <p className="text-xs text-surface-500 line-clamp-2">{template.description}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-auto p-4 space-y-4">
            <button
              onClick={() => setSelectedTemplate(null)}
              className="text-sm text-surface-500 hover:text-surface-900 transition-colors"
            >
              ← {t('webbridge.templateLibrary.back')}
            </button>

            <div className="flex items-center gap-2">
              <span className="text-primary-600"><CategoryIcon category={selectedTemplate.category} /></span>
              <h4 className="text-base font-semibold text-surface-900">{selectedTemplate.name}</h4>
            </div>
            <p className="text-sm text-surface-500">{selectedTemplate.description}</p>

            <div className="space-y-3">
              {selectedTemplate.parameters.map((param) => (
                <div key={param.key}>
                  <label className="block text-sm font-medium text-surface-700 mb-1">{param.label}</label>
                  <input
                    type="text"
                    value={params[param.key] ?? ''}
                    onChange={(e) => setParams((prev) => ({ ...prev, [param.key]: e.target.value }))}
                    placeholder={param.placeholder}
                    className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedTemplate && (
          <div className="px-4 py-3 border-t border-surface-200 flex justify-end gap-2">
            <button
              onClick={() => setSelectedTemplate(null)}
              className="px-4 py-2 text-sm font-medium text-surface-700 hover:bg-surface-100 rounded-lg transition-colors"
            >
              {t('webbridge.workflowPanel.cancel')}
            </button>
            <button
              onClick={handleUseTemplate}
              className="flex items-center gap-1.5 px-4 py-2 bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus size={16} />
              {t('webbridge.templateLibrary.useTemplate')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

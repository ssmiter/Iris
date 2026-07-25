import { useTranslation } from 'react-i18next'
import { useState, useCallback, useEffect } from 'react'
import { cn } from '@/utils'
import { useWorkflowStore } from '@/stores/workflowStore'
import { useDagWorkflowStore } from '@/stores/dagWorkflowStore'
import type { WorkflowStep, WorkflowField } from '@/types/mescli'
import {
  Workflow,
  ChevronRight,
  Check,
  X,
  Search,
  Loader2,
  ArrowRight,
  RotateCcw,
  AlertCircle,
  GitBranch,
} from 'lucide-react'

interface WorkflowViewProps {
  onNavigate?: (view: string) => void
}

const AVAILABLE_WORKFLOWS = [
  { code: 'raw_material_receive', labelKey: 'workflow.workflowView.rawMaterialReceive', icon: '\u{1F4E6}' },
  { code: 'pick_mater_out', labelKey: 'workflow.workflowView.pickMaterOut', icon: '\u{1F4E4}' },
  { code: 'tyre_out_lock', labelKey: 'workflow.workflowView.tyreOutLock', icon: '\u{1F512}' },
  { code: 'semi_storage_manage', labelKey: 'workflow.workflowView.semiStorageManage', icon: '\u{1F3ED}' },
  { code: 'inspection_submit', labelKey: 'workflow.workflowView.inspectionSubmit', icon: '\u{1F52C}' },
  { code: 'equip_inventory', labelKey: 'workflow.workflowView.equipInventory', icon: '\u{1F4CB}' },
  { code: 'equip_fault_record', labelKey: 'workflow.workflowView.equipFaultRecord', icon: '⚠️' },
  { code: 'equip_point_check', labelKey: 'workflow.workflowView.equipPointCheck', icon: '\u{1F527}' },
  { code: 'quality_abnormal', labelKey: 'workflow.workflowView.qualityAbnormal', icon: '\u{1F4CA}' },
  { code: 'production_report', labelKey: 'workflow.workflowView.productionReport', icon: '⚙️' },
  { code: 'tyre_test_commission', labelKey: 'workflow.workflowView.tyreTestCommission', icon: '\u{1F6DE}' },
]

export function WorkflowView({ onNavigate }: WorkflowViewProps) {
  const { t } = useTranslation()
  const {
    sessionId,
    workflowName,
    currentStep,
    isLoading,
    error,
    history,
    startWorkflow,
    cancelWorkflow,
    reset,
  } = useWorkflowStore()
  const { importFromWizard } = useDagWorkflowStore()
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null)

  const handleStart = useCallback(
    async (code: string) => {
      setSelectedWorkflow(code)
      await startWorkflow(code)
    },
    [startWorkflow]
  )

  const handleConvertToDag = useCallback(async () => {
    const steps = history.map((h) => h.step).filter(Boolean) as WorkflowStep[]
    if (currentStep?.step) {
      steps.push(currentStep.step)
    }
    if (steps.length === 0 || !workflowName) return
    await importFromWizard(sessionId || 'unknown', workflowName, steps)
    onNavigate?.('dag-workflow')
  }, [history, currentStep, workflowName, sessionId, importFromWizard, onNavigate])

  // 如果没有活跃工作流，显示选择界面
  if (!sessionId) {
    return (
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 bg-white border-b border-surface-200">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary-100 flex items-center justify-center">
              <Workflow size={20} className="text-primary-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-surface-800">{t('workflow.workflowView.title')}</h2>
              <p className="text-sm text-surface-400">{t('workflow.workflowView.subtitle')}</p>
            </div>
          </div>
        </div>

        {/* Workflow Grid */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {AVAILABLE_WORKFLOWS.map((wf) => (
              <button
                key={wf.code}
                onClick={() => handleStart(wf.code)}
                disabled={isLoading}
                className={cn(
                  'flex flex-col items-center gap-3 p-5 rounded-xl border border-surface-200',
                  'bg-white hover:border-primary-300 hover:shadow-md hover:-translate-y-0.5',
                  'transition-all duration-200 text-center',
                  isLoading && 'opacity-50 cursor-not-allowed'
                )}
              >
                <span className="text-3xl">{wf.icon}</span>
                <span className="text-sm font-medium text-surface-700">{t(wf.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // 活跃工作流：显示步骤
  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-surface-200 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-100 flex items-center justify-center">
            <Workflow size={20} className="text-primary-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-surface-800">{workflowName}</h2>
            <p className="text-sm text-surface-400">
              {t('workflow.workflowView.stepProgress')} {history.length} / {t('workflow.workflowView.inProgress')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleConvertToDag}
            disabled={!currentStep?.step || !workflowName}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-purple-600 hover:text-purple-700 hover:bg-purple-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <GitBranch size={14} />
            转换为 DAG
          </button>
          <button
            onClick={reset}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-surface-500 hover:text-surface-700 hover:bg-surface-100 rounded-lg transition-colors"
          >
            <RotateCcw size={14} />
            {t('workflow.workflowView.restart')}
          </button>
          <button
            onClick={cancelWorkflow}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
          >
            <X size={14} />
            {t('workflow.workflowView.cancel')}
          </button>
        </div>
      </div>

      {/* Progress */}
      <div className="px-6 py-3 bg-surface-50 border-b border-surface-200">
        <div className="flex items-center gap-2 overflow-x-auto">
          {history.map((h, i) => (
            <div key={i} className="flex items-center gap-2 flex-shrink-0">
              <div
                className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium',
                  i === history.length - 1
                    ? 'bg-primary-500 text-white'
                    : 'bg-primary-100 text-primary-600'
                )}
              >
                {i + 1}
              </div>
              <span className="text-xs text-surface-500 whitespace-nowrap">
                {h.step?.name || t('workflow.workflowView.step')}
              </span>
              {i < history.length - 1 && (
                <ChevronRight size={14} className="text-surface-300" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Step Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto">
          {error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3">
              <AlertCircle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {currentStep?.step && (
            <StepRenderer step={currentStep.step} />
          )}

          {currentStep?.result && (
            <div className="mt-6 p-5 bg-green-50 border border-green-200 rounded-xl">
              <div className="flex items-center gap-2 mb-3">
                <Check size={18} className="text-green-600" />
                <h3 className="font-semibold text-green-800">{t('workflow.workflowView.completed')}</h3>
              </div>
              <p className="text-sm text-green-700 whitespace-pre-wrap">
                {currentStep.result.message}
              </p>
              {currentStep.result.documentNo && (
                <p className="text-sm text-green-600 mt-2">
                  {t('workflow.workflowView.documentNo', { no: currentStep.result.documentNo })}
                </p>
              )}
              <button
                onClick={reset}
                className="mt-4 px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition-colors"
              >
                {t('workflow.workflowView.nextDocument')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ==================== 步骤渲染器 ====================

function StepRenderer({ step }: { step: WorkflowStep }) {
  const { t } = useTranslation()
  switch (step.type) {
    case 'Choice':
      return <ChoiceStep step={step} />
    case 'SearchSelect':
      return <SearchSelectStep step={step} />
    case 'Form':
      return <FormStep step={step} />
    case 'Confirm':
      return <ConfirmStep step={step} />
    case 'Result':
      return <ResultStep step={step} />
    default:
      return <div className="text-surface-400">{t('workflow.workflowView.unknownStep', { type: step.type })}</div>
  }
}

// ----- Choice 步骤 -----

function ChoiceStep({ step }: { step: WorkflowStep }) {
  const { t } = useTranslation()
  const { submitStep, isLoading } = useWorkflowStore()
  const [selected, setSelected] = useState<string | null>(null)

  const handleSubmit = useCallback(() => {
    if (!selected) return
    submitStep({ [step.id]: selected })
  }, [selected, step.id, submitStep])

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-surface-800">{step.name}</h3>
        {step.prompt && <p className="text-sm text-surface-500 mt-1">{step.prompt}</p>}
      </div>

      <div className="space-y-2">
        {step.options?.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setSelected(opt.value)}
            className={cn(
              'w-full flex items-center gap-3 p-4 rounded-xl border-2 transition-all text-left',
              selected === opt.value
                ? 'border-primary-500 bg-primary-50'
                : 'border-surface-200 hover:border-primary-300 bg-white'
            )}
          >
            <div
              className={cn(
                'w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0',
                selected === opt.value
                  ? 'border-primary-500 bg-primary-500'
                  : 'border-surface-300'
              )}
            >
              {selected === opt.value && <Check size={12} className="text-white" />}
            </div>
            <span className="text-sm font-medium text-surface-700">{opt.label}</span>
          </button>
        ))}
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleSubmit}
          disabled={!selected || isLoading}
          className={cn(
            'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
            selected && !isLoading
              ? 'bg-primary-500 text-white hover:bg-primary-600'
              : 'bg-surface-200 text-surface-400 cursor-not-allowed'
          )}
        >
          {isLoading ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
          {t('workflow.workflowView.nextStep')}
        </button>
      </div>
    </div>
  )
}

// ----- SearchSelect 步骤 -----

function SearchSelectStep({ step }: { step: WorkflowStep }) {
  const { t } = useTranslation()
  const { submitStep, search, searchResults, isSearching, isLoading } = useWorkflowStore()
  const [keyword, setKeyword] = useState('')
  const [selected, setSelected] = useState<unknown | null>(null)

  const handleSearch = useCallback(async () => {
    if (!step.searchTool || !keyword.trim()) return
    await search(step.searchTool, keyword.trim())
  }, [step.searchTool, keyword, search])

  const handleSubmit = useCallback(() => {
    if (!selected) return
    const valueField = step.valueField || 'id'
    const value = (selected as Record<string, unknown>)[valueField]
    submitStep({ [step.id]: value, [`${step.id}_detail`]: selected })
  }, [selected, step, submitStep])

  const displayField = step.displayField || 'name'

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-surface-800">{step.name}</h3>
        {step.prompt && <p className="text-sm text-surface-500 mt-1">{step.prompt}</p>}
      </div>

      {/* Search Input */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder={t('workflow.workflowView.enterKeyword')}
            className="w-full pl-9 pr-3 py-2.5 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={isSearching || !keyword.trim()}
          className={cn(
            'px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
            keyword.trim() && !isSearching
              ? 'bg-primary-500 text-white hover:bg-primary-600'
              : 'bg-surface-200 text-surface-400 cursor-not-allowed'
          )}
        >
          {isSearching ? <Loader2 size={16} className="animate-spin" /> : t('workflow.workflowView.search')}
        </button>
      </div>

      {/* Results */}
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {searchResults.length === 0 && !isSearching && (
          <p className="text-sm text-surface-400 text-center py-4">{t('workflow.workflowView.pleaseSearch')}</p>
        )}
        {searchResults.map((item, i) => {
          const record = item as Record<string, unknown>
          const label = String(record[displayField] || record['name'] || record['label'] || t('workflow.workflowView.option', { index: i + 1 }))
          const isSelected = selected === item

          return (
            <button
              key={i}
              onClick={() => setSelected(item)}
              className={cn(
                'w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors',
                isSelected
                  ? 'bg-primary-50 text-primary-700 border border-primary-200'
                  : 'hover:bg-surface-100 text-surface-700'
              )}
            >
              {label}
            </button>
          )
        })}
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleSubmit}
          disabled={!selected || isLoading}
          className={cn(
            'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
            selected && !isLoading
              ? 'bg-primary-500 text-white hover:bg-primary-600'
              : 'bg-surface-200 text-surface-400 cursor-not-allowed'
          )}
        >
          {isLoading ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
          {t('workflow.workflowView.nextStep')}
        </button>
      </div>
    </div>
  )
}

// ----- Form 步骤 -----

function FormStep({ step }: { step: WorkflowStep }) {
  const { t } = useTranslation()
  const { submitStep, isLoading } = useWorkflowStore()
  const [formData, setFormData] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  // 初始化默认值
  useEffect(() => {
    const defaults: Record<string, string> = {}
    step.fields?.forEach((field) => {
      if (field.defaultValue != null) {
        defaults[field.id] = String(field.defaultValue)
      }
    })
    setFormData(defaults)
  }, [step.fields])

  const validate = useCallback((): boolean => {
    const newErrors: Record<string, string> = {}
    let valid = true

    step.fields?.forEach((field) => {
      if (field.required) {
        const value = formData[field.id]
        if (!value || value.trim() === '') {
          newErrors[field.id] = t('workflow.workflowView.required', { field: field.name })
          valid = false
        }
      }

      const value = formData[field.id]
      if (value && value.trim() !== '') {
        // 数字校验
        if ((field.type === 'Number' || field.type === 'Decimal') && isNaN(Number(value))) {
          newErrors[field.id] = t('workflow.workflowView.mustBeNumber', { field: field.name })
          valid = false
        }
        // 最小值
        if (field.min != null && Number(value) < field.min) {
          newErrors[field.id] = t('workflow.workflowView.minValue', { field: field.name, min: field.min })
          valid = false
        }
        // 最大值
        if (field.max != null && Number(value) > field.max) {
          newErrors[field.id] = t('workflow.workflowView.maxValue', { field: field.name, max: field.max })
          valid = false
        }
        // 正则
        if (field.pattern && !new RegExp(field.pattern).test(value)) {
          newErrors[field.id] = t('workflow.workflowView.invalidFormat', { field: field.name })
          valid = false
        }
      }
    })

    setErrors(newErrors)
    return valid
  }, [formData, step.fields, t])

  const handleSubmit = useCallback(() => {
    if (!validate()) return

    // 转换类型
    const typedData: Record<string, unknown> = {}
    step.fields?.forEach((field) => {
      const value = formData[field.id]
      if (field.type === 'Number') {
        typedData[field.id] = value ? parseInt(value, 10) : null
      } else if (field.type === 'Decimal') {
        typedData[field.id] = value ? parseFloat(value) : null
      } else if (field.type === 'Checkbox') {
        typedData[field.id] = value === 'true' || value === '1'
      } else {
        typedData[field.id] = value || null
      }
    })

    submitStep(typedData)
  }, [formData, step.fields, validate, submitStep])

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-surface-800">{step.name}</h3>
        {step.prompt && <p className="text-sm text-surface-500 mt-1">{step.prompt}</p>}
      </div>

      <div className="space-y-3">
        {step.fields?.map((field) => (
          <FormField
            key={field.id}
            field={field}
            value={formData[field.id] || ''}
            error={errors[field.id]}
            onChange={(value) => {
              setFormData((prev) => ({ ...prev, [field.id]: value }))
              if (errors[field.id]) {
                setErrors((prev) => {
                  const next = { ...prev }
                  delete next[field.id]
                  return next
                })
              }
            }}
          />
        ))}
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleSubmit}
          disabled={isLoading}
          className={cn(
            'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
            !isLoading
              ? 'bg-primary-500 text-white hover:bg-primary-600'
              : 'bg-surface-200 text-surface-400 cursor-not-allowed'
          )}
        >
          {isLoading ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
          {t('workflow.workflowView.nextStep')}
        </button>
      </div>
    </div>
  )
}

// ----- 表单字段渲染 -----

function FormField({
  field,
  value,
  error,
  onChange,
}: {
  field: WorkflowField
  value: string
  error?: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const inputClass = cn(
    'w-full px-3 py-2.5 border rounded-lg text-sm transition-colors',
    'focus:outline-none focus:ring-1',
    error
      ? 'border-red-300 focus:border-red-400 focus:ring-red-400 bg-red-50'
      : 'border-surface-200 focus:border-primary-400 focus:ring-primary-400'
  )

  const label = (
    <label className="block text-sm font-medium text-surface-700 mb-1">
      {field.name}
      {field.required && <span className="text-red-500 ml-0.5">*</span>}
      {field.unit && <span className="text-surface-400 ml-1">({field.unit})</span>}
    </label>
  )

  switch (field.type) {
    case 'TextArea':
      return (
        <div>
          {label}
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
            className={cn(inputClass, 'resize-none')}
            placeholder={field.description}
          />
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
          {field.description && !error && <p className="text-xs text-surface-400 mt-1">{field.description}</p>}
        </div>
      )

    case 'Select':
      return (
        <div>
          {label}
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
          >
            <option value="">{t('workflow.workflowView.pleaseSelect')}</option>
            {field.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
        </div>
      )

    case 'Checkbox':
      return (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value === 'true' || value === '1'}
            onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
            className="w-4 h-4 rounded border-surface-300 text-primary-500 focus:ring-primary-400"
          />
          <label className="text-sm text-surface-700">
            {field.name}
            {field.required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
        </div>
      )

    case 'Date':
    case 'DateTime':
      return (
        <div>
          {label}
          <input
            type={field.type === 'DateTime' ? 'datetime-local' : 'date'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
          />
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
        </div>
      )

    case 'Number':
    case 'Decimal':
      return (
        <div>
          {label}
          <input
            type="number"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            min={field.min}
            max={field.max}
            step={field.type === 'Decimal' ? '0.01' : '1'}
            className={inputClass}
            placeholder={field.description}
          />
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
          {field.description && !error && <p className="text-xs text-surface-400 mt-1">{field.description}</p>}
        </div>
      )

    case 'SearchSelect': {
      const SearchSelectField = () => {
        const [keyword, setKeyword] = useState('')
        const [localResults, setLocalResults] = useState<unknown[]>([])
        const [showResults, setShowResults] = useState(false)
        const { search, isSearching } = useWorkflowStore()

        const handleSearch = async () => {
          if (!field.searchTool || !keyword.trim()) return
          const resp = await search(field.searchTool, keyword.trim())
          if (resp?.items) {
            setLocalResults(resp.items)
            setShowResults(true)
          }
        }

        const handleSelect = (item: unknown) => {
          const record = item as Record<string, unknown>
          const vf = field.valueField || 'id'
          const df = field.displayField || 'name'
          const val = String(record[vf] ?? '')
          const displayLabel = String(record[df] ?? record['name'] ?? record['label'] ?? val)
          onChange(val)
          setKeyword(displayLabel)
          setShowResults(false)
        }

        return (
          <div>
            {label}
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
                <input
                  type="text"
                  value={keyword}
                  onChange={(e) => {
                    setKeyword(e.target.value)
                    setShowResults(false)
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  className={cn(inputClass, 'pl-8')}
                  placeholder={field.description || t('workflow.workflowView.enterKeyword')}
                />
              </div>
              <button
                onClick={handleSearch}
                disabled={isSearching || !keyword.trim()}
                className={cn(
                  'px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  keyword.trim() && !isSearching
                    ? 'bg-primary-500 text-white hover:bg-primary-600'
                    : 'bg-surface-200 text-surface-400 cursor-not-allowed'
                )}
              >
                {isSearching ? <Loader2 size={14} className="animate-spin" /> : t('workflow.workflowView.search')}
              </button>
            </div>
            {showResults && localResults.length > 0 && (
              <div className="mt-1 border border-surface-200 rounded-lg max-h-40 overflow-y-auto bg-white shadow-sm">
                {localResults.map((item, i) => {
                  const record = item as Record<string, unknown>
                  const df = field.displayField || 'name'
                  const displayLabel = String(record[df] ?? record['name'] ?? record['label'] ?? t('workflow.workflowView.option', { index: i + 1 }))
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => handleSelect(item)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-primary-50 text-surface-700 transition-colors"
                    >
                      {displayLabel}
                    </button>
                  )
                })}
              </div>
            )}
            {showResults && localResults.length === 0 && !isSearching && (
              <p className="text-xs text-surface-400 mt-1">{t('workflow.workflowView.noResults')}</p>
            )}
            {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
          </div>
        )
      }
      return <SearchSelectField />
    }

    case 'Text':
    default:
      return (
        <div>
          {label}
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={inputClass}
            placeholder={field.description}
          />
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
          {field.description && !error && <p className="text-xs text-surface-400 mt-1">{field.description}</p>}
        </div>
      )
  }
}

// ----- Confirm 步骤 -----

function ConfirmStep({ step }: { step: WorkflowStep }) {
  const { t } = useTranslation()
  const { submitStep, cancelWorkflow, isLoading, collectedData } = useWorkflowStore()

  // 渲染汇总模板
  const renderSummary = () => {
    if (!step.summaryTemplate) return null

    let summary = step.summaryTemplate
    Object.entries(collectedData).forEach(([key, value]) => {
      summary = summary.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value ?? ''))
    })

    return (
      <div className="bg-surface-50 border border-surface-200 rounded-xl p-4 whitespace-pre-wrap text-sm text-surface-700 font-mono">
        {summary}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-surface-800">{step.name}</h3>
        {step.prompt && <p className="text-sm text-surface-500 mt-1">{step.prompt}</p>}
      </div>

      {renderSummary()}

      <div className="flex justify-end gap-3">
        <button
          onClick={cancelWorkflow}
          disabled={isLoading}
          className="px-5 py-2.5 rounded-lg text-sm font-medium border border-surface-200 text-surface-600 hover:bg-surface-50 transition-colors"
        >
          {t('workflow.workflowView.cancelWorkflow')}
        </button>
        <button
          onClick={() => submitStep({})}
          disabled={isLoading}
          className={cn(
            'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors',
            !isLoading
              ? 'bg-primary-500 text-white hover:bg-primary-600'
              : 'bg-surface-200 text-surface-400 cursor-not-allowed'
          )}
        >
          {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          {t('workflow.workflowView.confirmSubmit')}
        </button>
      </div>
    </div>
  )
}

// ----- Result 步骤 -----

function ResultStep({ step }: { step: WorkflowStep }) {
  const { t } = useTranslation()
  const { currentStep } = useWorkflowStore()
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-surface-800">{step.name}</h3>
        {step.prompt && <p className="text-sm text-surface-500 mt-1">{step.prompt}</p>}
      </div>
      {currentStep?.result && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-2">
          {currentStep.result.message && (
            <p className="text-sm text-green-700 whitespace-pre-wrap">{currentStep.result.message}</p>
          )}
          {currentStep.result.documentNo && (
            <p className="text-sm font-medium text-green-800">{t('workflow.workflowView.documentNo', { no: currentStep.result.documentNo })}</p>
          )}
        </div>
      )}
    </div>
  )
}

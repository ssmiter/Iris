import { useState, useRef, useEffect } from 'react'
import { X, Play } from 'lucide-react'
import type { DagWorkflow, DagInputField, DagInputFieldType } from '@/types/dagWorkflow'
import { normalizeInputSchema } from '@/types/dagWorkflow'
import { getRecentValue } from '@/utils/workflowInputCache'

interface DagWorkflowInputDialogProps {
  workflow: DagWorkflow
  onConfirm: (inputs: Record<string, unknown>) => void
  onCancel: () => void
}

function toLocalDateString(isoDate?: string): string {
  if (!isoDate) return ''
  const d = new Date(isoDate)
  if (isNaN(d.getTime())) return ''
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function toLocalDateTimeString(isoDate?: string): string {
  if (!isoDate) return ''
  const d = new Date(isoDate)
  if (isNaN(d.getTime())) return ''
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function toIsoString(localValue: string, type: 'date' | 'datetime'): string {
  if (!localValue) return ''
  if (type === 'date') {
    const d = new Date(localValue)
    if (isNaN(d.getTime())) return localValue
    return d.toISOString()
  }
  const d = new Date(localValue)
  if (isNaN(d.getTime())) return localValue
  return d.toISOString()
}

function getInitialStringValue(field: DagInputField, workflowId: string): string {
  const recent = getRecentValue(workflowId, field.name)

  if (field.type === 'boolean') {
    if (field.default !== undefined) return field.default ? 'true' : 'false'
    if (typeof recent === 'boolean') return recent ? 'true' : 'false'
    return ''
  }

  if (field.type === 'date') {
    if (field.default !== undefined) return toLocalDateString(field.default)
    if (typeof recent === 'string') return toLocalDateString(recent)
    return ''
  }

  if (field.type === 'datetime') {
    if (field.default !== undefined) return toLocalDateTimeString(field.default)
    if (typeof recent === 'string') return toLocalDateTimeString(recent)
    return ''
  }

  if (field.type === 'array' || field.type === 'object') {
    if (field.default !== undefined) return JSON.stringify(field.default, null, 2)
    if (recent !== undefined) return JSON.stringify(recent, null, 2)
    return ''
  }

  if (field.type === 'number') {
    if (field.default !== undefined) return String(field.default)
    if (typeof recent === 'number') return String(recent)
    return ''
  }

  if (field.type === 'select') {
    if (field.default !== undefined) return String(field.default)
    if (typeof recent === 'string') return recent
    return ''
  }

  // string
  if (field.default !== undefined) return String(field.default)
  if (typeof recent === 'string') return recent
  return ''
}

function parseFieldValue(field: DagInputField, raw: string): { value: unknown; error?: string } {
  if (raw === '' && !field.required) {
    return { value: getEmptyValueForType(field.type) }
  }

  switch (field.type) {
    case 'number': {
      if (raw === '') return { value: NaN }
      const num = Number(raw)
      if (Number.isNaN(num)) return { value: undefined, error: '请输入有效数字' }
      if ('min' in field && field.min !== undefined && num < field.min) {
        return { value: undefined, error: `不能小于 ${field.min}` }
      }
      if ('max' in field && field.max !== undefined && num > field.max) {
        return { value: undefined, error: `不能大于 ${field.max}` }
      }
      return { value: num }
    }
    case 'boolean': {
      if (raw === '') return { value: undefined, error: '请选择' }
      return { value: raw === 'true' }
    }
    case 'date':
    case 'datetime': {
      if (raw === '') return { value: undefined, error: '请选择日期' }
      return { value: toIsoString(raw, field.type) }
    }
    case 'select': {
      if (raw === '') return { value: undefined, error: '请选择' }
      return { value: raw }
    }
    case 'array':
    case 'object': {
      if (raw === '') return { value: field.type === 'array' ? [] : {} }
      try {
        const parsed = JSON.parse(raw)
        if (field.type === 'array' && !Array.isArray(parsed)) {
          return { value: undefined, error: '必须是 JSON 数组' }
        }
        if (field.type === 'object' && (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null)) {
          return { value: undefined, error: '必须是 JSON 对象' }
        }
        return { value: parsed }
      } catch (err) {
        return { value: undefined, error: err instanceof Error ? err.message : 'JSON 格式不正确' }
      }
    }
    case 'string':
    default: {
      if ('pattern' in field && field.pattern && !new RegExp(field.pattern).test(raw)) {
        return { value: undefined, error: '格式不正确' }
      }
      return { value: raw }
    }
  }
}

function getEmptyValueForType(type: DagInputFieldType): unknown {
  switch (type) {
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return {}
    case 'number':
      return NaN
    default:
      return ''
  }
}

export function DagWorkflowInputDialog({ workflow, onConfirm, onCancel }: DagWorkflowInputDialogProps) {
  const schema = normalizeInputSchema(workflow.inputSchema)
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const field of schema) {
      initial[field.name] = getInitialStringValue(field, workflow.id)
    }
    return initial
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const firstErrorRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (firstErrorRef.current) {
      firstErrorRef.current.focus()
      firstErrorRef.current = null
    }
  }, [errors])

  const handleSubmit = () => {
    const nextErrors: Record<string, string> = {}
    const parsed: Record<string, unknown> = {}
    let firstErrorName: string | null = null

    for (const field of schema) {
      const raw = values[field.name] ?? ''

      if (field.required && raw.trim() === '') {
        nextErrors[field.name] = '必填'
        if (!firstErrorName) firstErrorName = field.name
        continue
      }

      const { value, error } = parseFieldValue(field, raw)
      if (error !== undefined) {
        nextErrors[field.name] = error
        if (!firstErrorName) firstErrorName = field.name
        continue
      }

      parsed[field.name] = value
    }

    if (firstErrorName) {
      setErrors(nextErrors)
      return
    }

    setErrors({})
    onConfirm(parsed)
  }

  if (schema.length === 0) {
    return null
  }

  const setRefIfFirstError = (name: string, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null) => {
    if (errors[name] && !firstErrorRef.current) {
      firstErrorRef.current = el
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md bg-white rounded-xl shadow-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-200">
          <h3 className="font-semibold text-surface-900">运行「{workflow.name}」</h3>
          <button onClick={onCancel} className="text-surface-400 hover:text-surface-600">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3 max-h-[60vh] overflow-auto">
          {schema.map((field) => {
            const label = (
              <span className="text-sm font-medium text-surface-700">
                {field.name}
                {field.required && <span className="text-red-500 ml-0.5">*</span>}
                {field.description && (
                  <span className="text-xs font-normal text-surface-400 ml-1">({field.description})</span>
                )}
              </span>
            )

            const commonInputClass =
              'w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500'
            const errorClass = errors[field.name] ? ' border-red-300 focus:ring-red-500' : ''

            let control: React.ReactNode

            switch (field.type) {
              case 'boolean':
                control = (
                  <select
                    ref={(el) => setRefIfFirstError(field.name, el)}
                    value={values[field.name] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                    className={commonInputClass + errorClass}
                  >
                    <option value="">请选择</option>
                    <option value="true">是</option>
                    <option value="false">否</option>
                  </select>
                )
                break
              case 'date':
                control = (
                  <input
                    ref={(el) => setRefIfFirstError(field.name, el)}
                    type="date"
                    value={values[field.name] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                    className={commonInputClass + errorClass}
                  />
                )
                break
              case 'datetime':
                control = (
                  <input
                    ref={(el) => setRefIfFirstError(field.name, el)}
                    type="datetime-local"
                    value={values[field.name] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                    className={commonInputClass + errorClass}
                  />
                )
                break
              case 'select':
                control = (
                  <select
                    ref={(el) => setRefIfFirstError(field.name, el)}
                    value={values[field.name] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                    className={commonInputClass + errorClass}
                  >
                    <option value="">请选择</option>
                    {field.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                )
                break
              case 'array':
              case 'object':
                control = (
                  <textarea
                    ref={(el) => setRefIfFirstError(field.name, el)}
                    value={values[field.name] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                    placeholder={field.type === 'array' ? '["a", "b"]' : '{"key": "value"}'}
                    rows={3}
                    className={commonInputClass + ' font-mono' + errorClass}
                  />
                )
                break
              case 'number':
                control = (
                  <input
                    ref={(el) => setRefIfFirstError(field.name, el)}
                    type="number"
                    value={values[field.name] ?? ''}
                    min={'min' in field ? field.min : undefined}
                    max={'max' in field ? field.max : undefined}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                    placeholder="0"
                    className={commonInputClass + errorClass}
                  />
                )
                break
              case 'string':
              default:
                control = (
                  <input
                    ref={(el) => setRefIfFirstError(field.name, el)}
                    type="text"
                    value={values[field.name] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                    placeholder={'placeholder' in field ? field.placeholder : ''}
                    pattern={'pattern' in field ? field.pattern : undefined}
                    className={commonInputClass + errorClass}
                  />
                )
            }

            return (
              <div key={field.name}>
                <label className="block mb-1">{label}</label>
                {control}
                {errors[field.name] && <p className="mt-1 text-xs text-red-600">{errors[field.name]}</p>}
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-surface-200">
          <button
            onClick={onCancel}
            className="px-4 py-2 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg text-sm font-medium transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Play size={16} />
            运行
          </button>
        </div>
      </div>
    </div>
  )
}

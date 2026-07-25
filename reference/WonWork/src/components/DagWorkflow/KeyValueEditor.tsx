import { useState, useEffect } from 'react'
import { Plus, Trash2, AlertCircle } from 'lucide-react'

interface KeyValuePair {
  key: string
  value: string
}

interface KeyValueEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: { key?: string; value?: string }
  variablePicker?: React.ReactNode
}

export function KeyValueEditor({ value, onChange, placeholder, variablePicker }: KeyValueEditorProps) {
  const [pairs, setPairs] = useState<KeyValuePair[]>([{ key: '', value: '' }])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    try {
      const parsed = JSON.parse(value || '{}') as Record<string, unknown>
      const entries = Object.entries(parsed).map(([k, v]) => ({
        key: k,
        value: typeof v === 'string' ? v : JSON.stringify(v),
      }))
      setPairs(entries.length > 0 ? entries : [{ key: '', value: '' }])
      setError(null)
    } catch {
      setError('当前 JSON 格式无效，已清空')
      setPairs([{ key: '', value: '' }])
    }
  }, [])

  const emit = (next: KeyValuePair[]) => {
    const obj: Record<string, unknown> = {}
    for (const p of next) {
      if (!p.key.trim()) continue
      const trimmed = p.value.trim()
      if (trimmed === '') {
        obj[p.key.trim()] = ''
      } else if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        try {
          obj[p.key.trim()] = JSON.parse(trimmed)
        } catch {
          obj[p.key.trim()] = trimmed
        }
      } else if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        obj[p.key.trim()] = parseFloat(trimmed)
      } else if (trimmed === 'true') {
        obj[p.key.trim()] = true
      } else if (trimmed === 'false') {
        obj[p.key.trim()] = false
      } else {
        obj[p.key.trim()] = trimmed
      }
    }
    onChange(JSON.stringify(obj, null, 2))
  }

  const updatePair = (index: number, patch: Partial<KeyValuePair>) => {
    const next = [...pairs]
    next[index] = { ...next[index], ...patch }
    setPairs(next)
    emit(next)
  }

  const addPair = () => {
    const next = [...pairs, { key: '', value: '' }]
    setPairs(next)
    emit(next)
  }

  const removePair = (index: number) => {
    const next = pairs.filter((_, i) => i !== index)
    setPairs(next.length > 0 ? next : [{ key: '', value: '' }])
    emit(next.length > 0 ? next : [{ key: '', value: '' }])
  }

  return (
    <div className="space-y-2">
      {error && (
        <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded">
          <AlertCircle size={12} />
          {error}
        </div>
      )}
      {pairs.map((pair, index) => (
        <div key={index} className="grid grid-cols-12 gap-2 items-center">
          <input
            type="text"
            value={pair.key}
            onChange={(e) => updatePair(index, { key: e.target.value })}
            placeholder={placeholder?.key || '键'}
            className="col-span-4 px-2 py-1.5 text-xs border border-surface-200 rounded focus:outline-none focus:border-primary-500"
          />
          <input
            type="text"
            value={pair.value}
            onChange={(e) => updatePair(index, { value: e.target.value })}
            placeholder={placeholder?.value || '值'}
            className="col-span-6 px-2 py-1.5 text-xs border border-surface-200 rounded focus:outline-none focus:border-primary-500"
          />
          <button
            onClick={() => removePair(index)}
            className="col-span-2 p-1.5 text-surface-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <button
          onClick={addPair}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-primary-700 bg-primary-50 hover:bg-primary-100 rounded transition-colors"
        >
          <Plus size={12} />
          添加
        </button>
        {variablePicker}
      </div>
    </div>
  )
}

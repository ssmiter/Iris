import { useMemo, useState } from 'react'
import { Search, Variable } from 'lucide-react'
import type { DagWorkflow } from '@/types/dagWorkflow'
import { normalizeInputSchema } from '@/types/dagWorkflow'

interface VariableSuggestion {
  value: string
  label: string
  category: string
}

interface VariablePickerProps {
  workflow: DagWorkflow | null | undefined
  onSelect: (value: string) => void
}

export function VariablePicker({ workflow, onSelect }: VariablePickerProps) {
  const [filter, setFilter] = useState('')
  const [isOpen, setIsOpen] = useState(false)

  const suggestions = useMemo<VariableSuggestion[]>(() => {
    const result: VariableSuggestion[] = []
    if (!workflow) return result

    // inputs
    const inputSchema = normalizeInputSchema(workflow.inputSchema)
    for (const field of inputSchema) {
      result.push({
        value: `inputs.${field.name}`,
        label: `inputs.${field.name}`,
        category: '工作流输入',
      })
    }

    // variables
    for (const node of workflow.nodes) {
      if (node.type === 'variable') {
        const name = node.data.variable?.variableName
        if (name) {
          result.push({
            value: `variables.${name}`,
            label: `variables.${name}`,
            category: '变量节点',
          })
        }
      }
    }

    // node outputs
    for (const node of workflow.nodes) {
      if (node.type === 'start' || node.type === 'end' || node.type === 'variable') continue
      result.push({
        value: `nodeOutputs.${node.id}`,
        label: `${node.data.label || node.id} (nodeOutputs.${node.id})`,
        category: '节点输出',
      })
    }

    return result
  }, [workflow])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return suggestions
    return suggestions.filter(
      (s) => s.label.toLowerCase().includes(q) || s.value.toLowerCase().includes(q)
    )
  }, [suggestions, filter])

  const grouped = useMemo(() => {
    const map = new Map<string, VariableSuggestion[]>()
    for (const s of filtered) {
      const list = map.get(s.category) || []
      list.push(s)
      map.set(s.category, list)
    }
    return map
  }, [filtered])

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-primary-700 bg-primary-50 hover:bg-primary-100 rounded transition-colors"
      >
        <Variable size={12} />
        插入变量
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-64 bg-white border border-surface-200 rounded-lg shadow-lg overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-100">
            <Search size={14} className="text-surface-400" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索变量..."
              className="flex-1 text-sm outline-none bg-transparent"
              autoFocus
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-surface-400">未找到变量</div>
            ) : (
              Array.from(grouped.entries()).map(([category, items]) => (
                <div key={category}>
                  <div className="px-3 py-1 text-xs font-medium text-surface-500 bg-surface-50">{category}</div>
                  {items.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => {
                        onSelect(`\${${item.value}}`)
                        setIsOpen(false)
                        setFilter('')
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs text-surface-700 hover:bg-primary-50 hover:text-primary-700 truncate"
                      title={item.value}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

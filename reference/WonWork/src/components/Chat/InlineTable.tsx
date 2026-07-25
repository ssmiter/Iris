import { memo } from 'react'

/**
 * 从工具结果/产物数据中提取表格行。
 * 支持多种数据形状：数组、{ rows }、{ data }。
 * 由 ArtifactZone 和 FlowNode ToolBody 共用。
 */
export function extractTableRows(data: unknown): Record<string, unknown>[] | null {
  if (!data || typeof data !== 'object') return null
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
    return data as Record<string, unknown>[]
  }
  const obj = data as Record<string, unknown>
  if (Array.isArray(obj.rows) && obj.rows.length > 0) {
    return obj.rows as Record<string, unknown>[]
  }
  if (Array.isArray(obj.data) && obj.data.length > 0 && typeof obj.data[0] === 'object') {
    return obj.data as Record<string, unknown>[]
  }
  return null
}

interface InlineTableProps {
  rows: Record<string, unknown>[]
  /** 最多显示列数（默认 8） */
  maxColumns?: number
  /** 最多显示行数（默认 10） */
  maxRows?: number
}

/**
 * 内联表格渲染器。
 * 匹配 prototype-v3 .tbl 设计：紧凑、圆角、斑马纹。
 * 在 ArtifactZone 和 ToolNode body 中共用。
 */
export const InlineTable = memo(function InlineTable({
  rows,
  maxColumns = 8,
  maxRows = 10,
}: InlineTableProps) {
  if (rows.length === 0) return null
  const columns = Object.keys(rows[0]).slice(0, maxColumns)
  const visible = rows.slice(0, maxRows)

  return (
    <table className="wf-tbl">
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col}>{col}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {visible.map((row, i) => (
          <tr key={i}>
            {columns.map((col) => (
              <td key={col}>{String(row[col] ?? '')}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
})

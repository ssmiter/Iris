import { memo, useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import { Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ChartRendererProps {
  structuredData: unknown
  height?: number
}

function extractTableData(data: unknown): Record<string, unknown>[] | null {
  if (!data || typeof data !== 'object') return null
  const obj = data as Record<string, unknown>
  if (Array.isArray(obj.rows) && obj.rows.length > 0) {
    return obj.rows as Record<string, unknown>[]
  }
  if (Array.isArray(obj.data) && obj.data.length > 0) {
    return obj.data as Record<string, unknown>[]
  }
  if (Array.isArray(data) && data.length > 0) {
    return data as Record<string, unknown>[]
  }
  return null
}

function exportChartData(data: unknown, title?: string) {
  const rows = extractTableData(data)
  if (!rows || rows.length === 0) return
  const columns = Object.keys(rows[0])
  const csvRows: string[] = []
  csvRows.push('﻿' + columns.map(escapeCsv).join(','))
  for (const row of rows) {
    csvRows.push(columns.map((c) => escapeCsv(row[c])).join(','))
  }
  const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${title || 'chart_data'}_${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function escapeCsv(val: unknown): string {
  const str = val == null ? '' : String(val)
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

function isPieChart(option: Record<string, unknown> | null): boolean {
  if (!option) return false
  const series = option.series
  if (Array.isArray(series) && series.length > 0) {
    return (series[0] as Record<string, unknown>)?.type === 'pie'
  }
  return false
}

function getPieItemCount(option: Record<string, unknown> | null): number {
  if (!option) return 0
  const series = option.series
  if (Array.isArray(series) && series.length > 0) {
    const data = (series[0] as Record<string, unknown>)?.data
    if (Array.isArray(data)) return data.length
  }
  return 0
}

export const ChartRenderer = memo(function ChartRenderer({
  structuredData,
  height,
}: ChartRendererProps) {
  const { t } = useTranslation()
  const option = useMemo(() => {
    return buildChartOption(structuredData, t)
  }, [structuredData, t])

  if (!option) {
    return null
  }

  const tableData = extractTableData(structuredData)
  const titleText = (option.title as Record<string, unknown>)?.text as string
  const pieItems = getPieItemCount(option)
  // 饼图根据数据项数量动态调整高度，确保 legend 有足够的换行空间
  const computedHeight =
    height ??
    (isPieChart(option)
      ? pieItems > 12
        ? 520
        : pieItems > 6
          ? 420
          : 360
      : 360)

  return (
    <div
      className="my-3 rounded-xl border border-surface-200 bg-white"
      onWheel={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
    >
      {tableData && (
        <div className="flex items-center justify-end px-3 py-1.5 bg-surface-50 border-b border-surface-100">
          <button
            onClick={() => exportChartData(structuredData, titleText)}
            className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 transition-colors"
            title={t('chat.chartRenderer.exportData')}
          >
            <Download size={12} />
            {t('chat.chartRenderer.exportData')}
          </button>
        </div>
      )}
      <ReactECharts
        option={option}
        style={{ height: `${computedHeight}px`, width: '100%' }}
        opts={{ renderer: 'canvas' }}
        notMerge={true}
      />
    </div>
  )
})

function buildChartOption(data: unknown, t: (key: string) => string): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null

  const obj = data as Record<string, unknown>

  // 情况1: MESCLI 标准格式 { query_type, count, data: [...] }
  if (Array.isArray(obj.data) && obj.data.length > 0) {
    return buildFromTableData(obj.data as Record<string, unknown>[], obj.query_type as string, t)
  }

  // 情况1b: 后端工具常用格式 { rows: [...] }
  if (Array.isArray(obj.rows) && obj.rows.length > 0) {
    return buildFromTableData(obj.rows as Record<string, unknown>[], obj.query_type as string, t)
  }

  // 情况2: 显式图表配置
  if (obj.chartType && obj.series) {
    return obj as Record<string, unknown>
  }

  // 情况3: 简单键值对数组 [{name, value}]
  if (Array.isArray(obj) && obj.length > 0 && obj[0] && typeof obj[0] === 'object') {
    const first = obj[0] as Record<string, unknown>
    if ('name' in first && 'value' in first) {
      return buildPieChart(obj as { name: string; value: number }[], t('chat.chartRenderer.dataDistribution'), t)
    }
    return buildFromTableData(obj as Record<string, unknown>[], undefined, t)
  }

  // 情况4: 纯对象键值对 { key1: val1, key2: val2 }
  const keys = Object.keys(obj)
  if (keys.length > 0 && keys.every((k) => typeof obj[k] === 'number')) {
    return buildPieChart(
      keys.map((k) => ({ name: k, value: obj[k] as number })),
      t('chat.chartRenderer.dataDistribution'),
      t
    )
  }

  return null
}

function buildFromTableData(
  rows: Record<string, unknown>[],
  queryType?: string,
  t?: (key: string) => string
): Record<string, unknown> | null {
  if (!rows || rows.length === 0) return null

  const firstRow = rows[0]
  const columns = Object.keys(firstRow)

  if (columns.length === 0) return null

  // 找出数值列和分类列
  const numericCols: string[] = []
  const stringCols: string[] = []
  const dateCols: string[] = []

  for (const col of columns) {
    const val = firstRow[col]
    if (typeof val === 'number') {
      numericCols.push(col)
    } else if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val)) {
      dateCols.push(col)
    } else {
      stringCols.push(col)
    }
  }

  // 如果没有数值列，无法绘制图表
  if (numericCols.length === 0) return null

  // 决定 X 轴列
  let xAxisCol = ''
  if (dateCols.length > 0) {
    xAxisCol = dateCols[0]
  } else if (stringCols.length > 0) {
    xAxisCol = stringCols[0]
  } else if (numericCols.length > 1) {
    xAxisCol = numericCols[0]
    numericCols.splice(0, 1)
  } else {
    xAxisCol = columns[0]
  }

  // 推断图表类型
  let chartType: 'bar' | 'line' | 'pie' = 'bar'
  const rowCount = rows.length

  if (queryType) {
    const qt = queryType.toLowerCase()
    if (qt.includes('trend') || qt.includes('time') || qt.includes('history') || dateCols.length > 0) {
      chartType = 'line'
    } else if (qt.includes('rate') || qt.includes('percent') || qt.includes('ratio')) {
      chartType = 'pie'
    }
  } else if (dateCols.length > 0) {
    chartType = 'line'
  } else if (rowCount <= 6 && numericCols.length === 1) {
    chartType = 'pie'
  }

  // 如果只有1个数值列且行数少，用饼图
  if (numericCols.length === 1 && rowCount <= 8 && chartType !== 'line') {
    chartType = 'pie'
  }

  if (chartType === 'pie') {
    const valueCol = numericCols[0] || columns.find((c) => typeof firstRow[c] === 'number') || columns[1]
    if (!valueCol) return null
    return buildPieChart(
      rows.map((r) => ({
        name: String(r[xAxisCol] || r[columns[0]] || t?.('chat.chartRenderer.unknown') || 'Unknown'),
        value: Number(r[valueCol]) || 0,
      })),
      queryType || t?.('chat.chartRenderer.dataDistribution') || 'Data Distribution',
      t
    )
  }

  // 柱状图或折线图
  const xData = rows.map((r) => String(r[xAxisCol] || ''))

  const series = numericCols.map((col) => ({
    name: col,
    type: chartType,
    data: rows.map((r) => Number(r[col]) || 0),
    smooth: chartType === 'line',
    emphasis: { focus: 'series' },
    ...(chartType === 'bar'
      ? {
          itemStyle: { borderRadius: [4, 4, 0, 0] },
        }
      : {}),
  }))

  return {
    title: {
      text: queryType || t?.('chat.chartRenderer.dataChart') || 'Data Chart',
      left: 'center',
      textStyle: { fontSize: 14, fontWeight: 'normal' },
    },
    tooltip: {
      trigger: chartType === 'line' ? 'axis' : 'item',
      axisPointer: chartType === 'line' ? { type: 'cross' } : undefined,
    },
    legend: {
      top: 28,
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '3%',
      top: 50,
      containLabel: true,
    },
    xAxis: {
      type: 'category',
      data: xData,
      axisLabel: {
        rotate: xData.length > 10 ? 45 : 0,
        interval: xData.length > 20 ? 'auto' : 0,
      },
    },
    yAxis: {
      type: 'value',
    },
    series,
    dataZoom:
      xData.length > 20
        ? [
            { type: 'inside', start: 0, end: 100 },
            { type: 'slider', start: 0, end: 100, bottom: 0 },
          ]
        : undefined,
  }
}

function buildPieChart(
  data: { name: string; value: number }[],
  title: string,
  t?: (key: string) => string
): Record<string, unknown> {
  // 过滤掉值为0的项，按值排序
  const filtered = data
    .filter((d) => d.value !== 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 20) // 最多显示20项

  return {
    title: {
      text: title,
      left: 'center',
      top: 10,
      textStyle: { fontSize: 14, fontWeight: 'normal' },
    },
    tooltip: {
      trigger: 'item',
      formatter: '{b}: {c} ({d}%)',
    },
    legend: {
      orient: 'horizontal',
      bottom: 8,
      left: 'center',
      textStyle: { fontSize: 11 },
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 10,
    },
    series: [
      {
        name: title,
        type: 'pie',
        // 使用百分比半径自适应容器大小
        radius: ['22%', '40%'],
        center: ['50%', '46%'],
        avoidLabelOverlap: true,
        itemStyle: {
          borderRadius: 6,
          borderColor: '#fff',
          borderWidth: 2,
        },
        label: {
          show: filtered.length <= 6,
          formatter: '{b}\n{d}%',
          fontSize: 11,
        },
        emphasis: {
          label: {
            show: true,
            fontSize: 13,
            fontWeight: 'bold',
          },
        },
        data: filtered,
      },
    ],
  }
}

export function hasChartData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>

  // 有 data 数组
  if (Array.isArray(obj.data) && obj.data.length > 0) return true

  // 有 chartType 配置
  if (obj.chartType && obj.series) return true

  // 纯数组
  if (Array.isArray(obj) && obj.length > 0) return true

  // 纯数值对象
  const keys = Object.keys(obj)
  if (keys.length > 0 && keys.every((k) => typeof obj[k] === 'number')) return true

  return false
}

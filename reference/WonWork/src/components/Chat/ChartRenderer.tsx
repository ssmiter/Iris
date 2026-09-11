import { memo, useMemo, useRef, useState, useCallback, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import { Download, MessageCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChartAskStore } from '@/stores/chartAskStore'

interface ChartRendererProps {
  structuredData: unknown
  height?: number
}

interface Selection {
  i0: number
  i1: number
}

interface ChartInfo {
  xData: string[]
  isLine: boolean
  lineData: number[] | null
}

/** 取不到 --wf-accent 时的回落色（ECharts 默认第一系列色，保持重构前外观） */
const FALLBACK_ACCENT = '#5470c6'

/**
 * 流式安全的 setOption 替换清单：series/xAxis/yAxis/legend/dataZoom 整批替换（数据新鲜），
 * brush 组件不在清单内——增量合并不打断流式刷新，也不重置用户正在进行的框选。
 */
const STREAM_REPLACE_MERGE = ['series', 'xAxis', 'yAxis', 'legend', 'dataZoom']

/**
 * 解析当前主题的 --wf-accent 为具体色值（color-mix()/var() 由浏览器算出，返回 rgb()）。
 * 主题切换不强制重染已挂载图表——accent 只在每次 option 构建时读取，新图表/新数据用新色。
 */
function resolveAccentColor(): string {
  if (typeof document === 'undefined') return FALLBACK_ACCENT
  try {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;background-color:var(--wf-accent);'
    document.body.appendChild(probe)
    const resolved = getComputedStyle(probe).backgroundColor
    document.body.removeChild(probe)
    if (resolved && resolved !== 'transparent') return resolved
  } catch {
    /* 探测失败走回落 */
  }
  return FALLBACK_ACCENT
}

/** 给 rgb()/hex 色值附加透明度（brush 填充/描边、柱弱化用） */
function withAlpha(color: string, alpha: number): string {
  const m = color.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:[^)]*)\)$/)
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`
  const hex = color.replace('#', '')
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `rgba(${parseInt(hex[0] + hex[0], 16)}, ${parseInt(hex[1] + hex[1], 16)}, ${parseInt(hex[2] + hex[2], 16)}, ${alpha})`
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `rgba(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)}, ${alpha})`
  }
  return color
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

/** 框选适用判定：仅类目 x 轴折线/柱；非类目轴/饼图等静默降级（不报错不提示） */
function isBrushEnabled(option: Record<string, unknown> | null): boolean {
  if (!option) return false
  const xAxis = (option.xAxis as Record<string, unknown>) || {}
  if (xAxis.type !== 'category') return false
  const series = option.series
  if (!Array.isArray(series) || series.length === 0) return false
  const firstType = (series[0] as Record<string, unknown>)?.type
  return firstType === 'line' || firstType === 'bar'
}

/**
 * 折线/柱（类目 x 轴）注入：brush 组件 + 主色对齐 + 选中态反馈。
 * - brush 配置用 accent 12% 填充 / 45% 描边（对齐蓝图 .chart-sel）
 * - 第一系列色 = --wf-accent 解析值
 * - 折线恒显圆点（选中变大变实：7px accent 实心 vs 4px 透明+accent 描边）
 * - 柱：选区激活时区内 accent / 区外弱化（accent 25%）
 */
function decorateCartesianOption(
  option: Record<string, unknown>,
  accent: string,
  selection: Selection | null,
): Record<string, unknown> {
  const xAxis = option.xAxis as Record<string, unknown> | undefined
  const srcSeries = option.series as any[] | undefined
  if (!xAxis || xAxis.type !== 'category' || !srcSeries || srcSeries.length === 0) return option

  // 浅克隆：情况2（obj.chartType && obj.series）时 option 就是原始 structuredData，
  // 不能原地加 brush / 改写 series，否则污染上游数据。
  const out: Record<string, unknown> = { ...option }
  const series = srcSeries.map((s) => ({ ...s }))
  out.series = series

  if (accent) {
    series[0] = { ...series[0], color: accent }
  }

  out.brush = {
    brushType: 'lineX',
    brushMode: 'single',
    removeOnClick: true,
    transformable: false,
    throttleType: 'debounce',
    throttleDelay: 120,
    brushStyle: {
      fill: withAlpha(accent, 0.12),
      stroke: withAlpha(accent, 0.45),
      lineWidth: 1,
    },
  }

  const first = series[0] as Record<string, any> | undefined
  if (!first) return out
  const data = Array.isArray(first.data) ? (first.data as any[]) : []
  if (data.length === 0) return out
  // 防御：情况2（显式 ECharts option）里 data 可能已是 {value} 对象，解包取原值
  const unwrap = (d: any) => (d != null && typeof d === 'object' && 'value' in d ? d.value : d)

  if (first.type === 'line') {
    series[0] = {
      ...first,
      symbol: 'circle',
      data: data.map((d, i) => {
        const inSel = !!selection && i >= selection.i0 && i <= selection.i1
        return {
          value: unwrap(d),
          symbolSize: inSel ? 7 : 4,
          itemStyle: {
            color: inSel ? accent : 'transparent',
            borderColor: inSel ? accent : withAlpha(accent, 0.5),
            borderWidth: 1.5,
          },
        }
      }),
    }
  } else if (selection) {
    // 柱：选区激活时制造区内/区外对比
    series[0] = {
      ...first,
      data: data.map((d, i) => {
        const inSel = i >= selection.i0 && i <= selection.i1
        return {
          value: unwrap(d),
          itemStyle: { color: inSel ? accent : withAlpha(accent, 0.25) },
        }
      }),
    }
  }

  return out
}

export const ChartRenderer = memo(function ChartRenderer({
  structuredData,
  height,
}: ChartRendererProps) {
  const { t } = useTranslation()
  const [selection, setSelection] = useState<Selection | null>(null)
  const chartInstanceRef = useRef<any>(null)
  const setPendingRef = useRef(false)
  const myQuoteRef = useRef('')

  const accent = useMemo(() => resolveAccentColor(), [])

  const option = useMemo(
    () => buildChartOption(structuredData, t, accent, selection),
    [structuredData, t, accent, selection],
  )

  const isBrushable = useMemo(() => isBrushEnabled(option), [option])

  // 图表元信息（x 类目 + 首系列是否折线 + 折线数值），供框选事件/胶囊文本即时读取
  const chartInfo = useMemo<ChartInfo>(() => {
    if (!option) return { xData: [], isLine: false, lineData: null }
    const xAxis = (option.xAxis as Record<string, any>) || {}
    const xData = xAxis.type === 'category' && Array.isArray(xAxis.data) ? (xAxis.data as string[]) : []
    const series = (option.series as any[]) || []
    const first = series[0]
    const isLine = !!first && first.type === 'line'
    const lineData =
      isLine && Array.isArray(first.data)
        ? (first.data as any[]).map((d: any) => (typeof d === 'number' ? d : Number(d?.value)))
        : null
    return { xData, isLine, lineData }
  }, [option])
  const chartInfoRef = useRef(chartInfo)
  chartInfoRef.current = chartInfo

  const isBrushableRef = useRef(isBrushable)
  isBrushableRef.current = isBrushable

  // 图卡重渲染/卸载时，若 pending 是自己 set 的且未被消费，清掉（避免陈旧引用滞留）
  useEffect(() => {
    return () => {
      if (setPendingRef.current) {
        const st = useChartAskStore.getState()
        if (st.pending && st.pending.quote === myQuoteRef.current) {
          st.clear()
        }
      }
    }
  }, [])

  // 图型退化为不可框选时丢弃本地选区（胶囊随之隐藏）
  useEffect(() => {
    if (!isBrushable) setSelection(null)
  }, [isBrushable])

  const handleBrushSelected = useCallback((params: any) => {
    const areas = params?.areas
    const info = chartInfoRef.current
    if (!info || info.xData.length === 0 || !Array.isArray(areas) || areas.length === 0) {
      setSelection(null)
      return
    }
    const area = areas[0]
    const coordRange = area?.coordRange
    if (!Array.isArray(coordRange) || coordRange.length < 2) {
      setSelection(null)
      return
    }
    const lo = Math.round(coordRange[0])
    const hi = Math.round(coordRange[1])
    const i0 = Math.max(0, Math.min(lo, hi))
    const i1 = Math.min(info.xData.length - 1, Math.max(lo, hi))
    if (i1 <= i0) {
      setSelection(null)
      return
    }
    setSelection({ i0, i1 })
  }, [])

  const onEvents = useMemo(() => ({ brushSelected: handleBrushSelected }), [handleBrushSelected])

  const handleChartReady = useCallback((instance: any) => {
    chartInstanceRef.current = instance
    // 激活全局 brush 光标：拖拽即框选（ECharts brush 默认需 toolbox/全局光标才响应）
    if (isBrushableRef.current) {
      instance.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'lineX' } })
    }
  }, [])

  // 胶囊文案：{askPrefix} · 起–止（最低 min）——min 仅折线可算时展示
  const askText = useMemo(() => {
    if (!selection) return null
    const start = chartInfo.xData[selection.i0]
    const end = chartInfo.xData[selection.i1]
    if (start == null || end == null) return null
    let minStr = ''
    if (chartInfo.isLine && chartInfo.lineData) {
      const slice = chartInfo.lineData.slice(selection.i0, selection.i1 + 1)
      if (slice.length > 0) {
        const min = Math.min(...slice)
        if (Number.isFinite(min)) minStr = t('chat.chartRenderer.min', { n: min.toFixed(1) })
      }
    }
    return { start, end, minStr }
  }, [selection, chartInfo, t])

  const handleAskChip = useCallback(() => {
    if (!selection || !askText) return
    const { start, end, minStr } = askText
    // quote 格式与 chartAskStore 注释契约逐字对齐：图 · {起止} 选区（最低 {min}）
    const quote = t('chat.chartRenderer.selectionQuote', { start, end, minStr })
    myQuoteRef.current = quote
    setPendingRef.current = true
    useChartAskStore.getState().setAsk({
      quote,
      suggestion: t('chat.chartRenderer.askWhy', { start, end, minStr }),
    })
    // 点完胶囊清掉本图选区（brush 组件 + 本地状态同步清）
    setSelection(null)
    if (chartInstanceRef.current) {
      chartInstanceRef.current.dispatchAction({ type: 'brush', areas: [] })
    }
  }, [selection, askText])

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
      className="wf-chart-card my-3 rounded-xl"
      onWheel={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
    >
      {(isBrushable || tableData) && (
        <div className="wf-chart-head">
          {isBrushable && <span className="wf-chart-hint">{t('chat.chart.selectHint')}</span>}
          {tableData && (
            <button
              onClick={() => exportChartData(structuredData, titleText)}
              className="wf-chart-export"
              title={t('chat.chartRenderer.exportData')}
            >
              <Download size={12} />
              {t('chat.chartRenderer.exportData')}
            </button>
          )}
        </div>
      )}
      <ReactECharts
        option={option}
        style={{ height: `${computedHeight}px`, width: '100%' }}
        opts={{ renderer: 'canvas' }}
        // 流式安全：merge + replaceMerge（数组整批替换），brush 组件/选区状态不在替换清单内，
        // 增量合并不打断流式刷新，也不重置用户正在进行的框选（notMerge 会全量重建、清掉框选）
        notMerge={false}
        replaceMerge={STREAM_REPLACE_MERGE}
        onChartReady={handleChartReady}
        onEvents={onEvents}
      />
      {askText && (
        <div
          className="wf-chart-askchip"
          onClick={handleAskChip}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') handleAskChip()
          }}
        >
          <span className="wf-chart-ask-ic">
            <MessageCircle size={12} />
          </span>
          <span className="wf-chart-ask-txt">
            {`${t('chat.chart.askPrefix')} · ${askText.start}–${askText.end}${askText.minStr}`}
          </span>
        </div>
      )}
    </div>
  )
})

function buildChartOption(
  data: unknown,
  t: (key: string) => string,
  accent: string,
  selection: Selection | null,
): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null

  const obj = data as Record<string, unknown>
  let base: Record<string, unknown> | null = null

  // 情况0: render_chart 显式配置 { chart: { type, xField, yFields, title }, data: [...] }
  // 模型已通过工具参数显式指定图型与字段——尊重它，不要用启发式重新推断覆盖
  if (obj.chart && typeof obj.chart === 'object' && Array.isArray(obj.data) && obj.data.length > 0) {
    base = buildFromChartConfig(obj.chart as Record<string, unknown>, obj.data as Record<string, unknown>[])
  }

  // 情况1: MESCLI 标准格式 { query_type, count, data: [...] }
  if (!base && Array.isArray(obj.data) && obj.data.length > 0) {
    base = buildFromTableData(obj.data as Record<string, unknown>[], obj.query_type as string, t)
  }

  // 情况1b: 后端工具常用格式 { rows: [...] }
  if (!base && Array.isArray(obj.rows) && obj.rows.length > 0) {
    base = buildFromTableData(obj.rows as Record<string, unknown>[], obj.query_type as string, t)
  }

  // 情况2: 显式图表配置
  if (!base && obj.chartType && obj.series) {
    base = obj as Record<string, unknown>
  }

  // 情况3: 简单键值对数组 [{name, value}]
  if (!base && Array.isArray(obj) && obj.length > 0 && obj[0] && typeof obj[0] === 'object') {
    const first = obj[0] as Record<string, unknown>
    if ('name' in first && 'value' in first) {
      base = buildPieChart(obj as { name: string; value: number }[], t('chat.chartRenderer.dataDistribution'), t)
    } else {
      base = buildFromTableData(obj as Record<string, unknown>[], undefined, t)
    }
  }

  // 情况4: 纯对象键值对 { key1: val1, key2: val2 }
  if (!base) {
    const keys = Object.keys(obj)
    if (keys.length > 0 && keys.every((k) => typeof obj[k] === 'number')) {
      base = buildPieChart(
        keys.map((k) => ({ name: k, value: obj[k] as number })),
        t('chat.chartRenderer.dataDistribution'),
        t,
      )
    }
  }

  if (!base) return null
  // 饼图不框选；折线/柱走 decorateCartesianOption 注入 brush + 主色 + 选中高亮
  if (isPieChart(base)) return base
  return decorateCartesianOption(base, accent, selection)
}

/**
 * 按 render_chart 的显式配置构建 ECharts option。
 * config: { type: 'bar'|'line'|'pie', xField, yFields: string[], title? }
 */
function buildFromChartConfig(
  config: Record<string, unknown>,
  rows: Record<string, unknown>[]
): Record<string, unknown> | null {
  const type = config.type === 'line' || config.type === 'pie' ? config.type : 'bar'
  const xField = typeof config.xField === 'string' ? config.xField : ''
  const yFields = Array.isArray(config.yFields)
    ? config.yFields.filter((f): f is string => typeof f === 'string' && f.length > 0)
    : []
  const title = typeof config.title === 'string' ? config.title : ''

  if (!xField || yFields.length === 0 || rows.length === 0) return null
  // 配置字段在数据中不存在时回退 null，让调用方走启发式
  if (!(xField in rows[0]) || !yFields.some((f) => f in rows[0])) return null

  if (type === 'pie') {
    const valueField = yFields[0]
    return buildPieChart(
      rows.map((r) => ({
        name: String(r[xField] ?? 'Unknown'),
        value: Number(r[valueField]) || 0,
      })),
      title || valueField
    )
  }

  const xData = rows.map((r) => String(r[xField] ?? ''))
  const series = yFields.map((field) => ({
    name: field,
    type,
    data: rows.map((r) => Number(r[field]) || 0),
    smooth: type === 'line',
    emphasis: { focus: 'series' },
    ...(type === 'bar' ? { itemStyle: { borderRadius: [4, 4, 0, 0] } } : {}),
  }))

  return {
    title: title
      ? { text: title, left: 'center', textStyle: { fontSize: 14, fontWeight: 'normal' } }
      : undefined,
    tooltip: {
      trigger: type === 'line' ? 'axis' : 'item',
      axisPointer: type === 'line' ? { type: 'cross' } : undefined,
    },
    legend: { top: title ? 28 : 8 },
    grid: { left: '3%', right: '4%', bottom: '3%', top: title ? 50 : 40, containLabel: true },
    xAxis: {
      type: 'category',
      data: xData,
      axisLabel: { rotate: xData.length > 10 ? 45 : 0, interval: xData.length > 20 ? 'auto' : 0 },
    },
    yAxis: { type: 'value' },
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
          borderColor: 'var(--wf-card-bg)',
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

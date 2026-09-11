import { useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import type { ScheduleResourceGroup, ScheduleTimelineSegment } from './apsScheduleResultAdapter'

interface Props {
  precision: 'exact' | 'shift'
  resourceGroups: ScheduleResourceGroup[]
  segments: ScheduleTimelineSegment[]
  diagnostics: string[]
  selectedAssignmentId?: string
  onSelectAssignment: (assignmentId: string) => void
}

const segmentColor: Record<ScheduleTimelineSegment['segmentType'], string> = {
  PRODUCTION: '#24705a',
  CHANGEOVER: '#d89a2b',
  UNAVAILABLE: '#a94b4b',
}

export function ApsScheduleGantt({
  precision,
  resourceGroups,
  segments,
  diagnostics,
  selectedAssignmentId,
  onSelectAssignment,
}: Props) {
  const rows = useMemo(() => {
    const grouped = resourceGroups.flatMap((group) => group.children.map((code) => ({
      code,
      label: `${group.resourceName} / ${code.endsWith(':LEFT') ? '左模位' : code.endsWith(':RIGHT') ? '右模位' : code}`,
    })))
    const known = new Set(grouped.map((row) => row.code))
    return [...grouped, ...segments.filter((segment) => !known.has(segment.resourceCode)).map((segment) => ({
      code: segment.resourceCode,
      label: segment.resourceCode,
    }))].filter((row, index, all) => all.findIndex((candidate) => candidate.code === row.code) === index)
  }, [resourceGroups, segments])

  const option = useMemo(() => ({
    animation: false,
    grid: { left: 170, right: 24, top: 32, bottom: 54 },
    tooltip: {
      formatter: (params: any) => {
        const segment = segments[params.dataIndex]
        if (!segment) return ''
        const type = segment.segmentType === 'PRODUCTION' ? '生产' : segment.segmentType === 'CHANGEOVER' ? '换模' : '不可用'
        const quantity = segment.quantity == null ? '' : `<br/>数量：${segment.quantity}`
        return `${type}<br/>资源：${segment.resourceCode}<br/>物料：${segment.productCode || '-'}${quantity}<br/>${segment.startTime}<br/>至 ${segment.endTime}${segment.locked ? '<br/>已锁定，只读' : ''}`
      },
    },
    xAxis: { type: 'time', axisLabel: { color: '#64748b' }, splitLine: { show: true, lineStyle: { color: '#e2e8f0' } } },
    yAxis: { type: 'category', data: rows.map((row) => row.label), axisLabel: { color: '#334155', width: 155, overflow: 'truncate' } },
    dataZoom: [{ type: 'inside', filterMode: 'weakFilter' }, { type: 'slider', height: 18, bottom: 10, filterMode: 'weakFilter' }],
    series: [{
      type: 'custom',
      encode: { x: [1, 2], y: 0 },
      data: segments.map((segment) => [
        rows.findIndex((row) => row.code === segment.resourceCode),
        Date.parse(segment.startTime),
        Date.parse(segment.endTime),
        segment.segmentType,
        segment.assignmentId,
        segment.productCode,
        segment.quantity,
        segment.locked ? 1 : 0,
      ]),
      renderItem: (_params: any, api: any) => {
        const rowIndex = api.value(0)
        const start = api.coord([api.value(1), rowIndex])
        const end = api.coord([api.value(2), rowIndex])
        const height = Math.min(24, api.size([0, 1])[1] * 0.58)
        const width = Math.max(2, end[0] - start[0])
        const type = api.value(3) as ScheduleTimelineSegment['segmentType']
        const selected = api.value(4) === selectedAssignmentId
        const label = type === 'PRODUCTION' ? `${api.value(5) || ''}${api.value(6) == null ? '' : ` · ${api.value(6)}`}` : type === 'CHANGEOVER' ? '换模' : '不可用'
        return {
          type: 'rect',
          shape: { x: start[0], y: start[1] - height / 2, width, height, r: 4 },
          style: { fill: segmentColor[type], stroke: selected ? '#0f172a' : api.value(7) ? '#7f1d1d' : '#fff', lineWidth: selected ? 3 : 1, text: label, textFill: '#fff', fontSize: 10, truncate: { outerWidth: Math.max(0, width - 8), ellipsis: '…' } },
          styleEmphasis: { opacity: 0.86 },
        }
      },
    }],
  }), [rows, segments, selectedAssignmentId])

  if (segments.length === 0) {
    return <div className="px-4 py-8 text-center text-xs text-[var(--wf-mut)]">当前时间轴数据不完整，请切换到明细表核实。</div>
  }

  return (
    <div className="bg-[var(--wf-card-bg)] px-3 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--wf-sub)]">
        <div className="flex items-center gap-3"><Legend color="#24705a" label="生产" /><Legend color="#d89a2b" label="换模" /><Legend color="#a94b4b" label="不可用" /></div>
        <span className="rounded-full bg-[var(--wf-mono-bg)] px-2 py-1 font-semibold">{precision === 'exact' ? '精确时间' : '班次级概览'}</span>
      </div>
      {diagnostics.map((message) => <div key={message} className="mb-2 rounded-md bg-[var(--wf-warn-bg)] px-2 py-1.5 text-[11px] text-[var(--wf-warn-ink)]">{message}</div>)}
      <ReactECharts
        option={option}
        style={{ height: Math.max(260, rows.length * 46 + 90) }}
        notMerge
        lazyUpdate
        onEvents={{ click: (params: any) => {
          const segment = segments[params.dataIndex]
          if (segment?.segmentType === 'PRODUCTION') onSelectAssignment(segment.assignmentId)
        } }}
      />
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><i className="h-2.5 w-4 rounded-sm" style={{ backgroundColor: color }} />{label}</span>
}

import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  CalendarClock,
  Check,
  Factory,
  GitBranch,
  List,
  PackageCheck,
  PencilLine,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react'
import type { ToolResultRendererProps } from '@/agent/tools/toolRenderRegistry'
import { useChatStore } from '@/stores/chatStore'
import { cn } from '@/utils'
import {
  buildAdjustmentMessage,
  buildApprovalMessage,
  buildRefreshMessage,
  buildReplanMessage,
  formatEntityLabel,
  parseApsScheduleResult,
  type ApsScheduleEdit,
  type ScheduleConflictPolicy,
} from './apsScheduleResultAdapter'
import { ApsScheduleGantt } from './ApsScheduleGantt'
import { ApsScheduleEditPanel } from './ApsScheduleEditPanel'

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function ApsScheduleResultCard({ message }: ToolResultRendererProps) {
  const data = useMemo(() => parseApsScheduleResult(message.structuredData), [message.structuredData])
  const sendMessage = useChatStore((state) => state.sendMessage)
  const [editing, setEditing] = useState(false)
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string>()
  const [view, setView] = useState<'gantt' | 'table'>(() => data?.timelineSegments.length ? 'gantt' : 'table')
  const [dateFilter, setDateFilter] = useState('')
  const [resourceFilter, setResourceFilter] = useState('')
  const [productFilter, setProductFilter] = useState('')
  const [lockFilter, setLockFilter] = useState<'all' | 'editable' | 'locked'>('all')
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [conflictPolicy, setConflictPolicy] = useState<ScheduleConflictPolicy>('block')
  const [edits, setEdits] = useState<ApsScheduleEdit[]>(() =>
    data?.assignments.map((row) => ({ ...row, delete: false })) ?? []
  )
  const currentPlanResources = useMemo(() => {
    if (!data) return []
    const codes = new Set(data.assignments.map((row) => row.resourceCode))
    return [...codes].sort().map((code) => {
      const assignment = data.assignments.find((row) => row.resourceCode === code)
      return { value: code, label: formatEntityLabel(assignment?.resourceName, code) }
    })
  }, [data])
  const currentPlanProducts = useMemo(() => {
    if (!data) return []
    const codes = new Set(data.assignments.map((row) => row.productCode))
    return [...codes].sort().map((code) => {
      const assignment = data.assignments.find((row) => row.productCode === code)
      return { value: code, label: formatEntityLabel(assignment?.productName, code) }
    })
  }, [data])

  useEffect(() => {
    setEdits(data?.assignments.map((row) => ({ ...row, delete: false })) ?? [])
    setSelectedAssignmentId(undefined)
    setEditing(false)
    setReason('')
    setView(data?.timelineSegments.length ? 'gantt' : 'table')
    setDateFilter('')
    setResourceFilter('')
    setProductFilter('')
    setLockFilter('all')
  }, [data?.planId, data?.revision])

  if (!data) {
    return <div className="mt-2 rounded-xl border border-[var(--wf-warn-line)] bg-[var(--wf-warn-bg)] p-3 text-xs text-[var(--wf-warn-ink)]">排产结果格式暂不可识别，请使用通用结果查看。</div>
  }

  const pending = data.assignments.length === 0
  const totalMatches = data.demandTotal === data.assignmentTotal
  const filteredSegments = data.timelineSegments.filter((segment) => {
    const assignment = data.assignments.find((row) => row.assignmentId === segment.assignmentId)
    return (!dateFilter || assignment?.productionDate === dateFilter)
      && (!resourceFilter || segment.resourceCode === resourceFilter || segment.resourceCode.startsWith(`${resourceFilter}:`))
      && (!productFilter || segment.productCode === productFilter)
      && (lockFilter === 'all' || (lockFilter === 'locked' ? segment.locked : !segment.locked))
  })

  const updateEdit = (assignmentId: string, patch: Partial<ApsScheduleEdit>) => {
    setEdits((current) => current.map((row) => row.assignmentId === assignmentId ? { ...row, ...patch } : row))
  }

  const openEditor = (assignmentId: string) => {
    setSelectedAssignmentId(assignmentId)
    setEditing(true)
    setError('')
  }

  const changedEdits = edits.filter((edit) => {
    const original = data.assignments.find((row) => row.assignmentId === edit.assignmentId)
    return !original || edit.delete || edit.productionDate !== original.productionDate
      || edit.shiftCode !== original.shiftCode || edit.resourceCode !== original.resourceCode
      || edit.productCode !== original.productCode || edit.quantity !== original.quantity
  })

  const runMessage = async (content: string) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await sendMessage(content)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作未完成，请重试')
    } finally {
      setBusy(false)
    }
  }

  const submitEdits = () => {
    if (!reason.trim()) {
      setError('请填写调整原因，便于版本审计。')
      return
    }
    if (changedEdits.length === 0) {
      setError('尚未修改任何排产项目。')
      return
    }
    if (changedEdits.some((row) => !row.delete && (!row.productionDate || !row.shiftCode || !row.resourceCode || !row.productCode || row.quantity <= 0))) {
      setError('日期、班次、机台、物料和数量必须完整，数量应大于 0。')
      return
    }
    void runMessage(buildAdjustmentMessage(data.displayReference, reason, changedEdits, {
      assignments: data.assignments,
      shifts: data.shifts,
      resources: data.resources,
      products: data.products,
    }))
  }

  return (
    <section className="mt-2 overflow-hidden rounded-2xl border border-[var(--wf-line)] bg-[var(--wf-bg)] shadow-[0_18px_45px_-30px_rgba(15,23,42,0.65)]" aria-label="生产排产结果">
      <header className="relative overflow-hidden bg-[#16202a] px-4 py-4 text-white">
        <div className="pointer-events-none absolute inset-0 opacity-[0.08]" style={{ backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 14px, #fff 14px 15px)' }} />
        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300">
              <Factory size={13} /> PRODUCTION SCHEDULE
            </div>
            <h3 className="mt-1.5 text-lg font-semibold tracking-tight">生产排产复核单</h3>
            <p className="mt-1 text-[11px] text-slate-300">{data.displayReference}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-[11px] text-slate-100">
              <GitBranch size={12} /> 版本 {data.revision}
            </span>
            <span className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold',
              pending ? 'bg-amber-300 text-slate-900' : 'bg-emerald-300 text-emerald-950'
            )}>
              {pending ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
              {pending ? '计算中' : data.published ? '已发布' : '待复核'}
            </span>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-3 divide-x divide-[var(--wf-line)] border-b border-[var(--wf-line)] bg-[var(--wf-card-bg)]">
        <Metric label="需求总量" value={formatNumber(data.demandTotal)} icon={<PackageCheck size={14} />} />
        <Metric label="已排数量" value={formatNumber(data.assignmentTotal)} icon={<CalendarClock size={14} />} tone={totalMatches ? 'good' : 'warn'} />
        <Metric label="分配项目" value={formatNumber(data.assignmentCount)} icon={<Factory size={14} />} />
      </div>

      {pending ? (
        <div className="px-4 py-6 text-center">
          <p className="text-sm font-medium text-[var(--wf-ink)]">计划已接收，正在形成机台分配</p>
          <p className="mt-1 text-xs text-[var(--wf-mut)]">{data.engineMessage || '结果完成后可在此复核、调整和审批。'}</p>
          <button type="button" disabled={busy} onClick={() => void runMessage(buildRefreshMessage(data.displayReference))} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[var(--wf-capsule-bg)] px-3 py-2 text-xs font-semibold text-[var(--wf-capsule-ink)] hover:bg-[var(--wf-capsule-hover)] disabled:opacity-50">
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> 刷新排产结果
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between border-b border-[var(--wf-line)] bg-[var(--wf-mono-bg)] px-4 py-2">
            <div className="inline-flex rounded-lg border border-[var(--wf-line)] bg-[var(--wf-card-bg)] p-0.5">
              <button type="button" onClick={() => setView('gantt')} className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold', view === 'gantt' ? 'bg-[var(--wf-capsule-bg)] text-[var(--wf-capsule-ink)]' : 'text-[var(--wf-sub)]')}><BarChart3 size={13} />资源甘特图</button>
              <button type="button" onClick={() => setView('table')} className={cn('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold', view === 'table' ? 'bg-[var(--wf-capsule-bg)] text-[var(--wf-capsule-ink)]' : 'text-[var(--wf-sub)]')}><List size={13} />明细表</button>
            </div>
            <span className="text-[10px] text-[var(--wf-mut)]">点击生产任务可查看或编辑；时间与约束由后端校验</span>
          </div>

          {view === 'gantt' && <div className="flex flex-wrap gap-2 border-b border-[var(--wf-line)] bg-[var(--wf-card-bg)] px-4 py-2">
            <FilterSelect label="全部日期" value={dateFilter} onChange={setDateFilter} options={[...new Set(data.assignments.map((row) => row.productionDate))].sort().map((value) => ({ value, label: value }))} />
            <FilterSelect label="全部机台/模位" value={resourceFilter} onChange={setResourceFilter} options={currentPlanResources} />
            <FilterSelect label="全部物料" value={productFilter} onChange={setProductFilter} options={currentPlanProducts} />
            <select value={lockFilter} onChange={(event) => setLockFilter(event.target.value as typeof lockFilter)} className="max-w-40 rounded-md border border-[var(--wf-line)] bg-[var(--wf-card-bg)] px-2 py-1.5 text-[11px] text-[var(--wf-sub)]" aria-label="任务锁定状态筛选"><option value="all">全部状态</option><option value="editable">可编辑</option><option value="locked">已锁定</option></select>
            <span className="ml-auto self-center text-[10px] text-[var(--wf-mut)]">当前显示 {filteredSegments.length} / {data.timelineSegments.length} 个时间段</span>
          </div>}

          {view === 'gantt' && (
            <ApsScheduleGantt
              precision={data.timelinePrecision}
              resourceGroups={data.resourceGroups}
              segments={filteredSegments}
              diagnostics={data.timelineDiagnostics}
              selectedAssignmentId={selectedAssignmentId}
              onSelectAssignment={openEditor}
            />
          )}

          {editing && selectedAssignmentId && edits.find((row) => row.assignmentId === selectedAssignmentId) && (
            <ApsScheduleEditPanel
              data={data}
              edit={edits.find((row) => row.assignmentId === selectedAssignmentId)!}
              reason={reason}
              onChange={(patch) => updateEdit(selectedAssignmentId, patch)}
              onReasonChange={setReason}
              onClose={() => { setEditing(false); setSelectedAssignmentId(undefined); setError('') }}
            />
          )}

          {view === 'table' && <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-left text-xs">
              <thead className="border-b border-[var(--wf-line)] bg-[var(--wf-mono-bg)] text-[10px] uppercase tracking-wider text-[var(--wf-mut)]">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">生产日期</th>
                  <th className="px-3 py-2.5 font-semibold">班次</th>
                  <th className="px-3 py-2.5 font-semibold">机台</th>
                  <th className="px-3 py-2.5 font-semibold">工位</th>
                  <th className="px-3 py-2.5 font-semibold">物料</th>
                  <th className="px-3 py-2.5 text-right font-semibold">计划量</th>
                  <th className="px-3 py-2.5 text-right font-semibold">已完成</th>
                  <th className="px-3 py-2.5 font-semibold">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--wf-line)] bg-[var(--wf-card-bg)]">
                {edits.map((row) => (
                  <tr key={row.assignmentId} className={cn('transition-colors', row.delete ? 'bg-[var(--wf-err-bg)] opacity-60' : 'hover:bg-[var(--wf-hover)]')}>
                    <td className="px-4 py-3">
                      <span className="font-medium text-[var(--wf-ink)]">{row.productionDate}</span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="text-[var(--wf-sub)]">{data.shifts.find((shift) => shift.code === row.shiftCode)?.name || row.shiftCode}</span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="rounded bg-[var(--wf-capsule-bg)] px-2 py-1 text-[11px] text-[var(--wf-capsule-ink)]">{formatEntityLabel(data.assignments.find((item) => item.assignmentId === row.assignmentId)?.resourceName, row.resourceCode)}</span>
                    </td>
                    <td className="px-3 py-3 text-[var(--wf-sub)]">{data.assignments.find((item) => item.assignmentId === row.assignmentId)?.workPosition || 'L/R'}</td>
                    <td className="px-3 py-3"><span className="text-[var(--wf-sub)]">{formatEntityLabel(data.assignments.find((item) => item.assignmentId === row.assignmentId)?.productName || data.products.find((product) => product.code === row.productCode)?.name, row.productCode)}</span></td>
                    <td className="px-3 py-3 text-right">
                      <span className="font-semibold tabular-nums text-[var(--wf-ink)]">{formatNumber(row.quantity)}</span>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-[var(--wf-sub)]">{formatNumber(data.assignments.find((item) => item.assignmentId === row.assignmentId)?.actualQuantity || 0)}</td>
                    <td className="px-3 py-3"><span className={cn('font-semibold', data.assignments.find((item) => item.assignmentId === row.assignmentId)?.locked ? 'wf-badge-err' : 'wf-badge-ok')}>{data.assignments.find((item) => item.assignmentId === row.assignmentId)?.planStateLabel || '待审批'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}

          {editing && !selectedAssignmentId && (
            <div className="border-t border-[var(--wf-line)] bg-[var(--wf-card-bg)] px-4 py-3">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--wf-mut)]">调整原因（写入版本审计）</label>
              <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：CU018 周四检修，计划转移至 CU021" className="mt-1.5 w-full rounded-lg border border-[var(--wf-line)] bg-[var(--wf-card-bg)] px-3 py-2 text-xs text-[var(--wf-ink)] placeholder:text-[var(--wf-faint)] focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200" />
            </div>
          )}

          {!editing && data.publishConflicts.length > 0 && !data.published && (
            <div className="border-t border-[var(--wf-warn-line)] bg-[var(--wf-warn-bg)] px-4 py-3">
              <div className="text-xs font-semibold text-[var(--wf-warn-ink)]">检测到 {data.publishConflicts.length} 个班次已有计划</div>
              <div className="mt-1 text-[11px] text-[var(--wf-warn-ink)]">默认安全阻断；执行中或已有实际产量的计划永久锁定，已接收但未执行的计划仍可调整。</div>
              <select value={conflictPolicy} onChange={(event) => setConflictPolicy(event.target.value as ScheduleConflictPolicy)} className="mt-2 rounded-md border border-[var(--wf-warn-line)] bg-[var(--wf-card-bg)] px-2 py-1.5 text-xs text-[var(--wf-ink)]">
                <option value="block">遇到冲突则阻断</option>
                <option value="append">保留已有计划并追加</option>
                <option value="replace_unstarted">替换未开工的同物料计划</option>
              </select>
            </div>
          )}

          {error && <div className="border-t border-[var(--wf-err-line)] bg-[var(--wf-err-bg)] px-4 py-2 text-xs text-[var(--wf-err-ink)]">{error}</div>}

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--wf-line)] bg-[var(--wf-mono-bg)] px-4 py-3">
            <div className="text-[10px] text-[var(--wf-mut)]">
              {data.published
                ? '已下达但未执行、实际产量为 0 的计划仍可调整或覆盖 · 已执行或已有实际产量后锁定'
                : '调整会创建新版本 · 原版本与审批记录保留 · 未审批前不会进入正式计划'}
            </div>
            <div className="flex flex-wrap gap-2">
              {editing ? (
                <>
                  <button type="button" disabled={busy} onClick={() => { setEditing(false); setSelectedAssignmentId(undefined); setError(''); setEdits(data.assignments.map((row) => ({ ...row, delete: false }))) }} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--wf-line)] bg-[var(--wf-card-bg)] px-3 py-2 text-xs font-semibold text-[var(--wf-sub)] hover:bg-[var(--wf-hover)]"><X size={13} /> 取消</button>
                  <button type="button" disabled={busy} onClick={submitEdits} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-50"><Check size={13} /> 提交新版本</button>
                </>
              ) : (
                <>
                  <button type="button" disabled={!data.canEdit || busy} onClick={() => { const first = data.assignments.find((row) => !row.locked); if (first) openEditor(first.assignmentId) }} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--wf-line)] bg-[var(--wf-card-bg)] px-3 py-2 text-xs font-semibold text-[var(--wf-sub)] hover:border-amber-400 hover:bg-amber-50 disabled:opacity-50"><PencilLine size={13} /> 编辑计划</button>
                  <button type="button" disabled={busy} onClick={() => void runMessage(buildReplanMessage(data.displayReference))} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--wf-line)] bg-[var(--wf-card-bg)] px-3 py-2 text-xs font-semibold text-[var(--wf-sub)] hover:bg-[var(--wf-hover)] disabled:opacity-50"><RotateCcw size={13} /> 重新排产</button>
                  <button type="button" disabled={!data.canApprovePublish || busy} onClick={() => void runMessage(buildApprovalMessage(data.displayReference, conflictPolicy))} className="inline-flex items-center gap-1.5 rounded-lg bg-[#24705a] px-3 py-2 text-xs font-bold text-white hover:bg-[#1d5b49] disabled:opacity-50"><ShieldCheck size={13} /> 审批并发布</button>
                </>
              )}
            </div>
          </footer>
        </>
      )}
    </section>
  )
}

function Metric({ label, value, icon, tone = 'neutral' }: { label: string; value: string; icon: React.ReactNode; tone?: 'neutral' | 'good' | 'warn' }) {
  return (
    <div className="px-3 py-3 text-center">
      <div className="flex items-center justify-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--wf-mut)]">{icon}{label}</div>
      <div className={cn('mt-1 font-mono text-lg font-bold tabular-nums', tone === 'good' ? 'text-[var(--wf-ok-ink)]' : tone === 'warn' ? 'text-[var(--wf-warn-ink)]' : 'text-[var(--wf-ink)]')}>{value}</div>
    </div>
  )
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} className="max-w-52 rounded-md border border-[var(--wf-line)] bg-[var(--wf-card-bg)] px-2 py-1.5 text-[11px] text-[var(--wf-sub)]" aria-label={label}><option value="">{label}</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
}

import { useMemo, useState } from 'react'
import {
  CalendarClock,
  Check,
  Factory,
  GitBranch,
  PackageCheck,
  PencilLine,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
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

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function ApsScheduleResultCard({ message }: ToolResultRendererProps) {
  const data = useMemo(() => parseApsScheduleResult(message.structuredData), [message.structuredData])
  const sendMessage = useChatStore((state) => state.sendMessage)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [conflictPolicy, setConflictPolicy] = useState<ScheduleConflictPolicy>('block')
  const [edits, setEdits] = useState<ApsScheduleEdit[]>(() =>
    data?.assignments.map((row) => ({ ...row, delete: false })) ?? []
  )

  if (!data) {
    return <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">排产结果格式暂不可识别，请使用通用结果查看。</div>
  }

  const pending = data.assignments.length === 0
  const totalMatches = data.demandTotal === data.assignmentTotal

  const updateEdit = (assignmentId: string, patch: Partial<ApsScheduleEdit>) => {
    setEdits((current) => current.map((row) => row.assignmentId === assignmentId ? { ...row, ...patch } : row))
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
    void runMessage(buildAdjustmentMessage(data.displayReference, reason, changedEdits))
  }

  return (
    <section className="mt-2 overflow-hidden rounded-2xl border border-slate-300 bg-[#f7f5ef] shadow-[0_18px_45px_-30px_rgba(15,23,42,0.65)]" aria-label="生产排产结果">
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

      <div className="grid grid-cols-3 divide-x divide-slate-200 border-b border-slate-200 bg-white/70">
        <Metric label="需求总量" value={formatNumber(data.demandTotal)} icon={<PackageCheck size={14} />} />
        <Metric label="已排数量" value={formatNumber(data.assignmentTotal)} icon={<CalendarClock size={14} />} tone={totalMatches ? 'good' : 'warn'} />
        <Metric label="分配项目" value={formatNumber(data.assignmentCount)} icon={<Factory size={14} />} />
      </div>

      {pending ? (
        <div className="px-4 py-6 text-center">
          <p className="text-sm font-medium text-slate-800">计划已接收，正在形成机台分配</p>
          <p className="mt-1 text-xs text-slate-500">{data.engineMessage || '结果完成后可在此复核、调整和审批。'}</p>
          <button type="button" disabled={busy} onClick={() => void runMessage(buildRefreshMessage(data.displayReference))} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#16202a] px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50">
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> 刷新排产结果
          </button>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-left text-xs">
              <thead className="border-b border-slate-200 bg-[#ece9e0] text-[10px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">生产日期</th>
                  <th className="px-3 py-2.5 font-semibold">班次</th>
                  <th className="px-3 py-2.5 font-semibold">机台</th>
                  <th className="px-3 py-2.5 font-semibold">工位</th>
                  <th className="px-3 py-2.5 font-semibold">物料</th>
                  <th className="px-3 py-2.5 text-right font-semibold">计划量</th>
                  <th className="px-3 py-2.5 text-right font-semibold">已完成</th>
                  <th className="px-3 py-2.5 font-semibold">状态</th>
                  {editing && <th className="px-3 py-2.5 text-center font-semibold">处理</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/80 bg-white/50">
                {edits.map((row) => (
                  <tr key={row.assignmentId} className={cn('transition-colors', row.delete ? 'bg-red-50/80 opacity-60' : 'hover:bg-white')}>
                    <td className="px-4 py-3">
                      {editing ? <input disabled={data.assignments.find((item) => item.assignmentId === row.assignmentId)?.locked} type="date" value={row.productionDate} onChange={(event) => updateEdit(row.assignmentId, { productionDate: event.target.value })} className="w-[132px] rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-amber-500 focus:outline-none disabled:bg-slate-100 disabled:opacity-60" /> : <span className="font-medium text-slate-800">{row.productionDate}</span>}
                    </td>
                    <td className="px-3 py-3">
                      {editing ? <select disabled={data.assignments.find((item) => item.assignmentId === row.assignmentId)?.locked} value={row.shiftCode} onChange={(event) => updateEdit(row.assignmentId, { shiftCode: event.target.value })} className="w-28 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-amber-500 focus:outline-none disabled:bg-slate-100 disabled:opacity-60">{data.shifts.map((shift) => <option key={shift.code} value={shift.code}>{shift.code} · {shift.name}</option>)}</select> : <span className="text-slate-700">{data.shifts.find((shift) => shift.code === row.shiftCode)?.name || row.shiftCode}</span>}
                    </td>
                    <td className="px-3 py-3">
                      {editing ? <select disabled={data.assignments.find((item) => item.assignmentId === row.assignmentId)?.locked} value={row.resourceCode} onChange={(event) => updateEdit(row.assignmentId, { resourceCode: event.target.value })} className="w-48 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-amber-500 focus:outline-none disabled:bg-slate-100 disabled:opacity-60">{data.resources.filter((resource) => resource.productCodes.includes(row.productCode)).map((resource) => <option key={resource.code} value={resource.code}>{formatEntityLabel(resource.name, resource.code)}</option>)}</select> : <span className="rounded bg-slate-800 px-2 py-1 text-[11px] text-white">{formatEntityLabel(data.assignments.find((item) => item.assignmentId === row.assignmentId)?.resourceName, row.resourceCode)}</span>}
                    </td>
                    <td className="px-3 py-3 text-slate-700">{data.assignments.find((item) => item.assignmentId === row.assignmentId)?.workPosition || 'L/R'}</td>
                    <td className="px-3 py-3">{editing ? <select disabled={data.assignments.find((item) => item.assignmentId === row.assignmentId)?.locked} value={row.productCode} onChange={(event) => updateEdit(row.assignmentId, { productCode: event.target.value })} className="w-52 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-amber-500 focus:outline-none disabled:bg-slate-100 disabled:opacity-60">{data.products.filter((product) => product.resourceCodes.includes(row.resourceCode)).map((product) => <option key={product.code} value={product.code}>{formatEntityLabel(product.name, product.code)}</option>)}</select> : <span className="text-slate-700">{formatEntityLabel(data.assignments.find((item) => item.assignmentId === row.assignmentId)?.productName || data.products.find((product) => product.code === row.productCode)?.name, row.productCode)}</span>}</td>
                    <td className="px-3 py-3 text-right">
                      {editing ? <input disabled={data.assignments.find((item) => item.assignmentId === row.assignmentId)?.locked} type="number" min={1} value={row.quantity} onChange={(event) => updateEdit(row.assignmentId, { quantity: Number(event.target.value) })} className="w-20 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-right text-xs focus:border-amber-500 focus:outline-none disabled:bg-slate-100 disabled:opacity-60" /> : <span className="font-semibold tabular-nums text-slate-900">{formatNumber(row.quantity)}</span>}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums text-slate-600">{formatNumber(data.assignments.find((item) => item.assignmentId === row.assignmentId)?.actualQuantity || 0)}</td>
                    <td className="px-3 py-3"><span className={cn('rounded-full px-2 py-1 text-[10px] font-semibold', data.assignments.find((item) => item.assignmentId === row.assignmentId)?.locked ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700')}>{data.assignments.find((item) => item.assignmentId === row.assignmentId)?.planStateLabel || '待审批'}</span></td>
                    {editing && <td className="px-3 py-3 text-center"><button disabled={data.assignments.find((item) => item.assignmentId === row.assignmentId)?.locked} type="button" onClick={() => updateEdit(row.assignmentId, { delete: !row.delete })} className={cn('inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-30', row.delete ? 'border-slate-300 bg-white text-slate-600' : 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100')} title={row.delete ? '恢复' : '从新版本删除'}>{row.delete ? <RotateCcw size={13} /> : <Trash2 size={13} />}</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {editing && (
            <div className="border-t border-slate-200 bg-white/70 px-4 py-3">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">调整原因（写入版本审计）</label>
              <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：CU018 周四检修，计划转移至 CU021" className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200" />
            </div>
          )}

          {!editing && data.publishConflicts.length > 0 && !data.published && (
            <div className="border-t border-amber-200 bg-amber-50 px-4 py-3">
              <div className="text-xs font-semibold text-amber-900">检测到 {data.publishConflicts.length} 个班次已有计划</div>
              <div className="mt-1 text-[11px] text-amber-800">默认安全阻断；执行中或已有实际产量的计划永久锁定，已接收但未执行的计划仍可调整。</div>
              <select value={conflictPolicy} onChange={(event) => setConflictPolicy(event.target.value as ScheduleConflictPolicy)} className="mt-2 rounded-md border border-amber-300 bg-white px-2 py-1.5 text-xs text-slate-800">
                <option value="block">遇到冲突则阻断</option>
                <option value="append">保留已有计划并追加</option>
                <option value="replace_unstarted">替换未开工的同物料计划</option>
              </select>
            </div>
          )}

          {error && <div className="border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</div>}

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-[#f1eee6] px-4 py-3">
            <div className="text-[10px] text-slate-500">
              {data.published
                ? '已下达但未执行、实际产量为 0 的计划仍可调整或覆盖 · 已执行或已有实际产量后锁定'
                : '调整会创建新版本 · 原版本与审批记录保留 · 未审批前不会进入正式计划'}
            </div>
            <div className="flex flex-wrap gap-2">
              {editing ? (
                <>
                  <button type="button" disabled={busy} onClick={() => { setEditing(false); setError(''); setEdits(data.assignments.map((row) => ({ ...row, delete: false }))) }} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"><X size={13} /> 取消</button>
                  <button type="button" disabled={busy} onClick={submitEdits} className="inline-flex items-center gap-1.5 rounded-lg bg-amber-400 px-3 py-2 text-xs font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-50"><Check size={13} /> 提交新版本</button>
                </>
              ) : (
                <>
                  <button type="button" disabled={!data.canEdit || busy} onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-amber-400 hover:bg-amber-50 disabled:opacity-50"><PencilLine size={13} /> 编辑计划</button>
                  <button type="button" disabled={busy} onClick={() => void runMessage(buildReplanMessage(data.displayReference))} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"><RotateCcw size={13} /> 重新排产</button>
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
      <div className="flex items-center justify-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">{icon}{label}</div>
      <div className={cn('mt-1 font-mono text-lg font-bold tabular-nums', tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-900')}>{value}</div>
    </div>
  )
}

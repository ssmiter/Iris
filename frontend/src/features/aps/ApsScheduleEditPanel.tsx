import { LockKeyhole, RotateCcw, Trash2, X } from 'lucide-react'
import { formatEntityLabel, type ApsScheduleEdit, type ApsScheduleResult } from './apsScheduleResultAdapter'

interface Props {
  data: ApsScheduleResult
  edit: ApsScheduleEdit
  reason: string
  onChange: (patch: Partial<ApsScheduleEdit>) => void
  onReasonChange: (reason: string) => void
  onClose: () => void
}

export function ApsScheduleEditPanel({ data, edit, reason, onChange, onReasonChange, onClose }: Props) {
  const original = data.assignments.find((row) => row.assignmentId === edit.assignmentId)
  if (!original) return null
  const disabled = original.locked

  return (
    <aside className="border-y border-[var(--wf-line)] bg-[var(--wf-card-bg)] px-4 py-4" aria-label="排产任务编辑面板">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-[var(--wf-ink)]">编辑生产任务</div>
          <div className="mt-0.5 text-[11px] text-[var(--wf-mut)]">{formatEntityLabel(original.productName, original.productCode)} · {formatEntityLabel(original.resourceName, original.resourceCode)}</div>
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-[var(--wf-mut)] hover:bg-[var(--wf-hover)]" aria-label="关闭编辑面板"><X size={15} /></button>
      </div>
      {disabled && <div className="mb-3 flex items-center gap-2 rounded-lg bg-[var(--wf-err-bg)] px-3 py-2 text-xs text-[var(--wf-err-ink)]"><LockKeyhole size={14} />该任务已有实绩或处于执行锁定状态，只能查看。</div>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="生产日期"><input disabled={disabled || edit.delete} type="date" value={edit.productionDate} onChange={(event) => onChange({ productionDate: event.target.value })} className="control" /></Field>
        <Field label="班次"><select disabled={disabled || edit.delete} value={edit.shiftCode} onChange={(event) => onChange({ shiftCode: event.target.value })} className="control">{data.shifts.map((shift) => <option key={shift.code} value={shift.code}>{shift.name} · {shift.code}</option>)}</select></Field>
        <Field label="机台 / 模位"><select disabled={disabled || edit.delete} value={edit.resourceCode} onChange={(event) => onChange({ resourceCode: event.target.value })} className="control">{data.resources.filter((resource) => resource.productCodes.includes(edit.productCode)).map((resource) => <option key={resource.code} value={resource.code}>{formatEntityLabel(resource.name, resource.code)}</option>)}</select></Field>
        <Field label="物料"><select disabled={disabled || edit.delete} value={edit.productCode} onChange={(event) => onChange({ productCode: event.target.value })} className="control">{data.products.filter((product) => product.resourceCodes.includes(edit.resourceCode)).map((product) => <option key={product.code} value={product.code}>{formatEntityLabel(product.name, product.code)}</option>)}</select></Field>
        <Field label="计划量"><input disabled={disabled || edit.delete} type="number" min={1} value={edit.quantity} onChange={(event) => onChange({ quantity: Number(event.target.value) })} className="control" /></Field>
        <div className="flex items-end"><button disabled={disabled} type="button" onClick={() => onChange({ delete: !edit.delete })} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--wf-err-line)] bg-[var(--wf-err-bg)] px-3 py-2 text-xs font-semibold text-[var(--wf-err-ink)] disabled:opacity-40">{edit.delete ? <RotateCcw size={13} /> : <Trash2 size={13} />}{edit.delete ? '恢复任务' : '从新版本删除'}</button></div>
      </div>
      <label className="mt-3 block text-[10px] font-semibold uppercase tracking-wider text-[var(--wf-mut)]">调整原因（写入版本审计）</label>
      <input disabled={disabled} value={reason} onChange={(event) => onReasonChange(event.target.value)} placeholder="例如：避开检修机台，调整到同工序可用模位" className="mt-1.5 w-full rounded-lg border border-[var(--wf-line)] px-3 py-2 text-xs focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200 disabled:bg-[var(--wf-mono-bg)]" />
    </aside>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--wf-mut)]">{label}<div className="mt-1 [&_.control]:w-full [&_.control]:rounded-lg [&_.control]:border [&_.control]:border-[var(--wf-line)] [&_.control]:bg-[var(--wf-card-bg)] [&_.control]:px-2.5 [&_.control]:py-2 [&_.control]:text-xs [&_.control]:text-[var(--wf-ink)] [&_.control]:outline-none [&_.control:focus]:border-amber-500 [&_.control:disabled]:bg-[var(--wf-mono-bg)]">{children}</div></label>
}

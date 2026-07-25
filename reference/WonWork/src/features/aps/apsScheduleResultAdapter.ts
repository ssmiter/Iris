export interface ApsScheduleAssignment {
  assignmentId: string
  productionDate: string
  shiftCode: string
  resourceCode: string
  resourceName: string
  productCode: string
  productName: string
  quantity: number
  actualQuantity: number
  workPosition: string
  sequence: number
  planState: string
  planStateLabel: string
  capabilityMatched: boolean
  locked: boolean
  resourceModel: string
}

export interface ApsScheduleResult {
  status: string
  planId: string
  planCode: string
  processCode: string
  processName: string
  displayReference: string
  revision: number
  engineStatus: string
  engineMessage: string
  demandTotal: number
  assignmentTotal: number
  assignmentCount: number
  canEdit: boolean
  canApprovePublish: boolean
  published: boolean
  assignments: ApsScheduleAssignment[]
  shifts: ScheduleShiftOption[]
  resources: ScheduleResourceOption[]
  products: ScheduleProductOption[]
  publishConflicts: SchedulePublishConflict[]
}

export interface ScheduleShiftOption { code: string; name: string; startTime: string; stopTime: string }
export interface ScheduleResourceOption { code: string; name: string; productCodes: string[] }
export interface ScheduleProductOption { code: string; name: string; resourceCodes: string[] }
export interface SchedulePublishConflict { productionDate: string; shiftCode: string; resourceCode: string; existingCount: number; startedCount: number }
export type ScheduleConflictPolicy = 'block' | 'append' | 'replace_unstarted'

export interface ApsScheduleEdit {
  assignmentId: string
  productCode: string
  productionDate: string
  shiftCode: string
  resourceCode: string
  quantity: number
  delete: boolean
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback
  return String(value)
}

function number(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function boolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 1
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : []
}

export function formatEntityLabel(name: string | null | undefined, code: string | null | undefined): string {
  const normalizedName = String(name ?? '').trim()
  const normalizedCode = String(code ?? '').trim()
  if (!normalizedCode) return normalizedName
  if (!normalizedName || normalizedName.localeCompare(normalizedCode, undefined, { sensitivity: 'accent' }) === 0) {
    return normalizedCode
  }
  return `${normalizedName} - ${normalizedCode}`
}

export function parseApsScheduleResult(value: unknown): ApsScheduleResult | null {
  if (!isRecord(value) || !('plan_id' in value) || !('status' in value)) return null

  const assignments = Array.isArray(value.assignments)
    ? value.assignments.filter(isRecord).map((row) => ({
        assignmentId: text(row.assignment_id),
        productionDate: text(row.production_date),
        shiftCode: text(row.shift_code, '01'),
        resourceCode: text(row.resource_code),
        resourceName: text(row.resource_name, text(row.resource_code)),
        productCode: text(row.product_code),
        productName: text(row.product_name, text(row.product_code)),
        quantity: number(row.quantity),
        actualQuantity: number(row.actual_quantity),
        workPosition: text(row.work_position, 'L/R'),
        sequence: number(row.sequence),
        planState: text(row.plan_state, '0'),
        planStateLabel: text(row.plan_state_label, '待审批'),
        capabilityMatched: boolean(row.capability_matched),
        locked: boolean(row.locked),
        resourceModel: text(row.resource_model),
      })).filter((row) => row.assignmentId.length > 0)
    : []

  return {
    status: text(value.status),
    planId: text(value.plan_id),
    planCode: text(value.plan_code),
    processCode: text(value.process_code),
    processName: text(value.process_name, text(value.process_code)),
    displayReference: text(value.display_reference, '当前生产排产方案'),
    revision: number(value.revision, 1),
    engineStatus: text(value.engine_status, 'PENDING'),
    engineMessage: text(value.engine_message),
    demandTotal: number(value.demand_total),
    assignmentTotal: number(value.assignment_total),
    assignmentCount: number(value.assignment_count, assignments.length),
    canEdit: boolean(value.can_edit),
    canApprovePublish: boolean(value.can_approve_publish),
    published: boolean(value.published_to_iris),
    assignments,
    shifts: Array.isArray(value.shift_options) ? value.shift_options.filter(isRecord).map((row) => ({
      code: text(row.code ?? row.Code), name: text(row.name ?? row.Name),
      startTime: text(row.start_time ?? row.StartTime), stopTime: text(row.stop_time ?? row.StopTime),
    })).filter((row) => row.code) : [],
    resources: Array.isArray(value.resource_options) ? value.resource_options.filter(isRecord).map((row) => ({
      code: text(row.code), name: text(row.name, text(row.code)), productCodes: stringArray(row.product_codes),
    })).filter((row) => row.code) : [],
    products: Array.isArray(value.product_options) ? value.product_options.filter(isRecord).map((row) => ({
      code: text(row.code), name: text(row.name, text(row.code)), resourceCodes: stringArray(row.resource_codes),
    })).filter((row) => row.code) : [],
    publishConflicts: Array.isArray(value.publish_conflicts) ? value.publish_conflicts.filter(isRecord).map((row) => ({
      productionDate: text(row.production_date), shiftCode: text(row.shift_code), resourceCode: text(row.resource_code),
      existingCount: number(row.existing_count), startedCount: number(row.started_count),
    })) : [],
  }
}

export function buildAdjustmentMessage(
  displayReference: string,
  reason: string,
  edits: ApsScheduleEdit[]
): string {
  const rows = edits.map((edit) => {
    const changes = edit.delete
      ? 'delete=true'
      : `production_date=${edit.productionDate}, shift_code=${edit.shiftCode}, resource_code=${edit.resourceCode}, product_code=${edit.productCode}, quantity=${edit.quantity}`
    return `assignment_id=${edit.assignmentId}, ${changes}`
  }).join('；')

  return `请调整${displayReference}。调整原因：${reason.trim()}。修改项：${rows}。请根据当前卡片对应的内部计划生成新版本并再次展示结果，不要自动发布。`
}

export function buildApprovalMessage(displayReference: string, conflictPolicy: ScheduleConflictPolicy): string {
  const policyLabel = conflictPolicy === 'append' ? '追加' : conflictPolicy === 'replace_unstarted' ? '替换未开工计划' : '遇到冲突则阻断'
  return `我已复核${displayReference}，现明确审批通过并发布，已有班次计划按${policyLabel}策略处理（conflict_policy=${conflictPolicy}）。`
}

export function buildRefreshMessage(displayReference: string): string {
  return `请查看${displayReference}，不要自动发布。`
}

export function buildReplanMessage(displayReference: string): string {
  return `我要重新排产${displayReference}。请先询问我要修改的产量、交期或约束，不要直接发布。`
}

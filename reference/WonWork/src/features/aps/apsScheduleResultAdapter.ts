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
  timelinePrecision: 'exact' | 'shift'
  timelineWindow: ScheduleTimelineWindow | null
  resourceGroups: ScheduleResourceGroup[]
  timelineSegments: ScheduleTimelineSegment[]
  timelineDiagnostics: string[]
}

export interface ScheduleShiftOption { code: string; name: string; startTime: string; stopTime: string }
export interface ScheduleResourceOption { code: string; name: string; productCodes: string[] }
export interface ScheduleProductOption { code: string; name: string; resourceCodes: string[] }
export interface SchedulePublishConflict { productionDate: string; shiftCode: string; resourceCode: string; existingCount: number; startedCount: number }
export interface ScheduleTimelineWindow { startTime: string; endTime: string; timezone: string }
export interface ScheduleResourceGroup { resourceCode: string; resourceName: string; children: string[] }
export type ScheduleTimelineSegmentType = 'PRODUCTION' | 'CHANGEOVER' | 'UNAVAILABLE'
export interface ScheduleTimelineSegment {
  segmentId: string
  assignmentId: string
  segmentType: ScheduleTimelineSegmentType
  resourceCode: string
  productCode: string
  quantity: number | null
  startTime: string
  endTime: string
  locked: boolean
}
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

export interface ApsScheduleAdjustmentContext {
  assignments?: Pick<ApsScheduleAssignment,
    'assignmentId' | 'productionDate' | 'shiftCode' | 'resourceCode' | 'resourceName' | 'productCode' | 'productName' | 'quantity'>[]
  shifts?: ScheduleShiftOption[]
  resources?: ScheduleResourceOption[]
  products?: ScheduleProductOption[]
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

  const timelineWindowRow = isRecord(value.timeline_window) ? value.timeline_window : null
  const timelineWindow = timelineWindowRow
    ? {
        startTime: text(timelineWindowRow.start_time),
        endTime: text(timelineWindowRow.end_time),
        timezone: text(timelineWindowRow.timezone, 'Asia/Shanghai'),
      }
    : null
  const timelineSegments = Array.isArray(value.timeline_segments)
    ? value.timeline_segments.filter(isRecord).map((row) => ({
        segmentId: text(row.segment_id),
        assignmentId: text(row.assignment_id),
        segmentType: text(row.segment_type) as ScheduleTimelineSegmentType,
        resourceCode: text(row.resource_code),
        productCode: text(row.product_code),
        quantity: row.quantity === null || row.quantity === undefined ? null : number(row.quantity),
        startTime: text(row.start_time),
        endTime: text(row.end_time),
        locked: boolean(row.locked),
      })).filter((row) => row.segmentId && row.assignmentId && row.resourceCode
        && ['PRODUCTION', 'CHANGEOVER', 'UNAVAILABLE'].includes(row.segmentType)
        && Number.isFinite(Date.parse(row.startTime)) && Number.isFinite(Date.parse(row.endTime))
        && Date.parse(row.endTime) > Date.parse(row.startTime))
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
    timelinePrecision: value.timeline_precision === 'exact' ? 'exact' : 'shift',
    timelineWindow,
    resourceGroups: Array.isArray(value.resource_groups) ? value.resource_groups.filter(isRecord).map((row) => ({
      resourceCode: text(row.resource_code), resourceName: text(row.resource_name, text(row.resource_code)),
      children: stringArray(row.children),
    })).filter((row) => row.resourceCode) : [],
    timelineSegments,
    timelineDiagnostics: stringArray(value.timeline_diagnostics),
  }
}

export function buildAdjustmentMessage(
  displayReference: string,
  reason: string,
  edits: ApsScheduleEdit[],
  context: ApsScheduleAdjustmentContext = {}
): string {
  const assignments = context.assignments ?? []
  const shiftLabel = (code: string, fallback = '相应班次') => {
    const option = context.shifts?.find((shift) => shift.code === code)
    const knownNames: Record<string, string> = { '01': '白班', '02': '中班', '03': '夜班' }
    return knownNames[code] ?? (option?.name ? `${option.name}班` : fallback)
  }
  const humanLabel = (name: string | undefined, code: string, fallback: string) => {
    const normalizedName = String(name ?? '').trim()
    if (normalizedName) return normalizedName
    const option = fallback === '机台'
      ? context.resources?.find((resource) => resource.code === code)
      : context.products?.find((product) => product.code === code)
    return String(option?.name ?? code).trim() || fallback
  }
  const dateLabel = (value: string) => {
    const [, month, day] = value.split('-')
    return month && day ? `${Number(month)}月${Number(day)}日` : value
  }

  const rows = edits.map((edit) => {
    const originalIndex = assignments.findIndex((assignment) => assignment.assignmentId === edit.assignmentId)
    const original = originalIndex >= 0 ? assignments[originalIndex] : undefined
    const ordinal = originalIndex >= 0 ? `第${originalIndex + 1}条任务` : '这条任务'
    if (edit.delete) return `删除${ordinal}`

    const changes: string[] = []
    if (!original || edit.productionDate !== original.productionDate) {
      changes.push(`日期改为${dateLabel(edit.productionDate)}`)
    }
    if (!original || edit.shiftCode !== original.shiftCode) {
      changes.push(`班次改为${shiftLabel(edit.shiftCode)}`)
    }
    if (!original || edit.resourceCode !== original.resourceCode) {
      changes.push(`改到${humanLabel(undefined, edit.resourceCode, '机台')}`)
    }
    if (!original || edit.productCode !== original.productCode) {
      changes.push(`物料改为${humanLabel(undefined, edit.productCode, '物料')}`)
    }
    if (!original || edit.quantity !== original.quantity) {
      changes.push(`数量改为${edit.quantity}条`)
    }
    return `${ordinal}${changes.length > 0 ? changes.join('，') : '保持原安排'}`
  }).join('；')

  // displayReference 只用于卡片标题，可能包含内部版本或引擎信息；对用户沿用“刚才这份排产”即可。
  void displayReference
  return `把刚才这份排产中的${rows}。原因是“${reason.trim()}”。先生成一个新版本让我核对，暂时不要下发。`
}

export function buildApprovalMessage(displayReference: string, conflictPolicy: ScheduleConflictPolicy): string {
  void displayReference
  if (conflictPolicy === 'append') {
    return '我已核对这份排产，审批通过并下发；已有班次计划按追加方式处理。'
  }
  if (conflictPolicy === 'replace_unstarted') {
    return '我已核对这份排产，审批通过并下发；同一班次已有但尚未开工的计划可以替换。'
  }
  return '我已核对这份排产，审批通过并下发；如果同一班次已有计划，请先停下来让我确认。'
}

export function buildRefreshMessage(displayReference: string): string {
  void displayReference
  return '把刚才的排产结果再给我看一遍，先不要下发。'
}

export function buildReplanMessage(displayReference: string): string {
  void displayReference
  return '这份排产我想重新安排一下，先问我产量、交期或限制条件；排好后给我核对，先不要下发。'
}

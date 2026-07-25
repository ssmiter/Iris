import type { Trace, Span, SpanKind, SpanEvent, ToolResult } from './types'
import {
  TrajectoryLogger,
  type TrajectoryType,
  type TrajectoryPhase,
  type TrajectoryTrace,
} from '@/utils/trajectoryLogger'

/**
 * Trace/Span 可观测收集器
 *
 * - 内部维护 Trace / Span 树结构，支撑后续调用链可视化；
 * - 通过 `toTrajectoryLogger()` 提供旧版 TrajectoryLogger API 兼容；
 * - 持久化复用原有 TrajectoryLogger 的 IndexedDB / `/api/trajectory` 逻辑。
 */

export interface TraceCollectorOptions {
  /** 是否同步写入旧 TrajectoryLogger 持久化；默认 true */
  enableLegacyPersistence?: boolean
}

function generateTraceId(): string {
  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function generateSpanId(): string {
  return `span-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export class TraceCollector {
  private logger: TrajectoryLogger
  private currentTrace?: Trace
  private spanMap = new Map<string, Span>()
  private phaseMap = new Map<string, string>() // spanId -> phaseId
  private enableLegacyPersistence: boolean

  constructor(options?: TraceCollectorOptions) {
    this.enableLegacyPersistence = options?.enableLegacyPersistence !== false
    this.logger = new TrajectoryLogger()
  }

  startTrace(
    input: string,
    type: Trace['type'],
    metadata?: Record<string, unknown>
  ): Trace {
    const traceId = generateTraceId()
    const startedAt = Date.now()
    const rootSpan = this.createSpanInternal(
      traceId,
      undefined,
      'model_call',
      'root',
      metadata
    )
    const trace: Trace = {
      traceId,
      type,
      rootSpan,
      spans: [rootSpan],
      status: 'running',
      startedAt,
      input,
      metadata,
    }
    this.currentTrace = trace
    this.spanMap.set(rootSpan.spanId, rootSpan)

    if (this.enableLegacyPersistence) {
      this.logger.startTrace(input, type as TrajectoryType, metadata)
    }
    return trace
  }

  startSpan(
    kind: SpanKind,
    name: string,
    parentSpanId?: string,
    attributes?: Record<string, unknown>
  ): Span {
    const trace = this.currentTrace
    if (!trace) {
      throw new Error('TraceCollector: 未调用 startTrace 就尝试 startSpan')
    }
    const span = this.createSpanInternal(
      trace.traceId,
      parentSpanId,
      kind,
      name,
      attributes
    )
    trace.spans.push(span)
    this.spanMap.set(span.spanId, span)

    if (this.enableLegacyPersistence) {
      const phase = this.logger.addPhase(name, {
        status: 'running',
        metadata: { kind, ...attributes },
      })
      this.phaseMap.set(span.spanId, phase.id)
    }
    return span
  }

  completeSpan(spanId: string, attributes?: Record<string, unknown>): void {
    const span = this.spanMap.get(spanId)
    if (!span) return
    span.endedAt = Date.now()
    span.durationMs = span.endedAt - span.startedAt
    span.status = 'completed'
    if (attributes) {
      span.attributes = { ...span.attributes, ...attributes }
    }

    if (this.enableLegacyPersistence) {
      const phaseId = this.phaseMap.get(spanId)
      if (phaseId) {
        this.logger.completePhase(phaseId, attributes)
      }
    }
  }

  failSpan(spanId: string, error: string, attributes?: Record<string, unknown>): void {
    const span = this.spanMap.get(spanId)
    if (!span) return
    span.endedAt = Date.now()
    span.durationMs = span.endedAt - span.startedAt
    span.status = 'error'
    if (attributes) {
      span.attributes = { ...span.attributes, ...attributes }
    }

    if (this.enableLegacyPersistence) {
      const phaseId = this.phaseMap.get(spanId)
      if (phaseId) {
        this.logger.completePhase(phaseId, attributes, error)
      }
    }
  }

  addEvent(spanId: string, name: string, attributes?: Record<string, unknown>): void {
    const span = this.spanMap.get(spanId)
    if (!span) return
    const event: SpanEvent = {
      name,
      timestamp: Date.now(),
      attributes,
    }
    span.events.push(event)
  }

  complete(summary?: string, metadata?: Record<string, unknown>): Trace {
    const trace = this.currentTrace
    if (!trace) {
      throw new Error('TraceCollector: 未调用 startTrace 就尝试 complete')
    }
    trace.endedAt = Date.now()
    trace.durationMs = trace.endedAt - trace.startedAt
    trace.status = 'completed'
    if (summary) trace.summary = summary
    if (metadata) trace.metadata = { ...trace.metadata, ...metadata }

    // 自动补全未关闭的 span
    for (const span of trace.spans) {
      if (span.status === 'running') {
        this.completeSpan(span.spanId)
      }
    }

    if (this.enableLegacyPersistence) {
      this.logger.complete(summary, metadata)
    }
    this.currentTrace = undefined
    return trace
  }

  fail(error: string | Error, summary?: string): Trace {
    const trace = this.currentTrace
    if (!trace) {
      throw new Error('TraceCollector: 未调用 startTrace 就尝试 fail')
    }
    const errorMessage = error instanceof Error ? error.message : error
    trace.endedAt = Date.now()
    trace.durationMs = trace.endedAt - trace.startedAt
    trace.status = 'error'
    trace.error = errorMessage
    if (summary) trace.summary = summary

    for (const span of trace.spans) {
      if (span.status === 'running') {
        this.failSpan(span.spanId, errorMessage)
      }
    }

    if (this.enableLegacyPersistence) {
      this.logger.fail(error, summary)
    }
    this.currentTrace = undefined
    return trace
  }

  getCurrentTrace(): Trace | undefined {
    return this.currentTrace
  }

  getSpan(spanId: string): Span | undefined {
    return this.spanMap.get(spanId)
  }

  /**
   * 兼容旧 TrajectoryLogger 的 facade
   */
  toTrajectoryLogger(): TrajectoryLogger {
    return {
      startTrace: (input: string, type: TrajectoryType, metadata?: Record<string, unknown>) => {
        this.startTrace(input, type as Trace['type'], metadata)
        return this.logger.getCurrentTrace() as TrajectoryTrace
      },
      addPhase: (name: string, options?: Parameters<TrajectoryLogger['addPhase']>[1]) => {
        const span = this.startSpan(
          (options?.metadata?.kind as SpanKind) ?? 'tool_call',
          name,
          undefined,
          options?.metadata
        )
        return {
          id: this.phaseMap.get(span.spanId) ?? span.spanId,
          name,
          status: 'running',
          startedAt: span.startedAt,
          input: options?.input,
          output: options?.output,
          error: options?.error,
          metadata: options?.metadata,
        } as TrajectoryPhase
      },
      completePhase: (phaseId: string, output?: unknown, error?: string) => {
        const spanId = this.findSpanIdByPhaseId(phaseId)
        if (error) {
          this.failSpan(spanId, error, output as Record<string, unknown>)
        } else {
          this.completeSpan(spanId, output as Record<string, unknown>)
        }
      },
      complete: (summary?: string, metadata?: Record<string, unknown>) => this.complete(summary, metadata),
      fail: (error: string | Error, summary?: string) => this.fail(error, summary),
      getCurrentTrace: () => this.logger.getCurrentTrace() as TrajectoryTrace | null,
    } as unknown as TrajectoryLogger
  }

  private createSpanInternal(
    traceId: string,
    parentSpanId: string | undefined,
    kind: SpanKind,
    name: string,
    attributes?: Record<string, unknown>
  ): Span {
    return {
      spanId: generateSpanId(),
      parentSpanId,
      traceId,
      kind,
      name,
      status: 'running',
      startedAt: Date.now(),
      attributes: { ...attributes },
      events: [],
    }
  }

  private findSpanIdByPhaseId(phaseId: string): string {
    for (const [spanId, mappedPhaseId] of this.phaseMap.entries()) {
      if (mappedPhaseId === phaseId) return spanId
    }
    return phaseId
  }
}

export function createTraceCollector(options?: TraceCollectorOptions): TraceCollector {
  return new TraceCollector(options)
}

/**
 * 将 ToolResult 快速记录为 span 属性
 */
export function toolResultToSpanAttributes(result: ToolResult): Record<string, unknown> {
  return {
    toolCallId: result.toolCallId,
    toolName: result.name,
    success: result.success,
    isTruncated: result.isTruncated,
    persistedUrl: result.persistedUrl,
    durationMs: result.endedAt - result.startedAt,
  }
}

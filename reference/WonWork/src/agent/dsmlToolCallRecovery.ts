/**
 * DSML 工具调用兜底回收（2026-08-24）。
 *
 * 背景：DeepSeek 系模型偶发不走结构化 tool_calls 字段，而是把工具调用以 DSML 标记
 * 写进正文 content：
 *   <｜｜DSML｜｜tool_calls>
 *   <｜｜DSML｜｜invoke name="tool_name">
 *   <｜｜DSML｜｜parameter name="arg" string="true">值</｜｜DSML｜｜parameter>
 *   </｜｜DSML｜｜invoke>
 *   </｜｜DSML｜｜tool_calls>
 * 前端各 modelClient 只认 delta.tool_calls，这些标记会原样渲染给用户、loop 直接收尾，
 * 用户被迫发"继续"。（实测：竖线为全角 ｜，单双竖线两种形态都出现过，解析一律容忍。）
 *
 * 本模块两件事：
 * 1) 流式过滤器——content chunk 经过它，疑似 DSML 起始的尾部被扣住不上屏；
 * 2) 收尾解析器——流结束时把扣下的标记解析成结构化工具调用（识别硬、应对软：
 *    解析失败由调用方把原文回落为正文，标记不凭空消失）。
 *
 * 纯函数/纯状态机，不依赖 loop 内部结构，便于单测。
 */

/** 实测出现的两种起始标记（双竖线为观察到的主力形态，单竖线为官方文档形态）。 */
const OPEN_MARKERS = ['<｜｜DSML｜｜tool_calls>', '<｜DSML｜tool_calls>'] as const

/** 最长起始标记长度——扣尾缓冲只需要保留这么长。 */
const MAX_MARKER_LEN = Math.max(...OPEN_MARKERS.map((m) => m.length))

export interface DsmlFilterFinish {
  /** 收尾时确认不是 DSML 的扣留文本，应作为正文补显示。 */
  trailingText: string
  /** 从起始标记到流末尾的完整 DSML 段（无则为空串）。 */
  dsmlMarkup: string
}

export interface DsmlStreamFilter {
  /** 送入一段 content chunk，返回可以立即上屏的文本（疑似标记段被扣住）。 */
  push(text: string): string
  /** 流结束时调用，取回扣留文本的去向判定。 */
  finish(): DsmlFilterFinish
}

/** 判断 candidate 是否可能是某个起始标记的前缀（用于流式扣尾）。 */
function isMarkerPrefix(candidate: string): boolean {
  return OPEN_MARKERS.some((marker) => marker.startsWith(candidate))
}

export function createDsmlStreamFilter(): DsmlStreamFilter {
  // 尚未确认是标记的扣留文本（长度 < MAX_MARKER_LEN 的尾部）
  let pending = ''
  // 一旦确认进入 DSML 段，后续所有文本都进这里，直到流结束
  let markup: string | null = null

  return {
    push(text: string): string {
      if (!text) return ''
      if (markup !== null) {
        markup += text
        return ''
      }
      const buf = pending + text
      pending = ''

      // 完整标记命中：标记前文本立即可见，标记起进入扣留
      let hitAt = -1
      for (const marker of OPEN_MARKERS) {
        const at = buf.indexOf(marker)
        if (at >= 0 && (hitAt < 0 || at < hitAt)) hitAt = at
      }
      if (hitAt >= 0) {
        markup = buf.slice(hitAt)
        return buf.slice(0, hitAt)
      }

      // 未命中完整标记：从尾部找"可能是标记开头"的最长后缀扣住，其余放行。
      // 只检查末尾 MAX_MARKER_LEN 个字符内的 '<' 起点，成本 O(标记长)。
      const tailStart = Math.max(0, buf.length - MAX_MARKER_LEN)
      for (let i = buf.length - 1; i >= tailStart; i--) {
        if (buf[i] !== '<') continue
        const candidate = buf.slice(i)
        if (isMarkerPrefix(candidate)) {
          pending = candidate
          return buf.slice(0, i)
        }
      }
      return buf
    },

    finish(): DsmlFilterFinish {
      const trailingText = pending
      pending = ''
      const dsmlMarkup = markup ?? ''
      markup = null
      return { trailingText, dsmlMarkup }
    },
  }
}

export interface RecoveredDsmlToolCall {
  name: string
  /** JSON 字符串（与 OpenAI tool_calls 的 function.arguments 同形态）。 */
  arguments: string
}

const INVOKE_RE = /<｜+DSML｜+invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/｜+DSML｜+invoke>/g
const PARAM_RE = /<｜+DSML｜+parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜+DSML｜+parameter>/g

/**
 * 把 DSML 标记段解析成结构化工具调用列表。
 * 返回 null = 解析不出任何完整 invoke（调用方应把原文回落为正文）。
 */
export function parseDsmlToolCalls(markup: string): RecoveredDsmlToolCall[] | null {
  if (!/<｜+DSML｜+tool_calls>/.test(markup)) return null

  const calls: RecoveredDsmlToolCall[] = []
  INVOKE_RE.lastIndex = 0
  let invokeMatch: RegExpExecArray | null
  while ((invokeMatch = INVOKE_RE.exec(markup)) !== null) {
    const name = invokeMatch[1].trim()
    if (!name) continue
    const body = invokeMatch[2]
    const args: Record<string, string> = {}
    PARAM_RE.lastIndex = 0
    let paramMatch: RegExpExecArray | null
    while ((paramMatch = PARAM_RE.exec(body)) !== null) {
      args[paramMatch[1]] = paramMatch[2]
    }
    calls.push({ name, arguments: JSON.stringify(args) })
  }

  return calls.length > 0 ? calls : null
}

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { useChatStore } from '@/stores/chatStore'
import type { WebBridgeLogEntry } from '@/types/webbridge'

/**
 * 浏览器舞台（蓝图 v8「过程即内容」的生产落地）
 *
 * 挂载于 WaterfallTurn 的 RoundView：本轮含有 webbridge_* 工具节点时出现。
 * - 运行中：实时画面（daemon 每个画面变更动作后附带的 JPEG 缩略帧，交叉淡入）、
 *   URL 栏、连接呼吸灯、步骤进度条、动作字幕轨、就地审批浮层、「接管」暂停门
 * - 收尾后：收拢为一枚带最终帧缩略图的 chip，点击灯箱回看
 *
 * 数据来源（全部为既有响应式状态，详见 WebBridge交互蓝图参考文档 §4.1）：
 * - pageState / currentScreenshot / isExecuting / currentWorkflowStepIndex —— webbridgeStore
 * - 审批 —— chatStore.pendingApprovals（复用同一 approve/reject 动作，与对话内审批卡同源）
 */

interface WebBridgeStageProps {
  /** 本轮已结束（settled/stopped/failed）→ 收拢为 chip */
  settled: boolean
  /** chip 上的统计文案，如「调用 3 个工具 · 共 12.4s」 */
  statsText?: string
}

/** 字幕条目：从 store 日志映射为舞台字幕 */
function logToSubtitle(entry: WebBridgeLogEntry): { text: string; kind: '' | 'err' | 'heal' } {
  if (entry.type === 'error') return { text: `✗ ${entry.message}`, kind: 'err' }
  if (entry.type === 'system') {
    // 接管/交还等系统事件用愈合色
    return { text: entry.message, kind: 'heal' }
  }
  if (entry.type === 'action' && entry.action) {
    const a = entry.action
    const desc = a.description || a.action_type
    if (entry.result) {
      return entry.result.success
        ? { text: desc, kind: '' }
        : { text: `✗ ${desc}：${entry.result.error_message || '失败'}`, kind: 'err' }
    }
    return { text: `${desc}…`, kind: '' }
  }
  return { text: entry.message, kind: '' }
}

function normalizeFrame(raw: string | null, mime: 'png' | 'jpeg'): string | null {
  if (!raw) return null
  if (raw.startsWith('data:')) return raw
  return `data:image/${mime};base64,${raw}`
}

export const WebBridgeStage = memo(function WebBridgeStage({ settled, statsText }: WebBridgeStageProps) {
  const {
    status,
    isExecuting,
    currentWorkflowId,
    currentWorkflowStepIndex,
    workflows,
    pageState,
    currentScreenshot,
    currentScreenshotMime,
    logs,
    pauseRequested,
    requestTakeover,
    handbackToAI,
    sendStageInput,
  } = useWebBridgeStore()
  const { pendingApprovals, approveToolCall, rejectToolCall } = useChatStore((s) => ({
    pendingApprovals: s.pendingApprovals,
    approveToolCall: s.approveToolCall,
    rejectToolCall: s.rejectToolCall,
  }))

  // 本轮的 webbridge 审批（与对话内审批卡同源， whichever 先点都生效）
  const wbApproval = useMemo(
    () =>
      pendingApprovals.find(
        (a) => a.status === 'pending' && typeof a.toolName === 'string' && a.toolName.startsWith('webbridge')
      ),
    [pendingApprovals]
  )

  const active =
    !settled && (currentWorkflowId != null || isExecuting || wbApproval != null || pauseRequested)

  // 闩锁：一旦激活过，本轮内保持舞台可见（避免动作间隙 isExecuting 抖动导致闪烁）
  const [latched, setLatched] = useState(false)
  useEffect(() => {
    if (active) setLatched(true)
  }, [active])

  // 实况帧：保留最近两帧做交叉淡入；settled 后冻结最后一帧
  const frame = normalizeFrame(currentScreenshot, currentScreenshotMime)
  const [frames, setFrames] = useState<string[]>([])
  useEffect(() => {
    if (settled) return
    if (!frame) return
    setFrames((prev) => (prev[prev.length - 1] === frame ? prev : [...prev.slice(-1), frame]))
  }, [frame, settled])
  const lastFrame = frames[frames.length - 1] || null

  // 字幕轨：store.logs 新→旧，取最近两条，展示时旧在上
  const subtitles = useMemo(() => logs.slice(0, 2).reverse().map(logToSubtitle), [logs])

  // 进度：当前工作流的步骤进度（原语工具无工作流时不显示）
  const workflow = currentWorkflowId ? workflows.find((w) => w.id === currentWorkflowId) : null
  const totalSteps = workflow?.steps?.length || 0
  const progressPct = totalSteps > 0 ? Math.round(((currentWorkflowStepIndex + 1) / totalSteps) * 100) : 0

  const connClass =
    status !== 'connected' ? 'wait' : isExecuting ? 'work' : 'ok'

  const url = pageState?.url || 'about:blank'
  const pageTitle = pageState?.title || ''

  // 审批出现时把舞台滚动到可视区（蓝图：就近滚动兜底，避免被 composer 遮挡）
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (wbApproval && rootRef.current) {
      const t = setTimeout(() => {
        rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }, 120)
      return () => clearTimeout(t)
    }
    return undefined
  }, [wbApproval])

  // 灯箱（点击 chip / 舞台画面放大最终帧）
  const [lightbox, setLightbox] = useState(false)

  // ── 接管输入：舞台画面坐标 → 浏览器视口坐标 → CDP Input ──
  const viewRef = useRef<HTMLDivElement>(null)
  const [clickFx, setClickFx] = useState<Array<{ id: number; x: number; y: number }>>([])

  /** 显示坐标 → 浏览器视口坐标（pageState 提供真实视口尺寸） */
  const toViewportCoords = (clientX: number, clientY: number) => {
    const view = viewRef.current
    if (!view) return null
    const rect = view.getBoundingClientRect()
    const vw = pageState?.viewport_width || 1280
    const vh = pageState?.viewport_height || 720
    return {
      x: Math.round(((clientX - rect.left) / rect.width) * vw),
      y: Math.round(((clientY - rect.top) / rect.height) * vh),
      relX: clientX - rect.left,
      relY: clientY - rect.top,
    }
  }

  const pulse = (x: number, y: number) => {
    const id = Date.now() + Math.random()
    setClickFx((prev) => [...prev, { id, x, y }])
    setTimeout(() => setClickFx((prev) => prev.filter((f) => f.id !== id)), 600)
  }

  const handleViewClick = (e: React.MouseEvent) => {
    if (!pauseRequested) return
    const c = toViewportCoords(e.clientX, e.clientY)
    if (!c) return
    pulse(c.relX, c.relY)
    sendStageInput({ kind: 'click', x: c.x, y: c.y })
  }

  const handleViewWheel = (e: React.WheelEvent) => {
    if (!pauseRequested) return
    const c = toViewportCoords(e.clientX, e.clientY)
    if (!c) return
    sendStageInput({ kind: 'scroll', x: c.x, y: c.y, deltaY: e.deltaY })
  }

  const handleViewKeyDown = (e: React.KeyboardEvent) => {
    if (!pauseRequested) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // 可打印字符（含中文输入法上屏后的字符）走 insertText
      sendStageInput({ kind: 'text', text: e.key })
    } else {
      sendStageInput({ kind: 'key', key: e.key })
    }
  }

  // 接管时视口自动获得焦点以接收键盘
  useEffect(() => {
    if (pauseRequested) viewRef.current?.focus()
  }, [pauseRequested])

  // ── settled：收拢为 chip ──
  if (settled) {
    if (frames.length === 0 && !latched) return null
    return (
      <>
        <button className="wb-stage-chip" onClick={() => lastFrame && setLightbox(true)}>
          {lastFrame && (
            <span className="wb-stage-chip-mini">
              <img src={lastFrame} alt="最终画面" />
            </span>
          )}
          <span>🌐 浏览器任务完成{statsText ? ` · ${statsText}` : ''}{lastFrame ? ' · 点击查看最终画面' : ''}</span>
        </button>
        {lightbox && lastFrame && (
          <div className="wb-lightbox" onClick={() => setLightbox(false)}>
            <img src={lastFrame} alt="浏览器最终画面" />
            <div className="wb-lightbox-cap">{pageTitle || url}</div>
          </div>
        )}
      </>
    )
  }

  if (!latched) return null

  // ── live：舞台 ──
  return (
    <div ref={rootRef} className={`wb-stage live${pauseRequested ? ' takeover' : ''}`}>
      <div className="wb-stage-box">
        {/* chrome 栏 */}
        <div className="wb-st-chrome">
          <div className="wb-st-lights"><i /><i /><i /></div>
          <div className="wb-st-url" title={url}>
            <span className={`wb-conn ${connClass}`} />
            <span className="wb-st-u">{url}</span>
          </div>
          <button
            className="wb-st-take"
            onClick={() => (pauseRequested ? handbackToAI() : requestTakeover())}
          >
            {pauseRequested ? '▶ 交还 AI' : '⏸ 接管'}
          </button>
        </div>
        {/* 进度条 */}
        <div className="wb-st-progress">
          <i style={{ width: totalSteps > 0 ? `${progressPct}%` : isExecuting ? '100%' : '0%' }} className={totalSteps > 0 ? '' : 'indet'} />
        </div>
        {/* 共驾横幅 */}
        {pauseRequested && (
          <div className="wb-st-banner">
            🖱 共驾中 · AI 已暂停。画面上的点击、滚动、键入都实时作用于浏览器；完成后点「交还 AI」，你的操作会自动告知 AI。
          </div>
        )}
        {/* 视口（接管模式下可点击/滚动/键盘输入，转发真实浏览器） */}
        <div
          ref={viewRef}
          className="wb-st-view"
          tabIndex={pauseRequested ? 0 : -1}
          onClick={handleViewClick}
          onWheel={handleViewWheel}
          onKeyDown={handleViewKeyDown}
        >
          {frames.length === 0 && (
            <div className="wb-st-empty">
              <div className="wb-st-spin" />
              <span>{status === 'connected' ? '正在准备浏览器画面…' : '正在连接浏览器服务…'}</span>
            </div>
          )}
          {frames.map((f, i) => (
            <img
              key={f.slice(-32) + i}
              src={f}
              alt=""
              draggable={false}
              className={`wb-st-frame${i === frames.length - 1 ? ' on' : ''}`}
            />
          ))}
          {/* 用户点击脉冲 */}
          {clickFx.map((f) => (
            <div key={f.id} className="wb-click-fx" style={{ left: f.x, top: f.y }} />
          ))}
          {/* 字幕轨（保留最近两条，旧的淡出） */}
          <div className="wb-st-subs">
            {subtitles.map((s, i) => (
              <div key={`${i}-${s.text.slice(0, 24)}`} className={`wb-sub${s.kind ? ' ' + s.kind : ''}${i < subtitles.length - 1 ? ' old' : ''}`}>
                {s.text}
              </div>
            ))}
          </div>
          {/* 就地审批浮层 */}
          {wbApproval && (
            <div className="wb-st-approve on">
              <div className="wb-ap-card">
                <div className="wb-ap-title">✋ AI 想要执行浏览器交互操作</div>
                <div className="wb-ap-desc">
                  {wbApproval.impactStatement || wbApproval.reason || '该任务可能包含点击、输入等交互操作，需要人工确认。'}
                </div>
                <div className="wb-ap-btns">
                  <button className="wb-ap-allow" onClick={() => approveToolCall(wbApproval.toolCallId)}>
                    允许
                  </button>
                  <button className="wb-ap-deny" onClick={() => rejectToolCall(wbApproval.toolCallId)}>
                    拒绝
                  </button>
                  <span className="wb-ap-hint">只读操作无需审批 · 交互操作需确认</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

import type { TurnStats } from '@/types/chat'

interface FlowSummaryLineProps {
  /** 内核投影统计（唯一事实源，由 WaterfallTurn 从 ChatMessage.turnStats 读取传入） */
  stats?: TurnStats
  /** turn 是否已闭幕 */
  settled: boolean
  /** turn 是否正在 settling 过渡（交叉淡出阶段） */
  settling: boolean
  /** 是否展开过程区 */
  processVisible: boolean
  onToggleProcess: () => void
  /** turn 终态 */
  endState?: 'settled' | 'stopped' | 'failed'
}

function fmtSecs(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const min = Math.floor(ms / 60000)
  const sec = Math.round((ms % 60000) / 1000)
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`
}

/**
 * 过程摘要行（所有阶段常驻，可点击展开/折叠过程区）。
 *
 * 阶段行为：
 * - active：显示实时 stats，chevron 可点击展开/折叠过程区
 * - settling：淡入显示（CSS 动画），过渡期间仍可点击
 * - settled：常驻显示，可点击回顾过程
 * - stopped / failed：立即显示 + 终态 flag chip
 *
 * stats 全部来自内核投影，组件不自己算。
 */
export function FlowSummaryLine({
  stats,
  settled,
  settling,
  processVisible,
  onToggleProcess,
  endState,
}: FlowSummaryLineProps) {
  const isEnded = settled || endState === 'stopped' || endState === 'failed'

  const s = stats

  // 统计文本（全部从 stats 派生）
  const parts: string[] = []
  if (s) {
    if (s.thinkingCount > 0 && s.thinkingMs > 0) parts.push(`思考 ${fmtSecs(s.thinkingMs)}`)
    if (s.toolCount > 0) parts.push(`调用 ${s.toolCount} 个工具`)
    if (s.cancelledCount > 0) parts.push(`${s.cancelledCount} 个已取消`)
    if (s.artifactCount > 0) parts.push(`出 ${s.artifactCount} 个产物`)
    if (s.totalMs > 0) parts.push(`共 ${fmtSecs(s.totalMs)}`)
  }

  // Flag chip（仅终态显示）
  let flagHtml = ''
  if (endState === 'stopped') {
    flagHtml = '<span class="wf-settle-flag warn"><span class="wf-settle-fd"></span>已手动停止</span>'
  } else if (endState === 'failed') {
    flagHtml = '<span class="wf-settle-flag err"><span class="wf-settle-fd"></span>中途失败</span>'
  } else if (isEnded && s && s.errorCount > 0) {
    flagHtml = `<span class="wf-settle-flag err"><span class="wf-settle-fd"></span>${s.errorCount} 处失败</span>`
  }

  const statsText = parts.length > 0 ? parts.join(' · ') : ''

  // 无任何信息时不渲染空行
  if (!statsText && !flagHtml) return null

  return (
    <button
      className="wf-settle-line"
      onClick={onToggleProcess}
      aria-expanded={processVisible}
    >
      <span className="wf-settle-chev">{processVisible ? '▼' : '▶'}</span>
      <span
        dangerouslySetInnerHTML={{
          __html: `${statsText}${statsText && flagHtml ? ' ' : ''}${flagHtml}`,
        }}
      />
    </button>
  )
}

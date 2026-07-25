import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chatStore'

type Phase = 'hidden' | 'running' | 'done' | 'leaving'

/**
 * 压缩进度条（v9.2）：手动 /compact 与 autoCompact 共用。
 * 挂在 composer 上方（与 tray/ribbon 同一视觉层级），淡雅、不抢焦点：
 * - running：细轨道微光流动 + 状态文案 + 已用时长；手动压缩可 ✕ 取消
 * - done：短暂停留「✓ 已压缩」让用户感知闭环，随后淡出卸载
 */
export function CompactBar() {
  const compactProgress = useChatStore((s) => s.compactProgress)
  const cancelCompact = useChatStore((s) => s.cancelCompact)
  const [phase, setPhase] = useState<Phase>('hidden')
  const [elapsed, setElapsed] = useState(0)
  const lastTrigger = useRef<'manual' | 'auto'>('manual')

  const active = compactProgress !== null
  if (compactProgress) lastTrigger.current = compactProgress.trigger

  useEffect(() => {
    if (active) {
      setPhase('running')
      setElapsed(0)
      return
    }
    // running → done → leaving → hidden（仅当之前在跑才播完成态）
    setPhase((p) => {
      if (p !== 'running') return p
      return 'done'
    })
  }, [active])

  useEffect(() => {
    if (phase !== 'running') return
    const timer = setInterval(() => setElapsed((e) => e + 0.5), 500)
    return () => clearInterval(timer)
  }, [phase])

  useEffect(() => {
    if (phase === 'done') {
      const t = setTimeout(() => setPhase('leaving'), 1100)
      return () => clearTimeout(t)
    }
    if (phase === 'leaving') {
      const t = setTimeout(() => setPhase('hidden'), 450)
      return () => clearTimeout(t)
    }
  }, [phase])

  if (phase === 'hidden') return null

  const trigger = active ? compactProgress!.trigger : lastTrigger.current
  const label =
    phase === 'running'
      ? trigger === 'auto'
        ? '上下文接近上限，正在自动压缩…'
        : '正在压缩上下文…'
      : trigger === 'auto'
        ? '✓ 已自动压缩，对话继续'
        : '✓ 已压缩'

  return (
    <div className={`wf-compact-bar${phase === 'leaving' ? ' leaving' : ''}`} role="status">
      <span className="cb-label">{label}</span>
      {phase === 'running' ? (
        <>
          <span className="cb-track">
            <span className="cb-glow" />
          </span>
          <span className="cb-elapsed">{elapsed.toFixed(0)}s</span>
          {trigger === 'manual' && (
            <button type="button" className="cb-cancel" onClick={cancelCompact} title="取消压缩">
              ✕
            </button>
          )}
        </>
      ) : (
        <span className="cb-track">
          <span className="cb-fill" />
        </span>
      )}
    </div>
  )
}

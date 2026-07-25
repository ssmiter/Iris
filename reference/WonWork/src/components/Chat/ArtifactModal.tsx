import { useEffect, useCallback } from 'react'
import { InlineTable, extractTableRows } from './InlineTable'
import type { ArtifactNode } from '@/types/chat'

interface ArtifactModalProps {
  artifact: ArtifactNode | null
  onClose: () => void
}

/**
 * 产物全屏浮层。
 * 按 Esc 或点击关闭/遮罩关闭。
 */
export function ArtifactModal({ artifact, onClose }: ArtifactModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    if (artifact) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [artifact, handleKeyDown])

  if (!artifact) return null

  const payload = artifact.payload
  const rows = extractTableRows(payload)

  // 解析柱状图数据
  interface BarItem { label: string; val: number; disp?: string; color?: string }
  let bars: BarItem[] | null = null
  if (!rows && payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (Array.isArray(obj.bars) && obj.bars.length > 0) {
      bars = obj.bars as unknown as BarItem[]
    }
  }

  return (
    <div
      className="wf-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={artifact.title}
    >
      <div className="wf-modal">
        <div className="wf-modal-bar">
          <span>{artifact.title}</span>
          <button className="wf-btn" onClick={onClose}>
            关闭 Esc
          </button>
        </div>
        <div className="wf-modal-body">
          {rows ? (
            <InlineTable rows={rows} maxRows={50} maxColumns={12} />
          ) : bars ? (
            <div className="wf-chart-bars">
              {bars.map((b, i) => {
                const max = Math.max(...bars!.map((x) => x.val), 1)
                return (
                  <div key={i} className="wf-chart-col">
                    <span className="wf-chart-val">{b.disp || b.val}</span>
                    <div
                      className="wf-chart-bar"
                      style={{
                        height: `${(b.val / max) * 180}px`,
                        background: b.color || '#2563eb',
                      }}
                    />
                    <span className="wf-chart-x">{b.label}</span>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-sm text-surface-600 font-mono whitespace-pre-wrap">
              {JSON.stringify(payload, null, 2).slice(0, 2000)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * RecentStrip — 底部产物胶片条（坞内底部）
 *
 * 横向滚动显示当前对话所有已注册产物的小缩略卡片。
 * 点击切换 currentArtifactId。
 */

import { memo, useCallback } from 'react'
import { useArtifactDockStore } from '@/stores/artifactDockStore'

/** mini 柱状图缩略（tiny 尺寸，34px 高） */
function TinyChart({ bars, accent }: { bars: [string, number][]; accent: string }) {
  const max = Math.max(...bars.map((b) => b[1]))
  return (
    <div className="wf-mini-chart" style={{ height: 34, color: accent }}>
      {bars.slice(0, 6).map((bar, i) => {
        const h = max > 0 ? Math.round((bar[1] / max) * 34) : 4
        return <i key={i} style={{ height: `${Math.max(h, 3)}px`, width: 7 }} />
      })}
    </div>
  )
}

function RecentThumb({ artifactId }: { artifactId: string }) {
  const artifact = useArtifactDockStore((s) => s.artifacts[artifactId])
  if (!artifact) return null

  if (artifact.kind === 'chart' && artifact.chartData?.bars) {
    return <TinyChart bars={artifact.chartData.bars} accent={artifact.accent} />
  }
  const emoji =
    artifact.kind === 'table' ? '📊' :
    artifact.kind === 'doc' ? '📝' :
    artifact.kind === 'image' ? '🖼' : '📄'
  return <span style={{ fontSize: 19 }}>{emoji}</span>
}

export const RecentStrip = memo(function RecentStrip() {
  const artifactOrder = useArtifactDockStore((s) => s.artifactOrder)
  const currentId = useArtifactDockStore((s) => s.currentArtifactId)
  const setCurrent = useArtifactDockStore((s) => s.setCurrent)
  const setTab = useArtifactDockStore((s) => s.setTab)
  const artifacts = useArtifactDockStore((s) => s.artifacts)

  const handleClick = useCallback(
    (id: string) => {
      setCurrent(id)
      setTab('preview')
    },
    [setCurrent, setTab],
  )

  if (artifactOrder.length === 0) return null

  return (
    <div className="wf-dock-recent">
      <div className="wf-recent-title">本次对话的产物</div>
      <div className="wf-recent-strip">
        {artifactOrder.map((id) => {
          const a = artifacts[id]
          if (!a) return null
          return (
            <div
              key={id}
              className={`wf-recent-item${currentId === id ? ' active' : ''}`}
              onClick={() => handleClick(id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') handleClick(id)
              }}
            >
              <div className="wf-recent-thumb" style={{ color: a.accent }}>
                <RecentThumb artifactId={id} />
              </div>
              <div className="wf-recent-cap">{a.caption || a.fileName}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
})

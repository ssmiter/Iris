/**
 * ArtifactDock — 预览坞容器
 *
 * 右侧固定悬浮面板（z-70，在 RightPanel z-50 之上）。
 * - 头部：预览 / 工作区 tab + 关闭按钮
 * - 主体：PreviewPane 或 FilesPane
 * - 底部：RecentStrip（产物胶片条）
 *
 * 关闭方式：头部 ✕ 按钮 / Esc 键
 */

import { memo, useEffect, useCallback } from 'react'
import { useArtifactDockStore } from '@/stores/artifactDockStore'
import { PreviewPane } from './PreviewPane'
import { FilesPane } from './FilesPane'
import { RecentStrip } from './RecentStrip'

export const ArtifactDock = memo(function ArtifactDock() {
  const isOpen = useArtifactDockStore((s) => s.isOpen)
  const activeTab = useArtifactDockStore((s) => s.activeTab)
  const currentArtifactId = useArtifactDockStore((s) => s.currentArtifactId)
  const currentArtifact = useArtifactDockStore((s) =>
    s.currentArtifactId ? s.artifacts[s.currentArtifactId] : undefined,
  )
  const close = useArtifactDockStore((s) => s.close)
  const setTab = useArtifactDockStore((s) => s.setTab)

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, close])

  // body class 切换（用于宽屏适配）
  useEffect(() => {
    if (isOpen) {
      document.body.classList.add('wf-dock-open')
    } else {
      document.body.classList.remove('wf-dock-open')
    }
    return () => document.body.classList.remove('wf-dock-open')
  }, [isOpen])

  const handleTabClick = useCallback(
    (tab: 'preview' | 'files') => {
      setTab(tab)
    },
    [setTab],
  )

  return (
    <aside className={`wf-dock${isOpen ? ' open' : ''}`} aria-label="预览坞">
      {/* Head */}
      <div className="wf-dock-head">
        <div className="wf-dock-tabs">
          <button
            className={`wf-dock-tab${activeTab === 'preview' ? ' active' : ''}`}
            onClick={() => handleTabClick('preview')}
          >
            预览
          </button>
          <button
            className={`wf-dock-tab${activeTab === 'files' ? ' active' : ''}`}
            onClick={() => handleTabClick('files')}
          >
            工作区
          </button>
        </div>
        <button
          className="wf-dock-close"
          onClick={close}
          title="关闭（Esc）"
          aria-label="关闭预览坞"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="wf-dock-body">
        <div className={`wf-dock-pane${activeTab !== 'preview' ? ' hidden' : ''}`}>
          {currentArtifact ? (
            <PreviewPane artifact={currentArtifact} />
          ) : (
            <div className="wf-dock-empty">
              暂无预览内容
              <br />
              <span className="wf-dock-empty-hint">点击正文中的文件卡片开始预览</span>
            </div>
          )}
        </div>
        <div className={`wf-dock-pane${activeTab !== 'files' ? ' hidden' : ''}`}>
          <FilesPane locateArtifactId={currentArtifactId} />
        </div>
      </div>

      {/* Recent strip */}
      <RecentStrip />
    </aside>
  )
})

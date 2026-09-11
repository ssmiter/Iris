import { memo, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMemoryDockStore } from '@/stores/memoryDockStore'
import { InkStreamView } from './InkStreamView'
import { InkTreeView } from './InkTreeView'

/**
 * 记忆覆层：对话之上的一层覆盖。打开时对话雾化退后，记忆独占整屏——
 * 记忆跨会话、与对话平级，看记忆时就在记忆里，不与对话争夺同一视野。
 * 带 focusId 打开时进入聚焦态：其余条目淡出，目标高亮并滚到中央；
 * 聚焦态下首次点击空白只解除聚焦，再次点击才退出。
 * （2026-08-13 重构：视觉全面对齐 wf 体系——头部/页签/关闭与登录页、设置页同语言）
 */
export const MemoryDock = memo(function MemoryDock() {
  const { t } = useTranslation()
  const isOpen = useMemoryDockStore((s) => s.isOpen)
  const activeView = useMemoryDockStore((s) => s.activeView)
  const focusId = useMemoryDockStore((s) => s.focusId)
  const close = useMemoryDockStore((s) => s.close)
  const setView = useMemoryDockStore((s) => s.setView)
  const [settled, setSettled] = useState(false)
  const [focused, setFocused] = useState(false)

  // Ctrl/Cmd+M 全局唤起/收起：入口不再只在右上角（与输入法/对话框键位无冲突）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        useMemoryDockStore.getState().toggle()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // 入场编排结束后清掉错峰延迟，避免影响 hover 反馈
  useEffect(() => {
    if (!isOpen) {
      setSettled(false)
      return
    }
    const timer = window.setTimeout(() => setSettled(true), 1100)
    return () => window.clearTimeout(timer)
  }, [isOpen])

  // 聚焦态：打开时携带 focusId → 目标滚到视野中央
  useEffect(() => {
    if (!isOpen || !focusId) {
      setFocused(false)
      return
    }
    setFocused(true)
    const timer = window.setTimeout(() => {
      document
        .querySelector(`[data-mem-id="${CSS.escape(focusId)}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 420)
    return () => window.clearTimeout(timer)
  }, [isOpen, focusId])

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, close])

  const onBlankClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return
    if (focused) {
      // 聚焦态第一次点空白：只解除聚焦，不退出
      setFocused(false)
      useMemoryDockStore.setState({ focusId: null })
      return
    }
    close()
  }

  return (
    <div
      className={`wf-memveil${isOpen ? ' open' : ''}${settled ? ' settled' : ''}${focused ? ' focus' : ''}`}
      aria-hidden={!isOpen}
      onClick={onBlankClick}
    >
      <div className="wf-mem-col" onClick={onBlankClick}>
        <div className="wf-mem-head">
          <span className="wf-mem-title">{t('memory.dock.title')}</span>
          <div className="wf-mem-tabs">
            <button
              className={`wf-mem-tab${activeView === 'stream' ? ' active' : ''}`}
              onClick={() => setView('stream')}
            >
              {t('memory.dock.stream')}
            </button>
            <button
              className={`wf-mem-tab${activeView === 'tree' ? ' active' : ''}`}
              onClick={() => setView('tree')}
            >
              {t('memory.dock.tree')}
            </button>
          </div>
          <button className="wf-mem-close" onClick={close} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        {isOpen && (activeView === 'stream' ? <InkStreamView /> : <InkTreeView />)}
      </div>
    </div>
  )
})

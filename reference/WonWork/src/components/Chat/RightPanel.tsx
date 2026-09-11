import { useContextPanelStore } from '@/stores/contextPanelStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useConversationStore } from '@/stores/conversationStore'
import { useBoardStore } from '@/stores/boardStore'
import { useArtifactDockStore } from '@/stores/artifactDockStore'
import { BoardPanel } from './BoardPanel'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X, ClipboardList } from 'lucide-react'

const MIN_WIDTH = 240
const MAX_WIDTH = 600
const DEFAULT_WIDTH = 348

export function RightPanel() {
  const { isOpen, setOpen } = useContextPanelStore()
  const rightPanelEdgeHover = useSettingsStore((s) => s.rightPanelEdgeHover)
  const { t } = useTranslation()
  const [width, setWidth] = useState(DEFAULT_WIDTH)

  // 黑板数据：当前会话（无会话按空板处理）
  const convIdNum = useConversationStore((s) => s.currentConversationId)
  const convId = convIdNum == null ? '' : String(convIdNum)
  const board = useBoardStore((s) => (convId ? s.byConv[convId] : undefined))
  const prodCount = useArtifactDockStore((s) => s.artifactOrder.length)

  const openTodos = board?.todos.filter((td) => td.status !== 'completed').length ?? 0
  const hasBoardContent = Boolean(
    board?.goal || (board?.facts.length ?? 0) > 0 || (board?.todos.length ?? 0) > 0 || prodCount > 0
  )

  const panelRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startW.current = width
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [width])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const dx = startX.current - e.clientX
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW.current + dx))
      setWidth(next)
    }
    const onUp = () => {
      if (dragging.current) {
        dragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 右缘悬停只浮现入口（芽），点击才展开（2026-08-14 拍板）：
  // 原 10px 热区 DOM 悬停即开面板——它恰好盖住聊天滚动条，
  // 拖到右缘想滑对话记录反而弹出面板，拖/滚两条路全被截。
  // 改为 mousemove 坐标探测（无 DOM 覆盖，滚动条全程可拖可滚）：
  // 近缘 16px 内浮现；离开 120px 后延迟 900ms 才收回（2026-08-18 用户反馈
  // 「芽可以稳定些，多停留一会儿」——宽缓冲区+延时收回，移去够按钮的路上不闪没）。
  const [edgePeek, setEdgePeek] = useState(false)
  useEffect(() => {
    if (!rightPanelEdgeHover || isOpen) {
      setEdgePeek(false)
      return
    }
    let hideTimer: number | null = null
    const cancelHide = () => {
      if (hideTimer != null) { window.clearTimeout(hideTimer); hideTimer = null }
    }
    const onMove = (e: MouseEvent) => {
      const d = window.innerWidth - e.clientX
      if (d <= 16) {
        cancelHide()
        setEdgePeek(true)
      } else if (d > 120) {
        cancelHide()
        hideTimer = window.setTimeout(() => setEdgePeek(false), 900)
      }
      // 16–120px 缓冲区：保持现状（迟滞）
    }
    window.addEventListener('mousemove', onMove)
    return () => { cancelHide(); window.removeEventListener('mousemove', onMove) }
  }, [rightPanelEdgeHover, isOpen])

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, setOpen])

  // 点击面板外任意处关闭（点面板内不关）
  useEffect(() => {
    if (!isOpen) return
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [isOpen, setOpen])

  // 右缘芽：黑板有内容（目标/已确认/待办任一非空或产物非空）常显；无内容时近缘悬停浮现
  const showBud = !isOpen && (hasBoardContent || edgePeek)

  return (
    <>
      {/* 右缘芽：点击才展开面板（悬停只负责让它浮现，不再自动展开） */}
      {showBud && (
        <button className="wf-bud" onClick={() => setOpen(true)}>
          <ClipboardList size={14} />
          <span className="n">
            {t('chat.board.title')}
            {openTodos > 0 ? ` · ${openTodos}` : ''}
          </span>
        </button>
      )}
      {/* 浮动进展面板 */}
      <div ref={panelRef} className={`wf-panel ${isOpen ? 'show' : ''}`} style={{ width }}>
        {/* 拖拽调宽手柄（左边缘） */}
        <div className="wf-panel-resize" onMouseDown={onMouseDown} />
        <div className="insp-h">
          <ClipboardList size={14} className="insp-h-ic" />
          <span className="insp-title">{t('chat.board.title')}</span>
          {openTodos > 0 && <span className="insp-cnt">{openTodos}</span>}
          <button className="insp-x" onClick={() => setOpen(false)} title={t('chat.rightPanel.close')}>
            <X size={13} />
          </button>
        </div>
        <div className="insp-body scrollbar-thin">
          <BoardPanel />
        </div>
      </div>
    </>
  )
}

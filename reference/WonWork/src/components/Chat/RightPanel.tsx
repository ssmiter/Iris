import { useContextPanelStore } from '@/stores/contextPanelStore'
import { TaskProgressList } from './TaskProgressList'
import { ContextFilesPanel } from './ContextFilesPanel'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel'
import { useState, useCallback, useEffect, useRef } from 'react'

const MIN_WIDTH = 240
const MAX_WIDTH = 600
const DEFAULT_WIDTH = 320

export function RightPanel() {
  const { isOpen, setOpen } = useContextPanelStore()
  const close = () => setOpen(false)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
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

  return (
    <>
      {/* Backdrop */}
      <div
        className={`wf-panel-backdrop ${isOpen ? 'show' : ''}`}
        onClick={close}
        aria-hidden="true"
      />
      {/* Floating Panel */}
      <div
        className={`wf-panel ${isOpen ? 'show' : ''}`}
        style={{ width }}
      >
        {/* Resize handle (left edge) */}
        <div className="wf-panel-resize" onMouseDown={onMouseDown} />
        <div className="flex-[60] flex flex-col min-h-0 border-b border-[#ececee]">
          <TaskProgressList />
        </div>
        <div className="flex-[20] flex flex-col min-h-0 border-b border-[#ececee]">
          <ContextFilesPanel />
        </div>
        <div className="flex-[40] flex flex-col min-h-0">
          <WorkspaceFilesPanel />
        </div>
      </div>
    </>
  )
}

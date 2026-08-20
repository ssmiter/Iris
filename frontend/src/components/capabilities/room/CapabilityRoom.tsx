import { useEffect, useRef, useState } from 'react'
import { useViewStateStore } from '@/stores/viewStateStore'
import { pushEscLayer } from '@/lib/escLayerStack'
import { cn } from '@/lib/cn'
import { CapabilityExplorer } from './CapabilityExplorer'
import { McpConsole } from '../McpConsole'
import { MemoryConsole } from '../MemoryConsole'
import { ScheduleConsole } from '../ScheduleConsole'

type RoomView = 'tree' | 'mcp' | 'memory' | 'schedule'

/** 覆盖式能力房（docs/37 §1）：居中收敛大窗 + 下层对话压暗遮罩。 */
export function CapabilityRoom() {
  const open = useViewStateStore((state) => state.capabilityRoomOpen)
  const setOpen = useViewStateStore((state) => state.setCapabilityRoomOpen)
  const [visible, setVisible] = useState(false)
  const [view, setView] = useState<RoomView>('tree')
  const [focusServerId, setFocusServerId] = useState<string | null>(null)
  const consumeEscRef = useRef<() => boolean>(() => false)

  // 开房时淡入；关房时立即卸载由 open 控制。
  useEffect(() => {
    if (!open) return
    const tick = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(tick)
  }, [open])

  const closeOrBack = () => {
    if (view !== 'tree') {
      setView('tree')
      setFocusServerId(null)
    } else {
      setOpen(false)
    }
  }

  // Esc 逐层退出：先问 Explorer 是否消费（详情/选择），不消费再回树/关房。
  useEffect(() => {
    if (!open) return
    return pushEscLayer({
      id: 'capability-room',
      close: () => {
        if (!consumeEscRef.current()) {
          closeOrBack()
        }
      },
    })
  }, [open, view])

  if (!open) return null

  const openMcp = (serverId?: string) => {
    setFocusServerId(serverId ?? null)
    setView('mcp')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="能力"
    >
      <div
        className={cn(
          'absolute inset-0 bg-canvas/50 transition-opacity duration-fast ease-standard motion-reduce:transition-none',
          visible ? 'opacity-100' : 'opacity-0',
        )}
        onMouseDown={closeOrBack}
      />
      <div
        className="relative flex w-full items-center justify-center p-4"
        onMouseDown={closeOrBack}
      >
        <div
          className={cn(
            'pointer-events-auto flex w-[min(1120px,92vw)] flex-col overflow-hidden rounded-2xl border border-border bg-surface-raised shadow-floating',
            'h-[min(760px,82vh)]',
            'transition-opacity duration-fast ease-standard motion-reduce:transition-none',
            visible ? 'opacity-100' : 'opacity-0',
          )}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {view === 'mcp' ? (
            <McpConsole
              focusServerId={focusServerId}
              onBack={() => {
                setView('tree')
                setFocusServerId(null)
              }}
            />
          ) : view === 'memory' ? (
            <MemoryConsole onBack={() => setView('tree')} />
          ) : view === 'schedule' ? (
            <ScheduleConsole onBack={() => setView('tree')} />
          ) : (
            <CapabilityExplorer
              consumeEscRef={consumeEscRef}
              onOpenMcp={openMcp}
              onOpenMemory={() => setView('memory')}
              onOpenSchedule={() => setView('schedule')}
              onClose={closeOrBack}
            />
          )}
        </div>
      </div>
    </div>
  )
}

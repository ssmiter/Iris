import { useEffect, useRef, useState } from 'react'
import { useViewStateStore } from '@/stores/viewStateStore'
import { pushEscLayer } from '@/lib/escLayerStack'
import { RoomShell } from '@/components/room'
import { CapabilityExplorer } from './CapabilityExplorer'
import { McpConsole } from '../McpConsole'
import { MemoryConsole } from '../MemoryConsole'
import { ScheduleConsole } from '../ScheduleConsole'

type RoomView = 'tree' | 'mcp' | 'memory' | 'schedule'

/**
 * 全屏覆盖式能力房（docs/39 §1 全屏裁决，取代 docs/37 的居中大窗）：
 * fixed inset-0、bg-canvas 不透明、无圆角无遮罩，房间即应用；
 * 下层对话只遮不卸（SSE/滚动/流式状态原位保留），Esc / ← 返回等价回家。
 */
export function CapabilityRoom() {
  const open = useViewStateStore((state) => state.capabilityRoomOpen)
  const setOpen = useViewStateStore((state) => state.setCapabilityRoomOpen)
  const [visible, setVisible] = useState(false)
  const [view, setView] = useState<RoomView>('tree')
  const [focusServerId, setFocusServerId] = useState<string | null>(null)
  const consumeEscRef = useRef<() => boolean>(() => false)

  // 开房时淡入；关房复位 visible（二次开房才能再次淡入）；关房卸载由 open 控制。
  useEffect(() => {
    if (!open) {
      setVisible(false)
      return
    }
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

  // Esc 逐层退出：先问 Explorer 是否消费（浮层/详情/搜索/选择），不消费再回树/关房。
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
    <RoomShell label="能力" visible={visible}>
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
    </RoomShell>
  )
}

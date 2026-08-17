import { useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button, Modal } from '@/components/ui'
import { CapabilityTreeView } from './CapabilityTreeView'
import { McpConsole } from './McpConsole'
import { MemoryConsole } from './MemoryConsole'
import { ScheduleConsole } from './ScheduleConsole'

type View = 'tree' | 'mcp' | 'memory' | 'schedule'

/**
 * 统一能力管理页（docs/32 §5）：能力目录树是脊柱，kind 是切面；
 * MCP 连接器与记忆是 DB 真相的子视图，不再是顶层分页。
 */
export function CapabilityCenter() {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('tree')
  const [focusServerId, setFocusServerId] = useState<string | null>(null)

  const openMcp = (serverId?: string) => {
    setFocusServerId(serverId ?? null)
    setView('mcp')
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setView('tree')
          setFocusServerId(null)
        }
      }}
      size="xl"
      title="能力"
      description="能力树上的全部可寻址对象：内核工具、过程插件、技能、知识文档与 MCP 远端工具；种类是切面，目录是脊柱。"
      trigger={
        <Button variant="ghost" size="icon" aria-label="管理能力">
          <Settings2 aria-hidden="true" className="h-4 w-4" />
        </Button>
      }
    >
      {view === 'mcp' ? (
        <McpConsole
          focusServerId={focusServerId}
          onBack={() => setView('tree')}
        />
      ) : view === 'memory' ? (
        <MemoryConsole onBack={() => setView('tree')} />
      ) : view === 'schedule' ? (
        <ScheduleConsole onBack={() => setView('tree')} />
      ) : (
        <CapabilityTreeView
          onOpenMcp={openMcp}
          onOpenMemory={() => setView('memory')}
          onOpenSchedule={() => setView('schedule')}
        />
      )}
    </Modal>
  )
}

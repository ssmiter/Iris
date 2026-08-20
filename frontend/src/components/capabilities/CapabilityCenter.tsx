import { useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button, Modal } from '@/components/ui'
import { CapabilityTreeView } from './CapabilityTreeView'
import { McpConsole } from './McpConsole'
import { MemoryConsole } from './MemoryConsole'
import { ScheduleConsole } from './ScheduleConsole'

type View = 'tree' | 'mcp' | 'memory' | 'schedule'

/** A16：Modal 说明随子视图换一句子视图说明。 */
const VIEW_DESCRIPTION: Record<View, string> = {
  tree: '按目录管理全部可调用的能力。',
  mcp: '管理远端工具连接。',
  memory: '管理长期记忆。',
  schedule: '管理定时任务。',
}

/** B8：子视图返回树视图后要恢复焦点的入口按钮 key。 */
const VIEW_ENTRY_KEY: Record<Exclude<View, 'tree'>, string> = {
  mcp: 'entry-mcp',
  memory: 'entry-memory',
  schedule: 'entry-schedule',
}

/**
 * 统一能力管理页（docs/32 §5）：能力目录树是脊柱，kind 是切面；
 * MCP 连接器与记忆是 DB 真相的子视图，不再是顶层分页。
 */
export function CapabilityCenter() {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('tree')
  const [focusServerId, setFocusServerId] = useState<string | null>(null)
  const [treeFocusKey, setTreeFocusKey] = useState<string | null>(null)

  const openMcp = (serverId?: string) => {
    setFocusServerId(serverId ?? null)
    setView('mcp')
  }

  const backToTree = (from: Exclude<View, 'tree'>) => {
    setTreeFocusKey(VIEW_ENTRY_KEY[from])
    setView('tree')
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setView('tree')
          setFocusServerId(null)
          setTreeFocusKey(null)
        }
      }}
      size="xl"
      title="能力"
      description={VIEW_DESCRIPTION[view]}
      bodyScroll={false}
      trigger={
        <Button variant="ghost" size="icon" aria-label="管理能力">
          <Settings2 aria-hidden="true" className="h-4 w-4" />
        </Button>
      }
    >
      {view === 'mcp' ? (
        <McpConsole
          focusServerId={focusServerId}
          onBack={() => backToTree('mcp')}
        />
      ) : view === 'memory' ? (
        <MemoryConsole onBack={() => backToTree('memory')} />
      ) : view === 'schedule' ? (
        <ScheduleConsole onBack={() => backToTree('schedule')} />
      ) : (
        <CapabilityTreeView
          onOpenMcp={openMcp}
          onOpenMemory={() => setView('memory')}
          onOpenSchedule={() => setView('schedule')}
          initialFocusKey={treeFocusKey}
          onInitialFocusDone={() => setTreeFocusKey(null)}
        />
      )}
    </Modal>
  )
}

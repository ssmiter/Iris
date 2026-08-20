import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { useViewStateStore } from '@/stores/viewStateStore'

/**
 * 能力中心入口按钮（docs/37 §1）：打开覆盖式能力房。
 * 房间壳本身由 ConversationApp 在对话层之上挂载，以保证对话不卸载。
 */
export function CapabilityCenter() {
  const setOpen = useViewStateStore((state) => state.setCapabilityRoomOpen)
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="管理能力"
      onClick={() => setOpen(true)}
    >
      <Settings2 aria-hidden="true" className="h-4 w-4" />
    </Button>
  )
}

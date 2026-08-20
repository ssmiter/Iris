import {
  type ConversationWidth,
  useViewStateStore,
} from '@/stores/viewStateStore'
import { Tooltip } from '@/components/ui/Tooltip'

const WIDTH_OPTIONS: ConversationWidth[] = [640, 760, 920]

/**
 * 列宽入口收成单枚 caption 钮：数字即档位，点击循环 640 → 760 → 920。
 * 迁移到 header / TurnRail 会碰 composer 区外的文件，且 TurnRail 在
 * 短对话（<8 轮）不渲染——循环钮是收纳而非删除的最克制形态。
 */
export function ConversationWidthToggle() {
  const width = useViewStateStore((state) => state.conversationWidth)
  const setWidth = useViewStateStore((state) => state.setConversationWidth)

  const cycle = () => {
    const nextIndex =
      (WIDTH_OPTIONS.indexOf(width) + 1) % WIDTH_OPTIONS.length
    setWidth(WIDTH_OPTIONS[nextIndex])
  }

  return (
    <Tooltip content={`对话列宽 ${width}px · 点击在 640 / 760 / 920 间循环`}>
      <button
        type="button"
        className="inline-flex h-8 items-center rounded-xs px-1.5 font-mono text-caption tabular-nums text-ink-muted hover:bg-surface-muted hover:text-ink-subtle focus-visible:outline-none focus-visible:shadow-focus"
        aria-label={`对话列宽 ${width}px，点击切换`}
        onClick={cycle}
      >
        {width}
      </button>
    </Tooltip>
  )
}

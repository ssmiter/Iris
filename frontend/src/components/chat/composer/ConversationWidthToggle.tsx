import { Button } from '@/components/ui'
import {
  type ConversationWidth,
  useViewStateStore,
} from '@/stores/viewStateStore'

const WIDTH_OPTIONS: ConversationWidth[] = [640, 760, 920]

export function ConversationWidthToggle() {
  const width = useViewStateStore((state) => state.conversationWidth)
  const setWidth = useViewStateStore((state) => state.setConversationWidth)

  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-surface-raised/50 p-0.5"
      role="group"
      aria-label="切换对话列宽"
    >
      {WIDTH_OPTIONS.map((option) => {
        const active = width === option
        return (
          <Button
            key={option}
            variant={active ? 'secondary' : 'ghost'}
            size="sm"
            className="h-6 px-1.5 font-mono text-caption tabular-nums"
            aria-pressed={active}
            title={`列宽 ${option}px`}
            onClick={() => setWidth(option)}
          >
            {option}
          </Button>
        )
      })}
    </span>
  )
}

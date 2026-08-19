import { Button } from '@/components/ui'
import {
  type ConversationWidth,
  useViewStateStore,
} from '@/stores/viewStateStore'

const WIDTH_OPTIONS: { value: ConversationWidth; label: string; title: string }[] = [
  { value: 'wide', label: '宽', title: '列宽：宽（820px）' },
  { value: 'narrow', label: '窄', title: '列宽：窄（680px）' },
]

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
        const active = width === option.value
        return (
          <Button
            key={option.value}
            variant={active ? 'secondary' : 'ghost'}
            size="sm"
            className="h-6 px-1.5 font-mono text-caption"
            aria-pressed={active}
            title={option.title}
            onClick={() => setWidth(option.value)}
          >
            {option.label}
          </Button>
        )
      })}
    </span>
  )
}

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@/stores/chatStore'
import { cn } from '@/utils'

export function ContextCapacityBar() {
  const { t } = useTranslation()
  const currentContextTokens = useChatStore((s) => s.currentContextTokens)
  const contextWindowSize = useChatStore((s) => s.contextWindowSize)
  const contextWindowSource = useChatStore((s) => s.contextWindowSource)

  const { percentage, color, used, total } = useMemo(() => {
    // 与 InputArea hintbar 同一规则：大窗口模型小会话 round 后恒 0%，
    // 有 token 时至少显示 1%（2026-07-24）
    const pct = contextWindowSize > 0 && currentContextTokens > 0
      ? Math.max(1, Math.min(100, Math.round((currentContextTokens / contextWindowSize) * 100)))
      : 0

    let c: 'green' | 'yellow' | 'red' = 'green'
    if (pct > 90) c = 'red'
    else if (pct > 70) c = 'yellow'

    return {
      percentage: pct,
      color: c,
      used: currentContextTokens,
      total: contextWindowSize,
    }
  }, [currentContextTokens, contextWindowSize])

  const colorClass =
    color === 'green'
      ? 'bg-green-500'
      : color === 'yellow'
        ? 'bg-amber-500'
        : 'bg-red-500'

  const trackColor =
    color === 'green'
      ? 'bg-green-100'
      : color === 'yellow'
        ? 'bg-amber-100'
        : 'bg-red-100'

  const formatK = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)

  // 窗口值来源标记（打磨任务7）：猜测值需提醒用户这是估算
  const sourceLabel =
    contextWindowSource === 'user' ? '窗口：用户设置' :
    contextWindowSource === 'learned' ? '窗口：已学习 ✓' :
    contextWindowSource === 'api' ? '窗口：模型列表' :
    '窗口：估算 ⚠'

  return (
    <div className="flex items-center gap-2" title={`${t('chat.contextCapacityBar.tooltip', { used: used.toLocaleString(), total: total.toLocaleString(), percentage })} · ${sourceLabel}`}>
      <div className={cn('w-24 h-1.5 rounded-full overflow-hidden', trackColor)}>
        <div
          className={cn('h-full rounded-full transition-all duration-500', colorClass)}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className={cn('text-[10px] font-medium tabular-nums',
        color === 'green' ? 'text-green-600' :
        color === 'yellow' ? 'text-amber-600' :
        'text-red-600'
      )}>
        {formatK(used)}/{formatK(total)} ({percentage}%){contextWindowSource === 'guess' ? ' ⚠' : ''}
      </span>
    </div>
  )
}

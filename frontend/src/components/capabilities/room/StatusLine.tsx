import type { CapabilityAdminItem } from '@/api/irisApi'

/**
 * 能力状态行（docs/37）：正常可用不渲染任何指示，
 * 仅遮蔽或不可用时出警告，避免满屏绿点噪音。
 */
export function StatusLine({ item }: { item: CapabilityAdminItem }) {
  if (item.shadowedBy !== null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption text-ink-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-warning" />
        被遮蔽
      </span>
    )
  }
  if (item.availability && item.availability !== 'available') {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption text-ink-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-warning" />
        {item.availabilityReason ?? item.availability}
      </span>
    )
  }
  return null
}

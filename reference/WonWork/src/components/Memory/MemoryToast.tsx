import { toast } from 'sonner'

/**
 * 记忆 toast（记忆之野 2026-07-31）：收入记忆的结果反馈不用系统默认 toast——
 * 记忆有自己的设计语言（纸底、墨色、琥珀 ✦），反馈也应是同一世界里的物件。
 * 温润的含义：入场是从下方轻轻浮起（与覆层卡片的 drift-up 同源），
 * 不闪、不跳、不带色块警告；誊写中的 ✦ 缓慢呼吸，像一笔未落的墨。
 *
 * declined（模型判断不值得记）：给出理由 + "仍要收入"回旋按钮——
 * 智能是双向的：模型可以婉拒，用户始终可以拍板。
 */

export type MemoryToastKind = 'working' | 'saved' | 'merged' | 'duplicate' | 'declined' | 'failed'

export interface MemoryToastOptions {
  kind: MemoryToastKind
  title: string
  /** 副行（如"往后的会话都会记得"） */
  sub?: string
  /** 落桶名（如"偏好"）——告诉用户这条记忆被归到了哪里 */
  bucketLabel?: string
  /** 速览：誊写后的记忆摘要，一行截断 */
  summary?: string
  /** declined 态的回旋动作：{ label, onAction } */
  action?: { label: string; onAction: () => void }
}

function MemoryToastCard({ kind, title, sub, bucketLabel, summary, action }: MemoryToastOptions) {
  return (
    <div className={`mem-toast mem-toast-${kind}`}>
      <span className="mem-toast-mark" aria-hidden>
        ✦
      </span>
      <div className="mem-toast-body">
        <div className="mem-toast-title">
          {title}
          {bucketLabel && <span className="mem-toast-bucket">{bucketLabel}</span>}
        </div>
        {sub && <div className="mem-toast-sub">{sub}</div>}
        {summary && <div className="mem-toast-summary">{summary}</div>}
        {action && (
          <button
            type="button"
            className="mem-toast-action"
            onClick={(e) => {
              e.stopPropagation()
              action.onAction()
            }}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  )
}

const DURATIONS: Record<MemoryToastKind, number> = {
  working: 30_000, // 兜底：正常会被结果 toast dismiss 掉
  saved: 3600,
  merged: 3600,
  duplicate: 2200,
  declined: 8000, // 有回旋按钮，留足决策时间
  failed: 4200,
}

/** 出 toast，返回 id（working 态需要用 id dismiss） */
export function showMemoryToast(opts: MemoryToastOptions): string | number {
  return toast.custom((id) => (
    <MemoryToastCard
      {...opts}
      action={
        opts.action
          ? {
              label: opts.action.label,
              onAction: () => {
                toast.dismiss(id)
                opts.action!.onAction()
              },
            }
          : undefined
      }
    />
  ), {
    duration: DURATIONS[opts.kind],
  })
}

export function dismissMemoryToast(id: string | number): void {
  toast.dismiss(id)
}

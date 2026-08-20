import { useEffect, type ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { permissionModeOptions, type PermissionMode } from '@/domain/chat/input'
import { useViewStateStore } from '@/stores/viewStateStore'
import { useShellOverlayStore } from '@/stores/shellOverlayStore'
import { pushEscLayer } from '@/lib/escLayerStack'
import { Tooltip } from '@/components/ui/Tooltip'
import { cn } from '@/lib/cn'
import type { Accent, Hue, MotionPreference, Theme } from '@/theme/theme'

/**
 * 设置覆盖层（docs/07 §18.3）：全屏覆盖，对话基座不卸载——
 * 回到对话时流式、滚动位、草稿原样存续。修改即生效，无"保存"。
 * 只放真正的偏好；任务数据不进来。
 */

const themeOptions: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
  { value: 'system', label: '跟随系统' },
]

const hueOptions: Array<{ value: Hue; label: string; hint: string }> = [
  { value: 'neutral', label: '中性', hint: '默认纸面' },
  { value: 'warm', label: '暖米', hint: '微微偏暖' },
  { value: 'cool', label: '冷蓝', hint: '微微偏冷' },
]

const accentOptions: Array<{ value: Accent; label: string; swatch: string }> = [
  { value: 'iris', label: '鸢尾', swatch: 'rgb(87 95 199)' },
  { value: 'coral', label: '珊瑚', swatch: 'rgb(201 99 88)' },
  { value: 'gold', label: '金', swatch: 'rgb(176 124 32)' },
  { value: 'mint', label: '薄荷', swatch: 'rgb(43 138 99)' },
  { value: 'sky', label: '天青', swatch: 'rgb(38 118 184)' },
]

const motionOptions: Array<{
  value: MotionPreference
  label: string
  hint: string
}> = [
  { value: 'auto', label: '完整动效', hint: '流式揭示、折叠与过渡正常播放' },
  { value: 'reduce', label: '减弱动效', hint: '收敛所有动画与过渡，内容直接呈现' },
]

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <section className="border-b border-border/60 py-6 last:border-b-0">
      <h3 className="text-body font-semibold text-ink">{title}</h3>
      {description && (
        <p className="mt-1 text-small text-ink-muted">{description}</p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function OptionRow<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string; hint?: string }>
  value: T
  onChange: (value: T) => void
  ariaLabel: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex flex-wrap gap-2"
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Tooltip key={option.value} content={option.hint}>
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              className={cn(
                'rounded-sm border px-3.5 py-2 text-small transition-colors duration-fast',
                'focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none',
                selected
                  ? 'border-primary/50 bg-primary-soft font-medium text-ink'
                  : 'border-border bg-surface-raised text-ink-subtle hover:border-border-strong hover:text-ink',
              )}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

export function SettingsOverlay() {
  const open = useShellOverlayStore((state) => state.settingsOpen)
  const setOpen = useShellOverlayStore((state) => state.setSettingsOpen)
  const theme = useViewStateStore((state) => state.theme)
  const hue = useViewStateStore((state) => state.hue)
  const accent = useViewStateStore((state) => state.accent)
  const motionPreference = useViewStateStore(
    (state) => state.motionPreference,
  )
  const permissionMode = useViewStateStore((state) => state.permissionMode)
  const setTheme = useViewStateStore((state) => state.setTheme)
  const setHue = useViewStateStore((state) => state.setHue)
  const setAccent = useViewStateStore((state) => state.setAccent)
  const setMotionPreference = useViewStateStore(
    (state) => state.setMotionPreference,
  )
  const setPermissionMode = useViewStateStore(
    (state) => state.setPermissionMode,
  )

  // Esc 层栈：设置开着时 Esc 关设置（谁顶谁吃）
  useEffect(() => {
    if (!open) return
    return pushEscLayer({ id: 'settings-overlay', close: () => setOpen(false) })
  }, [open, setOpen])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-40 flex justify-center overflow-y-auto bg-canvas animate-overlay-in motion-reduce:animate-none"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <div className="w-full max-w-xl px-[var(--page-gutter)] pb-16 pt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-title font-semibold text-ink">设置</h2>
          <button
            type="button"
            aria-label="关闭设置"
            className="grid h-9 w-9 place-items-center rounded-sm text-ink-subtle transition-colors duration-fast hover:bg-surface-muted hover:text-ink focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none"
            onClick={() => setOpen(false)}
          >
            <X aria-hidden="true" className="h-4.5 w-4.5" />
          </button>
        </div>
        <p className="mt-1 text-small text-ink-muted">
          修改即刻生效，对话在后台原样保持。
        </p>

        <Section title="主题" description="亮暗外观；跟随系统时随系统切换">
          <OptionRow
            options={themeOptions}
            value={theme}
            onChange={setTheme}
            ariaLabel="主题"
          />
        </Section>

        <Section title="色调" description="中性面的轻微偏移，不影响语义色">
          <OptionRow
            options={hueOptions}
            value={hue}
            onChange={setHue}
            ariaLabel="色调"
          />
        </Section>

        <Section title="主题色" description="动作与选中态使用的强调色">
          <div role="radiogroup" aria-label="主题色" className="flex flex-wrap gap-2.5">
            {accentOptions.map((option) => {
              const selected = option.value === accent
              return (
                <Tooltip key={option.value} content={option.label}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={option.label}
                    className={cn(
                      'grid h-9 w-9 place-items-center rounded-full transition-transform duration-fast',
                      'focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none',
                      selected ? 'scale-105' : 'hover:scale-105',
                    )}
                    style={{
                      backgroundColor: option.swatch,
                      boxShadow: selected
                        ? `0 0 0 2px rgb(var(--color-canvas)), 0 0 0 4px ${option.swatch}`
                        : undefined,
                    }}
                    onClick={() => setAccent(option.value)}
                  >
                    {selected && (
                      <Check aria-hidden="true" className="h-4 w-4 text-white" />
                    )}
                  </button>
                </Tooltip>
              )
            })}
          </div>
        </Section>

        <Section
          title="动效"
          description="系统「减弱动态效果」始终被尊重；这里可以额外手动收敛"
        >
          <OptionRow
            options={motionOptions}
            value={motionPreference}
            onChange={setMotionPreference}
            ariaLabel="动效"
          />
        </Section>

        <Section
          title="默认权限模式"
          description="新对话开始时 composer 的默认档位；对话中仍可随时调整"
        >
          <OptionRow<PermissionMode>
            options={permissionModeOptions.map((option) => ({
              value: option.value,
              label: option.label,
              hint: option.description,
            }))}
            value={permissionMode}
            onChange={setPermissionMode}
            ariaLabel="默认权限模式"
          />
        </Section>
      </div>
    </div>
  )
}

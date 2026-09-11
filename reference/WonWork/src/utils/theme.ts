/**
 * 主题系统工具：管理 document.documentElement 上的 data-theme / data-hue 属性
 * 与 --wf-accent-user 自定义属性。
 * - 模式：data-theme，支持 light / dark / auto，auto 时跟随系统并监听变化。
 * - 色调：data-hue，支持 neutral / warm / cool（neutral 即移除属性）。
 * - 主题色：--wf-accent-user，驱动 --wf-accent（暗色由 CSS 自动调亮）。
 */

import { useSettingsStore, type ThemeMode, type ThemeHue } from '@/stores/settingsStore'

/** 解析主题为实际生效的 'light' 或 'dark' */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'auto') return mode
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

let mediaListener: ((e: MediaQueryListEvent) => void) | null = null

/** 应用主题到 <html>；auto 模式下会动态响应系统主题变化 */
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return

  document.documentElement.dataset.theme = resolveTheme(mode)

  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  if (mode === 'auto') {
    if (!mediaListener) {
      mediaListener = () => {
        document.documentElement.dataset.theme = resolveTheme('auto')
      }
      mql.addEventListener('change', mediaListener)
    }
  } else if (mediaListener) {
    mql.removeEventListener('change', mediaListener)
    mediaListener = null
  }
}

/** 应用色调到 <html>（data-hue）；neutral 时移除属性回退中性基础值 */
export function applyHue(hue: ThemeHue): void {
  if (typeof document === 'undefined') return
  if (hue === 'neutral') document.documentElement.removeAttribute('data-hue')
  else document.documentElement.dataset.hue = hue
}

/** 应用主题色 accent 到 <html>（--wf-accent-user） */
export function applyAccent(hex: string): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--wf-accent-user', hex)
}

/** 应用启动时一次性初始化三层：模式 / 色调 / 主题色 */
export function initTheme(): void {
  const { theme, hue, accent } = useSettingsStore.getState()
  applyTheme(theme ?? 'auto')
  applyHue(hue ?? 'neutral')
  applyAccent(accent ?? '#16a34a')
}

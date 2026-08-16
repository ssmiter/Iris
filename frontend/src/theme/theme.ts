export type Theme = 'light' | 'dark' | 'system'
export type Hue = 'neutral' | 'warm' | 'cool'
export type Accent = 'iris' | 'coral' | 'gold' | 'mint' | 'sky'
export type MotionPreference = 'auto' | 'reduce'

const THEME_STORAGE_KEY = 'iris.theme'
const MOTION_CHANGE_EVENT = 'iris:motion-change'

type ResolvedTheme = 'light' | 'dark'

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function getInitialTheme(): Theme {
  if (typeof window === 'undefined') {
    return 'light'
  }

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (
      storedTheme === 'light'
      || storedTheme === 'dark'
      || storedTheme === 'system'
    ) {
      return storedTheme
    }
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }

  return 'system'
}

let mediaListenerInstalled = false

function installSystemListener() {
  if (mediaListenerInstalled) return
  mediaListenerInstalled = true
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (document.documentElement.dataset.themeChoice === 'system') {
        applyResolved(systemTheme())
      }
    })
}

function applyResolved(resolved: ResolvedTheme) {
  document.documentElement.dataset.theme = resolved
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.style.colorScheme = resolved
}

export function applyTheme(theme: Theme): void {
  installSystemListener()
  document.documentElement.dataset.themeChoice = theme
  applyResolved(theme === 'system' ? systemTheme() : theme)
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme)

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // The current session still changes theme when persistence is blocked.
  }
}

export function applyHue(hue: Hue): void {
  document.documentElement.dataset.hue = hue
}

export function applyAccent(accent: Accent): void {
  document.documentElement.dataset.accent = accent
}

/**
 * 动效偏好。CSS 侧由 [data-motion='reduce'] 收敛动画与过渡；
 * JS 侧（揭示引擎等）监听 iris:motion-change，与系统
 * prefers-reduced-motion 取或。
 */
export function applyMotionPreference(preference: MotionPreference): void {
  document.documentElement.dataset.motion =
    preference === 'reduce' ? 'reduce' : 'auto'
  window.dispatchEvent(new Event(MOTION_CHANGE_EVENT))
}

export function motionPreferenceChangeEventName() {
  return MOTION_CHANGE_EVENT
}

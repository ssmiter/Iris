export type Theme = 'light' | 'dark'

const THEME_STORAGE_KEY = 'iris.theme'

export function getInitialTheme(): Theme {
  if (typeof window === 'undefined') {
    return 'light'
  }

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (storedTheme === 'light' || storedTheme === 'dark') {
      return storedTheme
    }
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme)

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // The current session still changes theme when persistence is blocked.
  }
}

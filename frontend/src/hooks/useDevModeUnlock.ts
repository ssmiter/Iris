import { useEffect, useMemo } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { createDevModeUnlockCounter } from '@/utils/devModeUnlock'

/**
 * 开发者选项解锁 · 快捷键触发源：
 * 全局监听反引号 ` 键连按（计数逻辑见 utils/devModeUnlock，与版本号连点共用）。
 * 输入框/文本域聚焦时不计数，避免正常打字误触发。
 * 已解锁后不再监听计数（幂等）。
 */
const TRIGGER_KEY = '`'

export function useDevModeUnlock() {
  const devModeUnlocked = useSettingsStore((s) => s.devModeUnlocked)
  const counter = useMemo(createDevModeUnlockCounter, [])

  useEffect(() => {
    if (devModeUnlocked) return

    const handler = (e: KeyboardEvent) => {
      if (e.key !== TRIGGER_KEY || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }
      counter()
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [devModeUnlocked, counter])
}

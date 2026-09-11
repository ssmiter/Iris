import { useSettingsStore } from '@/stores/settingsStore'

/**
 * 开发者选项解锁计数器（类手机开发者模式）：
 * 2 秒窗口内连续触发 5 次 → devModeUnlocked = true（持久化）。
 * 两个触发源共用同一逻辑：全局反引号 ` 连按 ×5（开发者快捷键）、
 * 设置页版本号连点 ×5（Android 一致的规范入口）。
 */
const REQUIRED_TRIGGER_COUNT = 5
const WINDOW_MS = 2000

export function createDevModeUnlockCounter() {
  let count = 0
  let firstTriggerAt = 0

  return () => {
    if (useSettingsStore.getState().devModeUnlocked) return
    const now = Date.now()
    if (now - firstTriggerAt > WINDOW_MS) {
      count = 0
      firstTriggerAt = now
    }
    count += 1
    if (count >= REQUIRED_TRIGGER_COUNT) {
      useSettingsStore.getState().setDevModeUnlocked(true)
    }
  }
}

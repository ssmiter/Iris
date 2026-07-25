import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import i18n from '@/i18n'
import type { ExecutionMode } from '@/agent/types'

type Language = 'zh-CN' | 'en-US'

/** 对话内容列宽度档位（v9 hintbar）：驱动 --wf-col-max */
export type ChatWidth = 680 | 780 | 960

interface SettingsState {
  language: Language
  setLanguage: (language: Language) => void
  /** 权限模式全局默认值（打磨任务2 S1）：对话栏下拉可会话级覆盖 */
  permissionMode: ExecutionMode
  setPermissionMode: (mode: ExecutionMode) => void
  /** 对话列宽档位（px），默认 780 */
  chatWidth: ChatWidth
  setChatWidth: (w: ChatWidth) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      language: 'zh-CN',
      setLanguage: (language) => {
        i18n.changeLanguage(language)
        set({ language })
      },
      permissionMode: 'auto',
      setPermissionMode: (mode) => set({ permissionMode: mode }),
      chatWidth: 780,
      setChatWidth: (w) => set({ chatWidth: w }),
    }),
    {
      name: 'wonclaw-settings',
      partialize: (state) => ({ language: state.language, permissionMode: state.permissionMode, chatWidth: state.chatWidth }),
    }
  )
)

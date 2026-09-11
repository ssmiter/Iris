import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import i18n from '@/i18n'
import type { ExecutionMode } from '@/agent/types'
import { applyTheme, applyHue, applyAccent } from '@/utils/theme'

type Language = 'zh-CN' | 'en-US'

/** 界面主题三态：浅色 / 深色 / 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'auto'

/** 界面色调：中性（默认）/ 暖米 / 冷蓝 */
export type ThemeHue = 'neutral' | 'warm' | 'cool'

/** 对话内容列宽度档位（v9 hintbar）：驱动 --wf-col-max */
export type ChatWidth = 680 | 780 | 960

interface SettingsState {
  language: Language
  setLanguage: (language: Language) => void
  /** 界面主题 */
  theme: ThemeMode
  setTheme: (theme: ThemeMode) => void
  /** 界面色调 */
  hue: ThemeHue
  setHue: (hue: ThemeHue) => void
  /** 主题色 accent（hex），驱动 --wf-accent-user */
  accent: string
  setAccent: (hex: string) => void
  /** 权限模式全局默认值（打磨任务2 S1）：对话栏下拉可会话级覆盖 */
  permissionMode: ExecutionMode
  setPermissionMode: (mode: ExecutionMode) => void
  /** 对话列宽档位（px），默认 780 */
  chatWidth: ChatWidth
  setChatWidth: (w: ChatWidth) => void
  /** 顶栏自动隐藏（蓝图 v13 触顶状态条）：平时全隐，触顶热区/回滚到顶上拉唤出；关闭=常驻粘性顶栏 */
  topbarAutoHide: boolean
  setTopbarAutoHide: (on: boolean) => void
  /** 右缘悬停浮现进展入口，点击才展开；点击面板外任意处自动收起 */
  rightPanelEdgeHover: boolean
  setRightPanelEdgeHover: (on: boolean) => void
  /** 滚动跟随模式（2026-08-14）：auto=流式跟随最新（上滑脱随）；
      manual=手动：新内容不拽滚动条，点"回到最新"才跳（长对话翻阅不中断） */
  scrollFollow: 'auto' | 'manual'
  setScrollFollow: (mode: 'auto' | 'manual') => void
  /** 开发者选项已解锁（连按 ` 键 5 次触发）：解锁后设置页出现数据库连接配置卡片 */
  devModeUnlocked: boolean
  setDevModeUnlocked: (unlocked: boolean) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      language: 'zh-CN',
      setLanguage: (language) => {
        i18n.changeLanguage(language)
        set({ language })
      },
      theme: 'auto',
      setTheme: (theme) => {
        applyTheme(theme)
        set({ theme })
      },
      hue: 'neutral',
      setHue: (hue) => {
        applyHue(hue)
        set({ hue })
      },
      accent: '#16a34a',
      setAccent: (accent) => {
        applyAccent(accent)
        set({ accent })
      },
      permissionMode: 'auto',
      setPermissionMode: (mode) => set({ permissionMode: mode }),
      chatWidth: 780,
      setChatWidth: (w) => set({ chatWidth: w }),
      topbarAutoHide: true,
      setTopbarAutoHide: (on) => set({ topbarAutoHide: on }),
      rightPanelEdgeHover: true,
      setRightPanelEdgeHover: (on) => set({ rightPanelEdgeHover: on }),
      scrollFollow: 'auto',
      setScrollFollow: (mode) => set({ scrollFollow: mode }),
      devModeUnlocked: false,
      setDevModeUnlocked: (unlocked) => set({ devModeUnlocked: unlocked }),
    }),
    {
      name: 'wonclaw-settings',
      partialize: (state) => ({
        language: state.language,
        theme: state.theme,
        hue: state.hue,
        accent: state.accent,
        permissionMode: state.permissionMode,
        chatWidth: state.chatWidth,
        topbarAutoHide: state.topbarAutoHide,
        rightPanelEdgeHover: state.rightPanelEdgeHover,
        scrollFollow: state.scrollFollow,
        devModeUnlocked: state.devModeUnlocked,
      }),
    }
  )
)

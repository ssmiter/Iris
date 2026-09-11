import { create } from 'zustand'

/**
 * 走廊（corridor）空间模型（2026-08-07 能力页蓝图 v12「两个房间，一条走廊」）：
 * 对话是常驻基底层永不卸载，能力房是覆盖层从右侧滑入；对话退后缩小为左走廊，
 * 点走廊/Esc 丝滑返回，全程无跳页感。
 *
 * 状态机刻意保持贫瘠：closed / open(哪个 tab, 什么意图)——不做通用层系统，
 * 走廊是能力房专属形态，其他视图（workflow/settings 等）维持 MainLayout 旧 switch。
 *
 * 打开协议：任何触发方（侧栏入口 / 未来触点② suggest_capability 工具 / hintbar）
 * 都走 open({tab, focusName})；focusName 意图=直达某能力的打量面板（市场 registry 名），
 * 由 McpMarketView 消费后 clearFocus。
 */
export type CorridorTab = 'manage' | 'discover'

interface CorridorState {
  isOpen: boolean
  /** 能力房内部 tab：manage=我的能力（管理间） / discover=发现更多（发现间） */
  tab: CorridorTab
  /** 打开意图：进入后直达该能力的打量面板（触点②预埋；市场 registry 全名） */
  focusName: string | null
  /** 打开意图：进入管理间后定位并展开该已安装 server 行（市场卡「已学会·去管理」用） */
  focusInstalled: string | null
  /** 一次性对话框预填（toast「回到对话直接用」动作）：InputArea 消费后自动清空 */
  composerPrefill: string | null

  open: (opts?: { tab?: CorridorTab; focusName?: string; focusInstalled?: string }) => void
  close: () => void
  setTab: (tab: CorridorTab) => void
  /** 市场卡「已学会 · 去管理」：切管理间并定位展开该 server 行 */
  goManage: (serverName: string) => void
  clearFocus: () => void
  /** text 非空=覆盖输入框内容并聚焦；空串=仅聚焦不回填 */
  prefillComposer: (text: string) => void
  consumePrefill: () => void
}

export const useCorridorStore = create<CorridorState>()((set, get) => ({
  isOpen: false,
  tab: 'manage',
  focusName: null,
  focusInstalled: null,
  composerPrefill: null,

  open: (opts) =>
    set((s) => ({
      isOpen: true,
      tab: opts?.tab ?? s.tab,
      focusName: opts?.focusName ?? null,
      focusInstalled: opts?.focusInstalled ?? null,
    })),
  close: () => set({ isOpen: false, focusName: null, focusInstalled: null }),
  setTab: (tab) => set({ tab }),
  goManage: (serverName) => set({ tab: 'manage', focusInstalled: serverName }),
  clearFocus: () => set({ focusName: null, focusInstalled: null }),
  prefillComposer: (text) => set({ composerPrefill: text }),
  consumePrefill: () => {
    if (get().composerPrefill !== null) set({ composerPrefill: null })
  },
}))

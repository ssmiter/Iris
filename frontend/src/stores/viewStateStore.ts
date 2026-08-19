import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { PermissionMode } from '@/domain/chat/input'
import {
  getInitialTheme,
  type Accent,
  type Hue,
  type MotionPreference,
  type Theme,
} from '@/theme/theme'

type FlagMap = Record<string, true>
/**
 * 对话列宽档位（px），按中文阅读 measure 推导：正文 15px 全角字 ≈ 15px/字，
 * 中文最优 28–40 字/行。760 为默认（混合内容均衡），640 贴近纯中文阅读
 * 最优区（≈38 字/行），920 留给宽表格/代码。数字即值，不做语义化名。
 */
export type ConversationWidth = 640 | 760 | 920
export const DEFAULT_CONVERSATION_WIDTH: ConversationWidth = 760

export interface ViewState {
  expandedRoundIds: FlagMap
  expandedNodeIds: FlagMap
  initializedNodeIds: FlagMap
  theme: Theme
  hue: Hue
  accent: Accent
  motionPreference: MotionPreference
  permissionMode: PermissionMode
  draftsByConversationId: Record<string, string>
  sidebarOpen: boolean
  mobileSidebarOpen: boolean
  conversationWidth: ConversationWidth

  toggleRound: (roundId: string, nodeIds: string[]) => void
  setConversationWidth: (width: ConversationWidth) => void
  toggleNode: (nodeId: string) => void
  seedExpandedNodes: (nodeIds: string[]) => void
  revealNewRoundNodes: (roundId: string, nodeIds: string[]) => void
  setTheme: (theme: Theme) => void
  setHue: (hue: Hue) => void
  setAccent: (accent: Accent) => void
  setMotionPreference: (preference: MotionPreference) => void
  setPermissionMode: (mode: PermissionMode) => void
  setDraft: (conversationId: string, value: string) => void
  setSidebarOpen: (open: boolean) => void
  setMobileSidebarOpen: (open: boolean) => void
}

function toggleFlag(flags: FlagMap, id: string): FlagMap {
  if (flags[id]) {
    const { [id]: _, ...rest } = flags
    return rest
  }
  return { ...flags, [id]: true }
}

export const useViewStateStore = create<ViewState>()(
  persist(
    (set) => ({
      expandedRoundIds: {},
      expandedNodeIds: {},
      initializedNodeIds: {},
      theme: getInitialTheme(),
      hue: 'neutral',
      accent: 'iris',
      motionPreference: 'auto',
      permissionMode: 'auto',
      draftsByConversationId: {},
      sidebarOpen: true,
      mobileSidebarOpen: false,
      conversationWidth: DEFAULT_CONVERSATION_WIDTH,

      toggleRound: (roundId, nodeIds) =>
        set((state) => {
          if (state.expandedRoundIds[roundId]) {
            return {
              expandedRoundIds: toggleFlag(
                state.expandedRoundIds,
                roundId,
              ),
            }
          }

          const unseenNodeIds = nodeIds.filter(
            (nodeId) => !state.initializedNodeIds[nodeId],
          )
          return {
            expandedRoundIds: {
              ...state.expandedRoundIds,
              [roundId]: true,
            },
            expandedNodeIds: unseenNodeIds.reduce<FlagMap>(
              (flags, nodeId) => ({ ...flags, [nodeId]: true }),
              state.expandedNodeIds,
            ),
            initializedNodeIds: unseenNodeIds.reduce<FlagMap>(
              (flags, nodeId) => ({ ...flags, [nodeId]: true }),
              state.initializedNodeIds,
            ),
          }
        }),
      toggleNode: (nodeId) =>
        set((state) => ({
          expandedNodeIds: toggleFlag(state.expandedNodeIds, nodeId),
          initializedNodeIds: {
            ...state.initializedNodeIds,
            [nodeId]: true,
          },
        })),
      seedExpandedNodes: (nodeIds) =>
        set((state) => ({
          expandedNodeIds: nodeIds.reduce<FlagMap>(
            (flags, nodeId) => ({ ...flags, [nodeId]: true }),
            state.expandedNodeIds,
          ),
          initializedNodeIds: nodeIds.reduce<FlagMap>(
            (flags, nodeId) => ({ ...flags, [nodeId]: true }),
            state.initializedNodeIds,
          ),
        })),
      revealNewRoundNodes: (roundId, nodeIds) =>
        set((state) => {
          if (!state.expandedRoundIds[roundId]) return state
          const unseenNodeIds = nodeIds.filter(
            (nodeId) => !state.initializedNodeIds[nodeId],
          )
          if (unseenNodeIds.length === 0) return state
          return {
            expandedNodeIds: unseenNodeIds.reduce<FlagMap>(
              (flags, nodeId) => ({ ...flags, [nodeId]: true }),
              state.expandedNodeIds,
            ),
            initializedNodeIds: unseenNodeIds.reduce<FlagMap>(
              (flags, nodeId) => ({ ...flags, [nodeId]: true }),
              state.initializedNodeIds,
            ),
          }
        }),
      setTheme: (theme) => set({ theme }),
      setHue: (hue) => set({ hue }),
      setAccent: (accent) => set({ accent }),
      setMotionPreference: (motionPreference) => set({ motionPreference }),
      setPermissionMode: (permissionMode) => set({ permissionMode }),
      setConversationWidth: (conversationWidth) => set({ conversationWidth }),
      setDraft: (conversationId, value) =>
        set((state) => ({
          draftsByConversationId: {
            ...state.draftsByConversationId,
            [conversationId]: value,
          },
        })),
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
      setMobileSidebarOpen: (mobileSidebarOpen) =>
        set({ mobileSidebarOpen }),
    }),
    {
      name: 'iris.view-state.v1',
      version: 3,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted) => {
        // v2 → v3：列宽从 wide/narrow 语义档改为数字档（640/760/920）
        const state = persisted as Partial<ViewState> & {
          conversationWidth?: ConversationWidth | 'wide' | 'narrow'
        }
        const width = state.conversationWidth
        return {
          ...state,
          conversationWidth:
            width === 640 || width === 760 || width === 920
              ? width
              : width === 'narrow'
                ? 640
                : DEFAULT_CONVERSATION_WIDTH,
        }
      },
      partialize: (state) => ({
        theme: state.theme,
        hue: state.hue,
        accent: state.accent,
        motionPreference: state.motionPreference,
        permissionMode: state.permissionMode,
        draftsByConversationId: state.draftsByConversationId,
        sidebarOpen: state.sidebarOpen,
        conversationWidth: state.conversationWidth,
      }),
    },
  ),
)

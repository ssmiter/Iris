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
export type ConversationWidth = 'wide' | 'narrow'

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
      conversationWidth: 'wide',

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
      version: 2,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted) => {
        // v1 → v2：新增 hue/accent/motionPreference，沿用旧 theme 与草稿
        const state = persisted as Partial<ViewState>
        return {
          ...state,
          hue: state.hue ?? 'neutral',
          accent: state.accent ?? 'iris',
          motionPreference: state.motionPreference ?? 'auto',
          conversationWidth: state.conversationWidth ?? 'wide',
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

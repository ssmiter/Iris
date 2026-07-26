import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { PermissionMode } from '@/domain/chat/input'
import { getInitialTheme, type Theme } from '@/theme/theme'

type FlagMap = Record<string, true>

export interface ViewState {
  expandedRoundIds: FlagMap
  expandedNodeIds: FlagMap
  followMode: 'following' | 'reviewing'
  atBottom: boolean
  unseenTurnCount: number
  theme: Theme
  permissionMode: PermissionMode
  draftsByConversationId: Record<string, string>
  sidebarOpen: boolean
  mobileSidebarOpen: boolean

  toggleRound: (roundId: string) => void
  toggleNode: (nodeId: string) => void
  seedExpandedNodes: (nodeIds: string[]) => void
  setScrollState: (atBottom: boolean) => void
  reviewHistory: () => void
  addUnseenTurns: (count: number) => void
  followLatest: () => void
  setTheme: (theme: Theme) => void
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
      followMode: 'following',
      atBottom: true,
      unseenTurnCount: 0,
      theme: getInitialTheme(),
      permissionMode: 'auto',
      draftsByConversationId: {},
      sidebarOpen: true,
      mobileSidebarOpen: false,

      toggleRound: (roundId) =>
        set((state) => ({
          expandedRoundIds: toggleFlag(state.expandedRoundIds, roundId),
        })),
      toggleNode: (nodeId) =>
        set((state) => ({
          expandedNodeIds: toggleFlag(state.expandedNodeIds, nodeId),
        })),
      seedExpandedNodes: (nodeIds) =>
        set((state) => ({
          expandedNodeIds: nodeIds.reduce<FlagMap>(
            (flags, nodeId) => ({ ...flags, [nodeId]: true }),
            state.expandedNodeIds,
          ),
        })),
      setScrollState: (atBottom) =>
        set((state) => ({
          atBottom,
          followMode: atBottom ? 'following' : state.followMode,
          unseenTurnCount: atBottom ? 0 : state.unseenTurnCount,
        })),
      reviewHistory: () =>
        set({
          followMode: 'reviewing',
        }),
      addUnseenTurns: (count) =>
        set((state) => ({
          unseenTurnCount:
            state.followMode === 'reviewing'
              ? state.unseenTurnCount + Math.max(0, count)
              : state.unseenTurnCount,
        })),
      followLatest: () =>
        set({
          atBottom: true,
          followMode: 'following',
          unseenTurnCount: 0,
        }),
      setTheme: (theme) => set({ theme }),
      setPermissionMode: (permissionMode) => set({ permissionMode }),
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
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        permissionMode: state.permissionMode,
        draftsByConversationId: state.draftsByConversationId,
        sidebarOpen: state.sidebarOpen,
      }),
    },
  ),
)

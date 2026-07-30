import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { PermissionMode } from '@/domain/chat/input'
import { getInitialTheme, type Theme } from '@/theme/theme'

type FlagMap = Record<string, true>

export interface ViewState {
  expandedRoundIds: FlagMap
  expandedNodeIds: FlagMap
  initializedNodeIds: FlagMap
  theme: Theme
  permissionMode: PermissionMode
  draftsByConversationId: Record<string, string>
  sidebarOpen: boolean
  mobileSidebarOpen: boolean

  toggleRound: (roundId: string, nodeIds: string[]) => void
  toggleNode: (nodeId: string) => void
  seedExpandedNodes: (nodeIds: string[]) => void
  revealNewRoundNodes: (roundId: string, nodeIds: string[]) => void
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
      initializedNodeIds: {},
      theme: getInitialTheme(),
      permissionMode: 'auto',
      draftsByConversationId: {},
      sidebarOpen: true,
      mobileSidebarOpen: false,

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

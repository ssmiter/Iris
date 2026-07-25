import { create } from 'zustand'
import type { Conversation } from '@/types/chat'
import { historyApi } from '@/api/client'
import { viewStateDelete } from '@/api/viewState'
import { useContextPanelStore } from '@/stores/contextPanelStore'
import { useProjectStore } from '@/stores/projectStore'
import { useConversationTitleStore } from '@/stores/conversationTitleStore'
import { getErrorMessage } from '@/utils/error'
import { toast } from 'sonner'

interface ConversationState {
  conversations: Conversation[]
  currentConversationId: number | null
  isLoadingConversations: boolean
  conversationsLoaded: boolean

  loadConversations: () => Promise<void>
  createConversation: (title?: string) => Promise<number | null>
  deleteConversation: (conversationId: number) => Promise<void>
  updateConversationTitle: (conversationId: number, title: string) => Promise<void>
  setCurrentConversation: (conversationId: number | null) => void
  getCurrentConversation: () => Conversation | undefined
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: [],
  currentConversationId: null,
  isLoadingConversations: false,
  conversationsLoaded: false,

  loadConversations: async () => {
    if (get().isLoadingConversations) return
    set({ isLoadingConversations: true })
    try {
      const conversations = await historyApi.getConversations()
      set({ conversations, conversationsLoaded: true })
    } catch (err) {
      const msg = getErrorMessage(err, '加载会话失败')
      toast.error(msg)
    } finally {
      set({ isLoadingConversations: false })
    }
  },

  createConversation: async (title) => {
    try {
      const result = await historyApi.createConversation({ title: title || 'New Conversation' })
      // 2026-07-24 审计修复：不要默认 'ykhm'——它会污染 website-online / 本地 / Standalone 会话的域归属。
      // 优先使用 localStorage 中已持久化的 systemCode；若取不到说明当前不是 MES 登录，使用 'local'。
      const rawSystemCode = localStorage.getItem('wonclaw_system_code')
      const systemCode = rawSystemCode?.trim() || 'local'
      const userId = Number(localStorage.getItem('wonclaw_user_id')) || 0
      const newConv: Conversation = {
        id: result.id,
        userId,
        title: result.title,
        systemCode,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      set((state) => ({
        conversations: [newConv, ...state.conversations],
        currentConversationId: result.id,
      }))
      useContextPanelStore.getState().clearTasks()
      return result.id
    } catch (err) {
      const msg = getErrorMessage(err, '创建会话失败')
      toast.error(msg)
      return null
    }
  },

  deleteConversation: async (conversationId) => {
    try {
      await historyApi.deleteConversation(conversationId)
      // 清理对话视图状态（分支快照/压缩边界，v9.4）
      void viewStateDelete(`branches-${conversationId}`).catch(() => {})
      void viewStateDelete(`compacts-${conversationId}`).catch(() => {})
      set((state) => ({
        conversations: state.conversations.filter((c) => c.id !== conversationId),
        currentConversationId:
          state.currentConversationId === conversationId ? null : state.currentConversationId,
      }))
      useConversationTitleStore.getState().removeConversation(conversationId)
      // Note: clearing messages when deleting current conversation is handled by the Sidebar component
    } catch (err) {
      const msg = getErrorMessage(err, '删除会话失败')
      toast.error(msg)
    }
  },

  updateConversationTitle: async (conversationId, title) => {
    try {
      await historyApi.updateTitle(conversationId, { title })
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, title } : c
        ),
      }))
    } catch (err) {
      const msg = getErrorMessage(err, '更新标题失败')
      toast.error(msg)
    }
  },

  setCurrentConversation: (conversationId) => {
    const previousId = get().currentConversationId
    set({ currentConversationId: conversationId })

    if (previousId !== conversationId && conversationId !== null) {
      useContextPanelStore.getState().clearTasks()
      // S4 项目模式：会话切换时幂等断言该会话绑定的项目根（D1）
      useProjectStore.getState().assertProjectForConversation(conversationId)
    }
  },

  getCurrentConversation: () => {
    const { conversations, currentConversationId } = get()
    return conversations.find((c) => c.id === currentConversationId)
  },
}))

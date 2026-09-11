import { create } from 'zustand'
import type { Conversation } from '@/types/chat'
import { historyApi } from '@/api/client'
import { viewStateDelete } from '@/api/viewState'
import { useContextPanelStore } from '@/stores/contextPanelStore'
import { removeConversation as removeConversationTitleState } from '@/stores/conversationTitleStore'
import { rebuildTaskSessionFamilies } from '@/agent/permissionRules'
import { abortMainLoopRun, dropViewStash } from '@/stores/mainLoopRuns'
import { removeConversationBrowsePath } from '@/stores/browseDirectoryStore'
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
  /**
   * 项目目录绑定（2026-09-09 文件浏览二阶段）：path=null 解绑。
   * 唯一写入口：浏览面板「设为项目目录」、模型 set_browse_directory、localStorage 旧指针迁移都走这里。
   * 返回是否成功；不写 toast（调用方按场景自行提示，迁移场景需静默）。
   */
  setConversationProject: (conversationId: number, path: string | null) => Promise<boolean>
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
      // 权限规则家族映射随会话列表重建（任务会话本对话档规则以父会话为键，刷新后内存映射丢失）
      rebuildTaskSessionFamilies(conversations)
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
      // 2026-09-04 会话后台化：先停掉该会话可能仍在后台运行的主 loop 并清 stash——
      // 否则 run 的落库目标已删除，persist 会把消息写进已删会话（且视图再无入口）
      await abortMainLoopRun(conversationId)
      dropViewStash(conversationId)
      await historyApi.deleteConversation(conversationId)
      // 清理对话视图状态（分支快照/压缩边界，v9.4）
      void viewStateDelete(`branches-${conversationId}`).catch(() => {})
      void viewStateDelete(`compacts-${conversationId}`).catch(() => {})
      set((state) => ({
        conversations: state.conversations.filter((c) => c.id !== conversationId),
        currentConversationId:
          state.currentConversationId === conversationId ? null : state.currentConversationId,
      }))
      removeConversationTitleState(conversationId)
      // 浏览面板的项目目录指针（conversationPaths 条目）随会话删除清理——只删映射，
      // 目录/产物本身在磁盘上不动
      removeConversationBrowsePath(conversationId)
      // Note: clearing messages when deleting current conversation is handled by the Sidebar component
    } catch (err) {
      const msg = getErrorMessage(err, '删除会话失败')
      toast.error(msg)
    }
  },

  setConversationProject: async (conversationId, path) => {
    try {
      await historyApi.setConversationProject(conversationId, path)
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, projectPath: path ?? undefined } : c
        ),
      }))
      return true
    } catch {
      return false
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
    }
  },

  getCurrentConversation: () => {
    const { conversations, currentConversationId } = get()
    return conversations.find((c) => c.id === currentConversationId)
  },
}))

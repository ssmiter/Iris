import { create } from 'zustand'
import type { BranchAnchor, ChatMessage, CompactBoundary } from '@/agent/types'

/**
 * 对话状态（骨架）。完整职责见 docs/06：
 * 消息/分支/压缩线/审批/队列/补充，以及与 IndexedDB 视图状态的同步。
 *
 * 红线：
 * - 手动停止 = 完全停止：未注入的补充转排队 chip，不自动发送（防死循环）
 * - 历史不可丢：分支变体保存完整快照；压缩只画线不动历史
 */

interface ChatState {
  messages: ChatMessage[]
  isStreaming: boolean
  branches: Record<string, BranchAnchor>
  compactBoundaries: CompactBoundary[]
  queuedMessages: { id: string; text: string }[]

  sendMessage: (text: string) => Promise<void>
  stopStreaming: () => void
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isStreaming: false,
  branches: {},
  compactBoundaries: [],
  queuedMessages: [],

  sendMessage: async (text) => {
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }
    set((s) => ({ messages: [...s.messages, userMsg], isStreaming: true }))
    // TODO(M0)：调 /api/chat/proxy（SSE），逐 delta 更新 renderNodes（docs/08 §1）
    set({ isStreaming: false })
  },

  stopStreaming: () => {
    // 手动停止 = 完全停止：不触发任何自动发送（docs/06 §8）
    set({ isStreaming: false })
  },
}))

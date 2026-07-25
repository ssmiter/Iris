/**
 * artifactDockStore — 预览坞全局状态
 *
 * 职责：
 * - 预览坞的打开/关闭/tab 切换
 * - 产物注册表（当前对话的所有 present_artifact 产物）
 * - 当前预览的产物 ID
 * - unseen dot 标记
 *
 * 不持久化——产物是会话级别的，刷新后清零。
 */

import { create } from 'zustand'
import type { FileCardArtifact } from '@/types/artifactDock'

export type DockTab = 'preview' | 'files'

interface ArtifactDockState {
  // ── 面板状态 ──
  isOpen: boolean
  activeTab: DockTab
  currentArtifactId: string | null

  // ── 产物注册表 ──
  /** path → artifact */
  artifacts: Record<string, FileCardArtifact>
  /** 插入顺序（胶片条按此顺序渲染） */
  artifactOrder: string[]
  /** 已注册但尚未在 dock 中查看过的产物 ID */
  unseenIds: Set<string>

  // ── Actions ──
  /** 打开坞，可指定初始 artifact 和 tab */
  open: (artifactId?: string, tab?: DockTab) => void
  /** 关闭坞 */
  close: () => void
  /** 切换坞的打开/关闭 */
  toggle: () => void
  /** 切换 tab */
  setTab: (tab: DockTab) => void
  /** 切换当前预览的产物 */
  setCurrent: (artifactId: string) => void
  /** 注册一个新产物（FileCard 挂载时调用） */
  registerArtifact: (artifact: FileCardArtifact) => void
  /**
   * 会话切换时从后端索引水合注册表（历史产物还原）。
   * 与 registerArtifact 的区别：不标 unseen（这些产物用户此前已见过）、
   * 按数组顺序整体设置（顺序即后端 CreatedAt 升序）。
   */
  hydrateArtifacts: (artifacts: FileCardArtifact[]) => void
  /** 标记产物为已查看 */
  markSeen: (artifactId: string) => void
  /** 标记所有 unseen 为已查看 */
  markAllSeen: () => void
  /** 切换对话时清空所有产物 */
  clearConversation: () => void
}

export const useArtifactDockStore = create<ArtifactDockState>()((set, get) => ({
  isOpen: false,
  activeTab: 'preview',
  currentArtifactId: null,
  artifacts: {},
  artifactOrder: [],
  unseenIds: new Set<string>(),

  open: (artifactId, tab = 'preview') => {
    set((s) => {
      const next: Partial<ArtifactDockState> = { isOpen: true, activeTab: tab }
      if (artifactId) {
        next.currentArtifactId = artifactId
        // 标记为已查看
        const newUnseen = new Set(s.unseenIds)
        newUnseen.delete(artifactId)
        next.unseenIds = newUnseen
      }
      return next
    })
  },

  close: () => set({ isOpen: false }),

  toggle: () => {
    const { isOpen } = get()
    if (isOpen) {
      set({ isOpen: false })
    } else {
      set({ isOpen: true })
    }
  },

  setTab: (tab) => set({ activeTab: tab }),

  setCurrent: (artifactId) => {
    set((s) => {
      const newUnseen = new Set(s.unseenIds)
      newUnseen.delete(artifactId)
      return { currentArtifactId: artifactId, unseenIds: newUnseen }
    })
  },

  registerArtifact: (artifact) => {
    set((s) => {
      const existing = s.artifacts[artifact.id]

      // 若已存在，检查富数据是否变化（chartData/tableData/docHtml）
      if (existing) {
        const hasNewData =
          (!existing.chartData && artifact.chartData) ||
          (!existing.tableData && artifact.tableData) ||
          (!existing.docHtml && artifact.docHtml) ||
          (existing.chartData && artifact.chartData && JSON.stringify(existing.chartData) !== JSON.stringify(artifact.chartData)) ||
          (existing.tableData && artifact.tableData && JSON.stringify(existing.tableData) !== JSON.stringify(artifact.tableData)) ||
          (existing.docHtml && artifact.docHtml && existing.docHtml !== artifact.docHtml)

        if (!hasNewData) {
          // 无新数据，跳过
          return {}
        }

        // 有新数据，覆盖原记录
        const newArtifacts = { ...s.artifacts, [artifact.id]: artifact }
        return { artifacts: newArtifacts }
      }

      // 新注册
      const newArtifacts = { ...s.artifacts, [artifact.id]: artifact }
      const newOrder = [...s.artifactOrder, artifact.id]
      const newUnseen = new Set(s.unseenIds)
      newUnseen.add(artifact.id)

      return {
        artifacts: newArtifacts,
        artifactOrder: newOrder,
        unseenIds: newUnseen,
        // 如果是第一个产物且坞未开，自动设为当前
        currentArtifactId: s.currentArtifactId ?? artifact.id,
      }
    })
  },

  hydrateArtifacts: (artifacts) => {
    if (artifacts.length === 0) return
    set((s) => {
      const newArtifacts = { ...s.artifacts }
      const newOrder = [...s.artifactOrder]
      for (const a of artifacts) {
        // 已存在（如 live 注册含富数据）不覆盖——索引水合只补缺
        if (!(a.id in newArtifacts)) {
          newOrder.push(a.id)
          newArtifacts[a.id] = a
        }
      }
      return {
        artifacts: newArtifacts,
        artifactOrder: newOrder,
        currentArtifactId: s.currentArtifactId ?? newOrder[0] ?? null,
      }
    })
  },

  markSeen: (artifactId) => {    set((s) => {
      const newUnseen = new Set(s.unseenIds)
      newUnseen.delete(artifactId)
      return { unseenIds: newUnseen }
    })
  },

  markAllSeen: () => {
    set({ unseenIds: new Set<string>() })
  },

  clearConversation: () => {
    set({
      isOpen: false,
      activeTab: 'preview',
      currentArtifactId: null,
      artifacts: {},
      artifactOrder: [],
      unseenIds: new Set<string>(),
    })
  },
}))

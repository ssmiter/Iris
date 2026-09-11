/**
 * artifactDockStore — 预览坞全局状态
 *
 * 职责：
 * - 预览坞的打开/关闭/tab 切换
 * - 产物注册表（当前对话的所有 present_artifact 产物）
 * - 当前预览的产物 ID
 * - unseen dot 标记
 *
 * 产物本身是会话级别的（刷新后内存清零，靠后端索引水合还原）；
 * 唯一持久化的是「移除墓碑」——被移除的产物 id 按会话记入 localStorage，
 * 水合时命中墓碑即不再复活（刷新/重进不复活）。
 */

import { create } from 'zustand'
import type { FileCardArtifact } from '@/types/artifactDock'
import { useConversationStore } from '@/stores/conversationStore'

export type DockTab = 'preview' | 'files'

// ── 移除墓碑（localStorage）────────────────────────────────
// 移除产物是「坞层」语义：本地列表移除 + 按会话记墓碑，水合时命中墓碑即跳过。
// 墓碑跨水合存活、不随 clearConversation 清除（这正是它存在的意义）。
const TOMBSTONE_KEY = 'wonclaw-dock-tombstones'
const TOMBSTONE_MAX = 200

/** 读取全量墓碑表（Record<convId, artifactId[]>）；localStorage 异常时回退空表 */
function readTombstones(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(TOMBSTONE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string[]>
    }
    return {}
  } catch {
    return {}
  }
}

function writeTombstones(map: Record<string, string[]>): void {
  try {
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(map))
  } catch (e) {
    console.warn('[artifactDock] 墓碑写入失败（不影响列表移除）:', e)
  }
}

/** 记录一条墓碑：会话内去重、追加到末尾；超上限丢最旧 */
function addTombstone(convId: string, artifactId: string): void {
  const map = readTombstones()
  const list = (Array.isArray(map[convId]) ? map[convId] : []).filter((x) => x !== artifactId)
  list.push(artifactId)
  if (list.length > TOMBSTONE_MAX) list.splice(0, list.length - TOMBSTONE_MAX)
  map[convId] = list
  writeTombstones(map)
}

/** 某会话的墓碑 id 集合 */
function tombstoneIds(convId: string): Set<string> {
  const list = readTombstones()[convId]
  return new Set(Array.isArray(list) ? list : [])
}

/** 当前会话墓碑键；无会话时用匿名兜底（仍跨水合生效） */
function currentConvKey(): string {
  const id = useConversationStore.getState().currentConversationId
  return id == null ? '__anon__' : String(id)
}

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
  /**
   * 注册一个新产物（FileCard 挂载时调用）。
   * opts.auto=true 表示被动注册（FileCard 挂载触发）——尊重墓碑，用户已移除的不复活；
   * 不带 auto 的是显式意图（FilesPane 点击工作区文件）——放行复活。
   */
  registerArtifact: (artifact: FileCardArtifact, opts?: { auto?: boolean }) => void
  /**
   * 会话切换时从后端索引水合注册表（历史产物还原）。
   * 与 registerArtifact 的区别：不标 unseen（这些产物用户此前已见过）、
   * 按数组顺序整体设置（顺序即后端 CreatedAt 升序）。
   */
  hydrateArtifacts: (artifacts: FileCardArtifact[]) => void
  /**
   * 从坞中移除单个产物（前端坞层语义：本地列表移除 + 会话墓碑防水合复活）。
   * 若移除的正是当前预览产物，同时按 close 逻辑关闭预览。
   */
  removeArtifact: (id: string) => void
  /** 切换对话时清空所有产物（墓碑不清——墓碑的意义就是跨水合存活） */
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

  registerArtifact: (artifact, opts) => {
    // 被动注册（FileCard 重挂载）命中墓碑直接拒——否则墓碑只挡水合挡不住重进会话复活
    if (opts?.auto && tombstoneIds(currentConvKey()).has(artifact.id)) return
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
    // 墓碑过滤：被移除的产物不再水合复活（刷新/重进不复活）
    const tomb = tombstoneIds(currentConvKey())
    const survivors = artifacts.filter((a) => !tomb.has(a.id))
    if (survivors.length === 0) return
    set((s) => {
      const newArtifacts = { ...s.artifacts }
      const newOrder = [...s.artifactOrder]
      for (const a of survivors) {
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

  removeArtifact: (id) => {
    // 先记墓碑：即使当前不在列表，也阻止后续水合/重进复活
    addTombstone(currentConvKey(), id)

    set((s) => {
      if (!(id in s.artifacts) && s.currentArtifactId !== id) return {}

      const nextArtifacts = { ...s.artifacts }
      delete nextArtifacts[id]
      const nextOrder = s.artifactOrder.filter((oid) => oid !== id)

      const patch: Partial<ArtifactDockState> = {
        artifacts: nextArtifacts,
        artifactOrder: nextOrder,
      }
      // 移除的正是当前预览 → 按 close 语义关掉预览
      if (s.currentArtifactId === id) {
        patch.isOpen = false
        patch.currentArtifactId = null
      }
      return patch
    })
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

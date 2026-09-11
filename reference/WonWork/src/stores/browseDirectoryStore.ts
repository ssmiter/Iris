import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * browseDirectoryStore — 「浏览目录浮层窗口」纯 UI 状态（2026-09-04 拍板形态）。
 *
 * 纯浏览层：不动语义层（登记根/文件原语/cwd/facts 一律不碰）。
 * 双层目录粒度：
 * - 全局层 globalPath：用户自由浏览的位置，持久化，切会话/重启不丢失、不强行复原；
 * - 会话层：本会话项目目录。2026-09-09 二阶段起唯一事实源=会话记录 ProjectPath 列
 *   （后端 Local SQLite / Standalone IndexedDB），由 conversationStore 承载；
 *   本 store 的 conversationPaths 表退役为「迁移数据源」——浏览窗口打开时一次性
 *   搬迁进后端后清空，不再写入。
 * 窗口 header 的切换按钮在两层之间切换显示根（切回全局时停留在用户此前浏览的子目录）。
 *
 * 窗口几何（位置/尺寸）也持久化——记住上次位置，宽屏默认更宽。
 */

export type BrowseLayer = 'global' | 'conversation'

export interface BrowseWindowRect {
  x: number
  y: number
  width: number
  height: number
}

/** 默认窗口尺寸：宽屏下取 1100×680；落点避开右侧坞区（ArtifactDock 固定右 400px z-70，
 *  坞开会盖住窗口右部——默认往左让 440px，用户可自行拖走，位置持久化） */
export function defaultWindowRect(): BrowseWindowRect {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const width = Math.max(640, Math.min(1100, Math.floor(vw * 0.62)))
  const height = Math.max(420, Math.min(680, Math.floor(vh * 0.78)))
  return {
    x: Math.max(8, vw - width - 440),
    y: Math.max(8, vh - height - 48),
    width,
    height,
  }
}

/** 规范化路径：反斜杠统一为正斜杠、去掉末尾斜杠（保留盘符根如 E:/）、盘符大写归一
 * （E:/a 与 e:/a 是同一目录——不归一会在 pin 去重/选中态/面包屑被当两条路径） */
export function normalizeBrowsePath(p: string): string {
  let s = p.trim().replace(/\\/g, '/')
  while (s.length > 3 && s.endsWith('/')) s = s.slice(0, -1)
  s = s.replace(/^([a-z]):/, (m, d: string) => d.toUpperCase() + ':')
  return s || '/workspace'
}

/** 从 store 的 conversationPaths 表移除某会话的项目目录（删会话时清理指针，防表无限膨胀；
 *  只删"指向哪个路径"的映射条目，磁盘上的目录/产物本身不动。
 *  2026-09-09 二阶段：该表已退役为迁移数据源，此函数只防迁移前残留继续膨胀） */
export function removeConversationBrowsePath(conversationId: string | number): void {
  useBrowseDirectoryStore.setState((s) => {
    const key = String(conversationId)
    if (!(key in s.conversationPaths)) return s
    const next = { ...s.conversationPaths }
    delete next[key]
    return { conversationPaths: next }
  })
}

interface BrowseDirectoryState {
  // ── 窗口显隐 ──
  isOpen: boolean
  /** 最小化回胶囊条（窗口收起、胶囊可点回） */
  minimized: boolean
  rect: BrowseWindowRect

  // ── 双层目录 ──
  /** 全局层：用户自由浏览的当前位置（记住子目录，不复原）。
   *  缺省落 /computer（2026-09-09 拍板）：盘符总览+最近项目是面板的"家"，
   *  项目/盘符一眼可达；持久化用户后续位置不受缺省影响 */
  globalPath: string
  /** 会话层旧指针表（已退役，2026-09-09）：仅作一次性迁移数据源，迁移后清空，不再写入 */
  conversationPaths: Record<string, string>
  /** 当前显示层（会话内存态，不持久化——打开时默认全局层，零理解成本） */
  activeLayer: BrowseLayer

  // ── Actions ──
  open: () => void
  close: () => void
  minimize: () => void
  toggle: () => void
  setRect: (rect: BrowseWindowRect) => void

  /** 全局层导航（用户在窗口里点目录） */
  setGlobalPath: (path: string) => void
  /** 直接设置显示层（二阶段：是否有会话根由组件侧从 conversationStore 判定后调用） */
  setActiveLayer: (layer: BrowseLayer) => void
  /** 旧指针表迁移完成后清空（2026-09-09 二阶段一次性迁移配套） */
  clearConversationPaths: () => void
}

export const useBrowseDirectoryStore = create<BrowseDirectoryState>()(
  persist(
    (set, get) => ({
      isOpen: false,
      minimized: false,
      rect: defaultWindowRect(),

      globalPath: '/computer',
      conversationPaths: {},
      activeLayer: 'global',

      open: () => set({ isOpen: true, minimized: false }),
      close: () => set({ isOpen: false, minimized: false }),
      minimize: () => set({ minimized: true }),
      toggle: () => {
        const { isOpen, minimized } = get()
        if (isOpen && !minimized) set({ isOpen: false })
        else set({ isOpen: true, minimized: false })
      },
      setRect: (rect) => set({ rect }),

      setGlobalPath: (path) => set({ globalPath: normalizeBrowsePath(path) }),

      setActiveLayer: (layer) => set({ activeLayer: layer }),
      clearConversationPaths: () => set({ conversationPaths: {} }),
    }),
    {
      name: 'wonclaw-browse-directory',
      partialize: (state) => ({
        rect: state.rect,
        globalPath: state.globalPath,
        conversationPaths: state.conversationPaths,
      }),
    }
  )
)

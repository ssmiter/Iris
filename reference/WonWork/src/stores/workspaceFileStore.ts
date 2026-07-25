import { create } from 'zustand'
import type { WorkspaceFileMetadata } from '@/types/mescli'
import type { FileEntry } from '@/services/fileSystem'
import {
  getAllFiles,
  readFile as vfsReadFile,
  deleteFile as vfsDeleteFile,
  scanWorkspaceFiles,
} from '@/services/fileSystem'
import { getWorkspaceAdapter } from '@/services/workspaceAdapters'
import { workspaceApi } from '@/api/client'
import {
  getWorkspaceState,
  initWorkspace,
  pickWorkspace,
  disconnectWorkspace,
} from '@/utils/workspaceStorage'

export interface FileNode {
  path: string
  name: string
  type: 'file' | 'directory'
  size?: number
  updatedAt?: string
  source?: string
  mimeType?: string
  children?: FileNode[]
}

interface WorkspaceFileState {
  entries: FileEntry[]
  tree: FileNode[]
  isLoading: boolean
  error: string | null
  isConnected: boolean
  isFallbackMode: boolean
  workspacePath: string | null
  expandedPaths: Set<string>
  selectedPath: string | null
  previewContent: string | null
  previewPath: string | null

  loadFiles: () => Promise<void>
  refresh: () => Promise<void>
  init: () => Promise<void>
  connectWorkspace: () => Promise<void>
  disconnectWorkspace: () => Promise<void>
  toggleExpanded: (path: string) => void
  expandPath: (path: string) => void
  collapsePath: (path: string) => void
  selectPath: (path: string | null) => void
  previewFile: (path: string) => Promise<void>
  closePreview: () => void
  deleteFile: (path: string) => Promise<void>
  importBackendFiles: (files: WorkspaceFileMetadata[]) => void
}

function buildTree(entries: FileEntry[]): FileNode[] {
  const root: FileNode = {
    path: '/workspace',
    name: 'workspace',
    type: 'directory',
    children: [],
  }
  const nodeMap = new Map<string, FileNode>([['/workspace', root]])

  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean)
    if (parts.length === 0 || parts[0] !== 'workspace') continue

    let current = root
    for (let i = 1; i < parts.length; i++) {
      const name = parts[i]
      const isLast = i === parts.length - 1
      const path = '/' + parts.slice(0, i + 1).join('/')

      let node = nodeMap.get(path)
      if (!node) {
        node = {
          path,
          name,
          type: isLast ? 'file' : 'directory',
          ...(isLast
            ? { size: entry.size, updatedAt: entry.updatedAt, source: entry.source, mimeType: entry.mimeType }
            : { children: [] }),
        }
        nodeMap.set(path, node)
        current.children!.push(node)
      } else if (isLast) {
        node.size = entry.size
        node.updatedAt = entry.updatedAt
      }

      current = node
    }
  }

  sortChildren(root)
  return root.children || []
}

function sortChildren(node: FileNode): void {
  if (!node.children) return
  node.children.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name)
    return a.type === 'directory' ? -1 : 1
  })
  node.children.forEach(sortChildren)
}

function syncConnectionState(set: (fn: (state: WorkspaceFileState) => Partial<WorkspaceFileState>) => void): void {
  const state = getWorkspaceState()
  set(() => ({
    isConnected: state.isConnected,
    isFallbackMode: state.isFallbackMode,
    workspacePath: state.workspacePath,
  }))
}

// MESCLI（backend）模式下后端工作区天然可用、无需连接动作，
// 直接置为已连接（与 skillStore 对非 Standalone 分支的兜底一致）。
// 展示路径从后端 /api/workspace/info 取已解析的根目录，取不到时回退友好标签。
function setBackendConnectionState(set: (fn: (state: WorkspaceFileState) => Partial<WorkspaceFileState>) => void): void {
  set(() => ({
    isConnected: true,
    isFallbackMode: false,
    workspacePath: '安装目录\\workspace',
  }))
  workspaceApi
    .info()
    .then((res) => {
      if (res?.rootPath) {
        set(() => ({ workspacePath: res.rootPath }))
      }
    })
    .catch(() => {
      // 保持回退标签
    })
}

function isBackendWorkspace(): boolean {
  return getWorkspaceAdapter().kind === 'backend'
}

export const useWorkspaceFileStore = create<WorkspaceFileState>((set, get) => ({
  entries: [],
  tree: [],
  isLoading: false,
  error: null,
  isConnected: false,
  isFallbackMode: false,
  workspacePath: null,
  expandedPaths: new Set(['/workspace']),
  selectedPath: null,
  previewContent: null,
  previewPath: null,

  init: async () => {
    if (isBackendWorkspace()) {
      // MESCLI 模式下后端 Workspace 是权威源，不需要本地 File System Access 句柄
      setBackendConnectionState(set)
    } else {
      try {
        await initWorkspace()
      } catch (err) {
        console.warn('[workspaceFileStore] initWorkspace failed:', err)
      }
      syncConnectionState(set)
      try {
        await scanWorkspaceFiles()
      } catch (err) {
        console.warn('[workspaceFileStore] scanWorkspaceFiles failed:', err)
      }
    }
    await get().loadFiles()
  },

  loadFiles: async () => {
    set({ isLoading: true, error: null })
    try {
      const entries = await getAllFiles()
      const tree = buildTree(entries)
      set({ entries, tree, isLoading: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '加载工作区文件失败'
      console.error('[workspaceFileStore] loadFiles error:', err)
      set({ error: msg, isLoading: false })
    }
  },

  refresh: async () => {
    if (isBackendWorkspace()) {
      setBackendConnectionState(set)
    } else {
      syncConnectionState(set)
      try {
        await scanWorkspaceFiles()
      } catch (err) {
        console.warn('[workspaceFileStore] refresh scan failed:', err)
      }
    }
    await get().loadFiles()
  },

  connectWorkspace: async () => {
    if (isBackendWorkspace()) {
      // MESCLI 模式下后端目录已连接，点击即刷新
      await get().refresh()
      return
    }

    try {
      await pickWorkspace()
      syncConnectionState(set)
      try {
        await scanWorkspaceFiles()
      } catch (err) {
        console.warn('[workspaceFileStore] connect scan failed:', err)
      }
      await get().loadFiles()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '连接工作区失败'
      console.error('[workspaceFileStore] connectWorkspace error:', err)
      set({ error: msg })
    }
  },

  disconnectWorkspace: async () => {
    if (isBackendWorkspace()) {
      // backend 模式工作区由后端托管，不可断开，保持已连接态
      setBackendConnectionState(set)
      return
    }
    await disconnectWorkspace()
    syncConnectionState(set)
  },

  toggleExpanded: (path) => {
    set((s) => {
      const next = new Set(s.expandedPaths)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return { expandedPaths: next }
    })
  },

  expandPath: (path) => {
    set((s) => {
      const next = new Set(s.expandedPaths)
      next.add(path)
      return { expandedPaths: next }
    })
  },

  collapsePath: (path) => {
    set((s) => {
      const next = new Set(s.expandedPaths)
      next.delete(path)
      return { expandedPaths: next }
    })
  },

  selectPath: (path) => set({ selectedPath: path }),

  previewFile: async (path) => {
    set({ previewPath: path, previewContent: '加载中...' })
    try {
      const entry = await vfsReadFile(path)
      if (!entry) {
        set({ previewContent: '文件不存在或已被删除' })
        return
      }
      // 控制预览长度，避免大文件卡死 UI
      const maxPreviewChars = 5000
      const content =
        entry.content.length > maxPreviewChars
          ? entry.content.slice(0, maxPreviewChars) +
            `\n\n[预览已截断，共 ${entry.content.length} 字符]`
          : entry.content
      set({ previewContent: content })
    } catch (err) {
      const msg = err instanceof Error ? err.message : '读取文件失败'
      set({ previewContent: msg })
    }
  },

  closePreview: () => set({ previewPath: null, previewContent: null, selectedPath: null }),

  deleteFile: async (path) => {
    try {
      await vfsDeleteFile(path)
      await get().loadFiles()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '删除文件失败'
      console.error('[workspaceFileStore] deleteFile error:', err)
      set({ error: msg })
    }
  },

  importBackendFiles: (files) => {
    if (!files?.length) return

    set((state) => {
      const byPath = new Map(state.entries.map((e) => [e.path, e]))

      for (const file of files) {
        if (!file?.path) continue
        const existing = byPath.get(file.path)
        const now = new Date().toISOString()
        const parts = file.path.split('/').filter(Boolean)
        const parentPath = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/workspace'

        const entry: FileEntry = {
          path: file.path,
          content: existing?.content || '',
          parentPath,
          createdAt: file.createdAt || existing?.createdAt || now,
          updatedAt: file.createdAt || now,
          size: file.sizeBytes ?? existing?.size ?? 0,
          source: file.sourceTool || existing?.source || 'backend',
          mimeType: file.mimeType || existing?.mimeType,
        }
        byPath.set(file.path, entry)
      }

      const entries = Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path))
      return {
        entries,
        tree: buildTree(entries),
      }
    })
  },
}))

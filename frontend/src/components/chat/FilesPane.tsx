/**
 * FilesPane — 工作区文件树面板（坞内「工作区」tab 内容）
 *
 * 完全复用 `useWorkspaceFileStore`：
 * - tree 渲染目录树
 * - expandedPaths 控制展开/折叠
 * - selectPath / expandPath 定位文件
 * - previewFile 预览文本文件
 *
 * 定位模式（locateArtifactId 非空）：自动展开父目录并高亮目标文件。
 */

import { memo, useEffect, useRef, useCallback, useMemo, useState } from 'react'
import { Copy, Download, Trash2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useWorkspaceFileStore, type FileNode } from '@/stores/workspaceFileStore'
import { getFileIconInfo } from '@/utils/fileIcon'
import { formatFileSize } from '@/utils/formatFileSize'
import { useArtifactDockStore } from '@/stores/artifactDockStore'
import { fileNodeToArtifact } from '@/types/artifactDock'
import { workspaceApi } from '@/api/client'

/** 复制路径：navigator.clipboard + toast（文案复用 workspaceFilesPanel.copied/copyFailed） */
async function handleCopyPath(path: string, t: (k: string) => string) {
  try {
    await navigator.clipboard.writeText(path)
    toast.success(t('chat.workspaceFilesPanel.copied'))
  } catch {
    toast.error(t('chat.workspaceFilesPanel.copyFailed'))
  }
}

/** 下载：统一走后端下载端点（a 标签法），Standalone 下 downloadUrl 原样透传路径 */
function handleDownload(path: string) {
  const a = document.createElement('a')
  a.href = workspaceApi.downloadUrl(path)
  a.download = path.split('/').pop() || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/** 工作区文件树过滤：文件名匹配，目录保留有命中子项的分支（语义照搬旧面板 filterTree） */
function filterTree(nodes: FileNode[], query: string): FileNode[] {
  const q = query.toLowerCase()
  return nodes
    .map((node) => {
      if (node.type === 'directory') {
        const filteredChildren = node.children ? filterTree(node.children, q) : []
        const selfMatch = node.name.toLowerCase().includes(q)
        if (selfMatch || filteredChildren.length > 0) {
          return { ...node, children: filteredChildren }
        }
        return null
      }
      return node.name.toLowerCase().includes(q) ? node : null
    })
    .filter((n): n is FileNode => n !== null)
}

/** 单个树节点 */
function TreeNode({
  node,
  depth,
  locatePath,
  pathToArtifactId,
}: {
  node: FileNode
  depth: number
  locatePath: string | null
  pathToArtifactId: Map<string, string>
}) {
  const expandedPaths = useWorkspaceFileStore((s) => s.expandedPaths)
  const selectedPath = useWorkspaceFileStore((s) => s.selectedPath)
  const toggleExpanded = useWorkspaceFileStore((s) => s.toggleExpanded)
  const selectPath = useWorkspaceFileStore((s) => s.selectPath)
  const setCurrent = useArtifactDockStore((s) => s.setCurrent)
  const setTab = useArtifactDockStore((s) => s.setTab)
  const registerArtifact = useArtifactDockStore((s) => s.registerArtifact)
  const deleteFile = useWorkspaceFileStore((s) => s.deleteFile)
  const { t } = useTranslation()

  const isDir = node.type === 'directory'
  const isExpanded = expandedPaths.has(node.path)
  const isSelected = selectedPath === node.path
  const isLocated = locatePath === node.path && node.type === 'file'
  const iconInfo = isDir ? { icon: null, colorClass: '', label: t('chat.filesPane.directory') } : getFileIconInfo(node.name)

  // 检查该文件是否有对应的产物
  const artifactId = !isDir ? pathToArtifactId.get(node.path) : undefined

  const handleClick = useCallback(() => {
    if (isDir) {
      toggleExpanded(node.path)
    } else {
      selectPath(node.path)
      if (artifactId) {
        // 已注册产物（present_artifact 或此前浏览合成）→ 直接打开预览
        setCurrent(artifactId)
        setTab('preview')
      } else {
        // 普通工作区文件 → 合成同构 FileCardArtifact 注册进坞，
        // 与呈现入口共用注册表/胶片条/预览面板（产物中心模型）
        const synthesized = fileNodeToArtifact(node)
        registerArtifact(synthesized)
        setCurrent(synthesized.id)
        setTab('preview')
      }
    }
  }, [isDir, node, artifactId, toggleExpanded, selectPath, setCurrent, setTab, registerArtifact])

  return (
    <div>
      <div
        className={`wf-tree-row${isSelected ? ' selected' : ''}${isLocated ? ' located' : ''}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') handleClick()
        }}
      >
        <span className="wf-tree-icon">
          {isDir ? (isExpanded ? '📂' : '📁') : null}
          {!isDir && iconInfo.icon && <iconInfo.icon size={14} className={iconInfo.colorClass} />}
          {!isDir && !iconInfo.icon && <span>📄</span>}
        </span>
        <span className="wf-tree-name">{node.name}{isDir ? '/' : ''}</span>
        {!isDir && node.size != null && (
          <span className="wf-tree-size">{formatFileSize(node.size)}</span>
        )}
        {!isDir && (
          <span className="wf-tree-actions">
            <button
              className="wf-tree-act"
              title={t('chat.workspaceFilesPanel.copyPath')}
              aria-label={t('chat.workspaceFilesPanel.copyPath')}
              onClick={(e) => {
                e.stopPropagation()
                handleCopyPath(node.path, t)
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Copy size={12} />
            </button>
            <button
              className="wf-tree-act"
              title={t('chat.workspaceFilesPanel.download')}
              aria-label={t('chat.workspaceFilesPanel.download')}
              onClick={(e) => {
                e.stopPropagation()
                handleDownload(node.path)
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Download size={12} />
            </button>
            <button
              className="wf-tree-act wf-tree-act-danger"
              title={t('chat.workspaceFilesPanel.delete')}
              aria-label={t('chat.workspaceFilesPanel.delete')}
              onClick={(e) => {
                e.stopPropagation()
                if (confirm(t('chat.workspaceFilesPanel.deleteConfirm', { name: node.name }))) {
                  void deleteFile(node.path)
                }
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Trash2 size={12} />
            </button>
          </span>
        )}
      </div>
      {isDir && isExpanded && node.children && (
        <div className="wf-tree-children">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              locatePath={locatePath}
              pathToArtifactId={pathToArtifactId}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── FilesPane ─────────────────────────────────────────────

export const FilesPane = memo(function FilesPane({
  locateArtifactId,
}: {
  locateArtifactId?: string | null
}) {
  const tree = useWorkspaceFileStore((s) => s.tree)
  const expandPath = useWorkspaceFileStore((s) => s.expandPath)
  const selectPath = useWorkspaceFileStore((s) => s.selectPath)
  const artifacts = useArtifactDockStore((s) => s.artifacts)
  const scrolledRef = useRef(false)
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  // 2026-09-04 实测修复：本面板此前只读 tree 不触发加载，init() 全仓仅设置页调用——
  // 没进过设置页的用户打开坞内工作区 tab 永远空树。挂载时树空则自加载一次。
  const loadFiles = useWorkspaceFileStore((s) => s.loadFiles)
  const isLoadingFiles = useWorkspaceFileStore((s) => s.isLoading)
  const autoLoadTriedRef = useRef(false)
  useEffect(() => {
    if (autoLoadTriedRef.current || tree.length > 0 || isLoadingFiles) return
    autoLoadTriedRef.current = true
    void loadFiles()
  }, [tree.length, isLoadingFiles, loadFiles])

  // 建立 path → artifactId 映射（用于文件树点击联动）
  const pathToArtifactId = useMemo(() => {
    const map = new Map<string, string>()
    for (const artifact of Object.values(artifacts)) {
      map.set(artifact.path, artifact.id)
    }
    return map
  }, [artifacts])

  // 工作区内搜索过滤：文件名匹配，目录保留有命中子项的分支
  const filteredTree = useMemo(
    () => (query.trim() ? filterTree(tree, query.trim()) : tree),
    [tree, query],
  )

  // 定位逻辑：展开父目录 + 选中 + 滚动
  useEffect(() => {
    if (!locateArtifactId || scrolledRef.current) return
    const artifact = artifacts[locateArtifactId]
    if (!artifact) return

    // 逐级展开路径
    const segments = artifact.path.replace(/^\//, '').split('/')
    let accumulated = ''
    for (let i = 0; i < segments.length - 1; i++) {
      accumulated += '/' + segments[i]
      expandPath(accumulated)
    }
    // 选中
    selectPath(artifact.path)

    // 滚动到目标（延迟等 DOM 渲染）
    scrolledRef.current = true
    setTimeout(() => {
      const el = document.querySelector('.wf-tree-row.located')
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    }, 120)
  }, [locateArtifactId, artifacts, expandPath, selectPath])

  // 切换 locate target 时重置滚动标记
  useEffect(() => {
    scrolledRef.current = false
  }, [locateArtifactId])

  return (
    <div className="wf-files-pane">
      {/* 工作区内搜索过滤 */}
      <div className="wf-files-search">
        <Search size={13} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('chat.workspaceFilesPanel.searchPlaceholder')}
        />
      </div>

      <div className="wf-ws-path">{t('chat.filesPane.workspacePath')}</div>

      <div className="wf-tree">
        {filteredTree.length === 0 ? (
          <div className="wf-tree-empty">
            {query.trim()
              ? t('chat.workspaceFilesPanel.noSearchResults')
              : t('chat.workspaceFilesPanel.emptyTitle')}
          </div>
        ) : (
          filteredTree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              locatePath={
                locateArtifactId ? artifacts[locateArtifactId]?.path || null : null
              }
              pathToArtifactId={pathToArtifactId}
            />
          ))
        )}
      </div>
    </div>
  )
})

/**
 * BrowseDirectoryWindow — 「浏览目录」浮层窗口（2026-09-04 拍板形态，places 版；
 * 2026-09-09 二阶段：从「读」扩展到「写」）。
 *
 * 纯浏览层 UI：不动语义层（登记根/文件原语/cwd/facts 一律不碰），
 * 数据走 workspaceApi.list 懒加载（登记闸在后端，未登记=灰态+授权按钮，不弹审批卡）。
 * 二阶段写操作（打开/重命名/新建/删除）全部走 browse=true 面板用户通道——
 * 与 list/reveal 同款只跳登记闸（用户操作自己的磁盘不是授权泄露），模型侧 409 挑战语义不变。
 *
 * 形态拍板（模拟一个完整但简单的操作系统虚拟文件体验）：
 * - 浮层窗口：标题栏拖拽、右下角把柄缩放、最小化收为右下角胶囊、Esc 仅窗口聚焦时关闭；
 * - 左侧 places 栏（Linux 文件管理器式位点）：工作区（默认落点）/ 项目（会话根，
 *   模型经 set_browse_directory 设置）/ 我的电脑（盘符枚举，"/computer" 虚拟层）
 *   + 最近项目区（二阶段替代收藏：会话记录 ProjectPath 列 GROUP BY 派生，
 *   点项目=跳目录，点会话数=看该项目下有哪些会话，"+"=当前目录下新建项目文件夹并绑定本会话）；
 * - 「我的电脑」= 大图标网格（对齐 Windows 此电脑直觉：容量条+可用空间）；
 *   进入具体目录后 = 列表（名称/大小/修改时间）；
 * - 全局层记住浏览位置（写 globalPath），会话层往里逛只走本地游标不回写项目根；
 * - 文件点击=右侧预览（文本行切片 / 图片内联 / 二进制给落点动作）；
 * - 二阶段写交互（对齐资源管理器直觉，不克隆全部功能）：
 *   双击文件=系统默认程序打开（.docx→Word）；右键菜单（打开/复制路径/重命名/删除/
 *   新建/设为项目目录）；行内命名（Enter 提交 Esc 取消，文件预选主名）；F2/Delete 快捷键；
 *   删除前明确确认；当前后端使用受边界保护的真实删除，hover 行内复制路径按钮。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { normalizeMarkdown } from '@/utils/markdownNormalizer'
import { ZoomableImage } from '@/components/chat/PreviewPane'
import {
  ArrowLeft,
  ArrowUp,
  Briefcase,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FilePlus2,
  FileQuestion,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Loader2,
  MessageSquare,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiError, workspaceApi } from '@/api/client'
import type { WorkspaceDrive, WorkspaceNode } from '@/types/mescli'
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from '@/components/common/ContextMenu'
import {
  normalizeBrowsePath,
  useBrowseDirectoryStore,
  type BrowseWindowRect,
} from '@/stores/browseDirectoryStore'
import { useConversationStore } from '@/stores/conversationStore'
import { useChatStore } from '@/stores/chatStore'
import { addRule, isDirectoryAllowed, setBackendRegisteredRoots } from '@/agent/permissionRules'
import { getFileIconInfo } from '@/utils/fileIcon'
import { formatFileSize } from '@/utils/formatFileSize'

const MIN_WIDTH = 560
const MIN_HEIGHT = 360
/** 文本预览行数上限（read 端点行切片，大文件不整读） */
const PREVIEW_LINES = 400
/** 「我的电脑」虚拟层路径（前端合成，不经后端路径解析） */
const COMPUTER_PATH = '/computer'

/** 目录加载结果：就绪 / 盘符总览（/computer 虚拟层）/ 普通失败。
 *  不再有 challenge 态（2026-09-08 拍板）：浏览=用户本人动作，browse 通道跳过登记闸，
 *  面板恒可进盘；"授权给助手"是非阻断提示条（见列表区 grantHint），不是浏览前置条件 */
type ListState =
  | { kind: 'ready'; nodes: WorkspaceNode[] }
  | { kind: 'drives'; drives: WorkspaceDrive[] }
  | { kind: 'error'; message: string }

interface PreviewState {
  loading: boolean
  /** isText=true 时的文本内容（前 PREVIEW_LINES 行） */
  text?: string
  truncated?: boolean
  /** 图片走 preview 端点内联展示 */
  imageUrl?: string
  /** 二进制/Office：给大小+落点动作，不假装能预览 */
  binary?: { sizeBytes: number; mimeType?: string }
  error?: string
}

/** 从 ApiError 中识别目录登记挑战（409 + error_code），非挑战返回 null */
function parseChallenge(err: unknown): { path: string; directory: string; exists: boolean } | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null
  const data = err.data as { error_code?: string; path?: string; exists?: boolean; directory?: string | null } | undefined
  if (data?.error_code !== 'directory_not_registered' || typeof data.path !== 'string') return null
  return {
    path: data.path,
    // directory（2026-09-04 后端已算好"建议登记目录"，文件取父目录）；缺省回退原 path
    directory: typeof data.directory === 'string' && data.directory ? data.directory : data.path,
    exists: data.exists !== false,
  }
}

/** 父目录：盘符根上溯到 /computer 虚拟层，/computer 与 /workspace 各到顶即止 */
function parentDir(p: string): string | null {
  if (p === COMPUTER_PATH || p === '/workspace') return null
  if (/^[A-Za-z]:\/?$/.test(p)) return COMPUTER_PATH
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return null // /workspace 之上没有意义
  const parent = p.slice(0, idx)
  return /^[A-Za-z]:$/.test(parent) ? parent + '/' : parent
}

/** 面包屑段：/computer 与 /workspace 单段；物理路径前置「我的电脑」段再按段累计 */
function breadcrumbSegments(p: string, computerLabel: string): { label: string; path: string }[] {
  if (p === COMPUTER_PATH) return [{ label: computerLabel, path: COMPUTER_PATH }]
  if (p === '/workspace') return [{ label: 'workspace', path: '/workspace' }]
  const parts = p.split('/').filter(Boolean)
  const segs: { label: string; path: string }[] = [{ label: computerLabel, path: COMPUTER_PATH }]
  for (let i = 0; i < parts.length; i++) {
    // 盘符段（E:）的路径要带尾斜杠才是合法根
    const path = i === 0 && /^[A-Za-z]:$/.test(parts[0])
      ? parts[0] + '/'
      : parts.slice(0, i + 1).join('/')
    segs.push({ label: parts[i], path })
  }
  return segs
}

/** 窗口矩形钳制：保证标题栏始终可抓取（不出视口顶/右） */
function clampRect(r: BrowseWindowRect): BrowseWindowRect {
  const vw = window.innerWidth
  const vh = window.innerHeight
  return {
    x: Math.min(Math.max(r.x, 160 - r.width), vw - 168),
    y: Math.min(Math.max(r.y, 8), vh - 96),
    width: Math.max(MIN_WIDTH, Math.min(r.width, vw - 16)),
    height: Math.max(MIN_HEIGHT, Math.min(r.height, vh - 16)),
  }
}

/** 路径的展示名（末段；/computer 与盘符根特殊处理） */
function placeName(p: string, computerLabel: string): string {
  if (p === COMPUTER_PATH) return computerLabel
  if (p === '/workspace') return 'workspace'
  return p.split('/').filter(Boolean).pop() ?? p
}

/** 目录+名字拼接（盘符根 E:/ 已带尾斜杠，不能再补） */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

/** Windows 文件名非法字符（与后端 Path.GetInvalidFileNameChars 同语义的前端预判，少一次往返） */
const INVALID_NAME_CHARS = /[\\/:*?"<>|]/

/**
 * 行内命名输入框（重命名/新建共用，Windows 资源管理器同款交互）：
 * Enter 提交、Esc 取消、失焦提交；文件预选主名（不含扩展名），文件夹全选。
 */
function InlineNameInput({
  initial,
  isFile,
  onCommit,
  onCancel,
}: {
  initial: string
  isFile: boolean
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  // 提交/取消幂等闸：Esc 取消后输入框卸载触发 blur，不能再走一次提交
  const doneRef = useRef(false)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (isFile) {
      const dot = initial.lastIndexOf('.')
      el.setSelectionRange(0, dot > 0 ? dot : initial.length)
    } else {
      el.select()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const commit = () => {
    if (doneRef.current) return
    doneRef.current = true
    onCommit(value)
  }
  const cancel = () => {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }

  return (
    <input
      ref={inputRef}
      className="wf-browse-name-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') cancel()
      }}
      onBlur={commit}
    />
  )
}

export const BrowseDirectoryWindow = memo(function BrowseDirectoryWindow() {
  const { t } = useTranslation()
  const isOpen = useBrowseDirectoryStore((s) => s.isOpen)
  const minimized = useBrowseDirectoryStore((s) => s.minimized)
  const rect = useBrowseDirectoryStore((s) => s.rect)
  const setRect = useBrowseDirectoryStore((s) => s.setRect)
  const globalPath = useBrowseDirectoryStore((s) => s.globalPath)
  const setGlobalPath = useBrowseDirectoryStore((s) => s.setGlobalPath)
  const activeLayer = useBrowseDirectoryStore((s) => s.activeLayer)
  const setActiveLayer = useBrowseDirectoryStore((s) => s.setActiveLayer)
  const close = useBrowseDirectoryStore((s) => s.close)
  const minimize = useBrowseDirectoryStore((s) => s.minimize)
  const open = useBrowseDirectoryStore((s) => s.open)

  const convId = useConversationStore((s) => s.currentConversationId)
  const convKey = convId != null ? String(convId) : null
  const conversations = useConversationStore((s) => s.conversations)
  const conversationsLoaded = useConversationStore((s) => s.conversationsLoaded)
  // 旧 localStorage 指针表（已退役，仅作迁移数据源+迁移窗口期的显示兜底）
  const legacyPaths = useBrowseDirectoryStore((s) => s.conversationPaths)
  // 会话层项目根（2026-09-09 二阶段）：唯一事实源=会话记录 ProjectPath 列
  // （用户「设为项目目录」/模型 set_browse_directory/新建项目三入口同写一列）。
  // 订阅 conversations 记录：模型在窗口开着时改绑定，会话列表项变化触发重渲染
  const convRoot = useMemo(() => {
    if (convId == null) return null
    const bound = conversations.find((c) => c.id === convId)?.projectPath
    const legacy = legacyPaths[String(convId)] ?? null
    const p = bound ?? legacy
    return p ? normalizeBrowsePath(p) : null
  }, [conversations, convId, legacyPaths])

  // 一次性迁移（二阶段）：旧指针表逐条搬进会话记录 ProjectPath 列，完事清空。
  // 等会话列表就位再动手（conversationsLoaded）；会话已删的条目 PUT 落空（false）照清；
  // 已有结构化绑定的条目跳过（指针是旧副本，不回盖新值）
  const migrationRanRef = useRef(false)
  useEffect(() => {
    if (!conversationsLoaded || migrationRanRef.current) return
    const entries = Object.entries(legacyPaths)
    if (entries.length === 0) return
    migrationRanRef.current = true
    void (async () => {
      const store = useConversationStore.getState()
      for (const [key, path] of entries) {
        const id = Number(key)
        if (!Number.isFinite(id)) continue
        if (store.conversations.find((c) => c.id === id)?.projectPath) continue
        await store.setConversationProject(id, path)
      }
      useBrowseDirectoryStore.getState().clearConversationPaths()
    })()
  }, [conversationsLoaded, legacyPaths])

  // 最近项目（收藏位替代，二阶段）：顶层会话按 ProjectPath GROUP BY——{路径, 会话数, 最近活跃}，
  // 按最近活跃倒序取前 8。项目是个派生概念：没有项目表，绑定关系即全部事实
  const recentProjects = useMemo(() => {
    const map = new Map<string, { path: string; count: number; last: string }>()
    for (const c of conversations) {
      if (!c.projectPath || c.parentConversationId != null) continue
      const p = normalizeBrowsePath(c.projectPath)
      const last = c.updatedAt ?? c.createdAt ?? ''
      const cur = map.get(p)
      if (!cur) map.set(p, { path: p, count: 1, last })
      else { cur.count++; if (last > cur.last) cur.last = last }
    }
    return [...map.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, 20)
  }, [conversations])

  // 会话层本地浏览游标：null=停在项目根；只在本窗口内存，切层/切会话/换根即复位
  // （会话根是"项目锚点"，用户往里逛不改写锚点本身）
  const [convNav, setConvNav] = useState<string | null>(null)
  useEffect(() => setConvNav(null), [convId, convRoot, activeLayer])

  // 会话层无根时如实回落全局层显示（侧栏切会话不触 browse store，根可能失效）
  const effectiveLayer = activeLayer === 'conversation' && convRoot ? 'conversation' : 'global'
  const currentDir = effectiveLayer === 'global' ? globalPath : (convNav ?? (convRoot as string))

  const [list, setList] = useState<ListState | null>(null)
  const [loading, setLoading] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [selected, setSelected] = useState<WorkspaceNode | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [authorizing, setAuthorizing] = useState(false)
  // ── 二阶段写操作态（2026-09-09）：右键菜单 / 行内重命名 / 行内新建 ──
  const [menu, setMenu] = useState<(ContextMenuState & { node: WorkspaceNode | null }) | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; isFile: boolean; initial: string } | null>(null)
  const [creating, setCreating] = useState<{ kind: 'file' | 'folder'; defaultName: string; bind?: boolean } | null>(null)
  // 项目会话视图（最近项目→点会话数进入）：非 null 时列表区改为该项目下的会话清单
  const [sessionsView, setSessionsView] = useState<string | null>(null)
  /** 项目会话清单：绑定到该路径的顶层会话，按最近活跃倒序 */
  const projectSessions = useMemo(() => {
    if (sessionsView == null) return []
    return conversations
      .filter((c) => c.projectPath != null && normalizeBrowsePath(c.projectPath) === sessionsView && c.parentConversationId == null)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }, [conversations, sessionsView])
  const windowRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // 列表/预览分栏比例（预览宽占比，拖中间分隔条调整；只在本窗口内存）
  const [previewRatio, setPreviewRatio] = useState(0.42)
  // 拖拽/缩放中的瞬时矩形（提交进 store 落 localStorage 只发生在 pointerup，拖动过程不刷持久化）
  const [liveRect, setLiveRect] = useState<BrowseWindowRect | null>(null)

  const isComputer = currentDir === COMPUTER_PATH

  // 授权提示条按目录 dismissed（会话内记忆，不持久化——重开应用再提醒一次是合理分寸，
  // 目录授权状态本身可能已变化）；2026-09-09 用户反馈"每个未授权目录都顶一条"冗余后的收敛
  const [dismissedHints, setDismissedHints] = useState<ReadonlySet<string>>(new Set())

  // 授权提示条可见性：仅「物理目录且未被模型可读集覆盖且未 dismissed」时出现；盘符根后端拒绝登记不显示。
  // reloadTick 进依赖：授权成功后 isDirectoryAllowed 读的模块级登记表已更新，强制重算
  const showGrantHint = useMemo(() => {
    void reloadTick
    if (isComputer) return false
    if (dismissedHints.has(currentDir)) return false
    if (!/^[A-Za-z]:\//.test(currentDir) && !currentDir.startsWith('\\\\')) return false
    if (/^[A-Za-z]:\/$/.test(currentDir)) return false
    return !isDirectoryAllowed(convKey, currentDir, [])
  }, [currentDir, isComputer, convKey, reloadTick, dismissedHints])

  /** 选中文本是不是 markdown（决定预览用渲染态还是纯文本等宽） */
  const selectedIsMarkdown = selected != null && /\.(md|markdown)$/i.test(selected.name)

  // ── 目录加载（懒加载单层；/computer 走盘符枚举；挑战→灰态授权，其余失败→错误态） ──
  // selected 只在导航（currentDir 变）时清——手动刷新/语言切换不清预览（刷新语义=再看一眼当前目录，
  // 用户选中的文件不在刷新后消失；文件被外部删了由下一次 read 失败如实报）
  const prevDirRef = useRef(currentDir)
  useEffect(() => {
    if (prevDirRef.current !== currentDir) {
      prevDirRef.current = currentDir
      setSelected(null)
      setPreview(null)
      // 换目录=行内编辑（重命名/新建）锚定的对象已不在场，一并收场；项目会话视图也退出
      setRenaming(null)
      setCreating(null)
      setMenu(null)
      setSessionsView(null)
    }
  }, [currentDir])

  useEffect(() => {
    if (!isOpen || minimized) return
    let stale = false
    setLoading(true)
    if (isComputer) {
      workspaceApi
        .drives()
        .then((res) => { if (!stale) setList({ kind: 'drives', drives: res.drives }) })
        .catch((err: unknown) => {
          if (!stale) setList({ kind: 'error', message: err instanceof Error ? err.message : t('browse.loadFailed') })
        })
        .finally(() => { if (!stale) setLoading(false) })
      return () => { stale = true }
    }
    workspaceApi
      .list(currentDir, false, true)
      .then((res) => {
        if (stale) return
        const sorted = [...res.nodes].sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        setList({ kind: 'ready', nodes: sorted })
      })
      .catch((err: unknown) => {
        if (stale) return
        setList({ kind: 'error', message: err instanceof Error ? err.message : t('browse.loadFailed') })
      })
      .finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
  }, [isOpen, minimized, currentDir, isComputer, reloadTick, t])

  // ── 文件预览（文本行切片 / 图片内联 / 二进制落点动作） ──
  useEffect(() => {
    if (!selected) return
    let stale = false
    setPreview({ loading: true })
    workspaceApi
      .read(selected.path, 1, PREVIEW_LINES, true)
      .then((res) => {
        if (stale) return
        if (res.isText && res.content !== undefined) {
          setPreview({
            loading: false,
            text: res.content,
            truncated: res.totalLines !== undefined && res.totalLines > PREVIEW_LINES,
          })
        } else if (res.mimeType?.startsWith('image/')) {
          setPreview({ loading: false, imageUrl: workspaceApi.previewUrl(selected.path, true) })
        } else {
          setPreview({ loading: false, binary: { sizeBytes: res.sizeBytes, mimeType: res.mimeType } })
        }
      })
      .catch((err: unknown) => {
        if (stale) return
        setPreview({ loading: false, error: err instanceof Error ? err.message : t('browse.loadFailed') })
      })
    return () => { stale = true }
  }, [selected, t])

  // ── Esc 关闭：仅窗口聚焦时（焦点在窗口内才算"在操作窗口"），
  //    不抢对话区自己的 Esc 消费者（斜杠菜单/审批卡等） ──
  useEffect(() => {
    if (!isOpen || minimized) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!windowRef.current?.contains(document.activeElement)) return
      close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isOpen, minimized, close])

  const navigateTo = useCallback(
    (path: string) => {
      const p = normalizeBrowsePath(path)
      if (effectiveLayer === 'global') setGlobalPath(p)
      else setConvNav(p)
    },
    [effectiveLayer, setGlobalPath]
  )

  /** places 栏跳转：全局位点（工作区/我的电脑/最近项目）先切回全局层再落点；
   *  项目位点切到会话层（无根时按钮侧已置灰防到达） */
  const jumpToPlace = useCallback(
    (place: 'workspace' | 'computer' | 'project' | string) => {
      setSessionsView(null)
      if (place === 'project') {
        if (convRoot) setActiveLayer('conversation')
        return
      }
      if (activeLayer === 'conversation') setActiveLayer('global')
      setGlobalPath(place === 'workspace' ? '/workspace' : place === 'computer' ? COMPUTER_PATH : place)
    },
    [activeLayer, convRoot, setActiveLayer, setGlobalPath]
  )

  const handleEnter = useCallback(
    (node: WorkspaceNode) => {
      if (node.kind === 'folder') navigateTo(node.path)
      else setSelected(node)
    },
    [navigateTo]
  )

  /** 授权给助手（2026-09-08 语义转向）：浏览不再需要授权（browse 通道直通），
   *  这里只做一件事——把当前目录登记进模型可读集。档位：本对话=会话层（后端内存，
   *  重启失效）；始终允许=持久层（registered-roots.json 跨进程）——与审批卡两档语义对齐。
   *  盘符根后端拒绝登记（C:\ 一进表目录闸形同虚设），提示条在盘符根不出现。 */
  const handleAuthorize = useCallback(async (scope: 'conversation' | 'longterm') => {
    if (authorizing) return
    setAuthorizing(true)
    try {
      if (convKey != null) {
        addRule({ kind: 'directory', pattern: currentDir, scope, conversationId: convKey })
      }
      const res = await workspaceApi.registerRoot(currentDir, scope === 'conversation' ? 'session' : undefined)
      if (res?.roots) setBackendRegisteredRoots([...res.roots, ...(res.sessionRoots ?? [])])
      setReloadTick((v) => v + 1)
      toast.success(t('browse.authorizeOk'))
    } catch (err) {
      toast.error(t('browse.authorizeFailed'))
      console.warn('[browse] 目录授权失败:', err)
    } finally {
      setAuthorizing(false)
    }
  }, [currentDir, authorizing, convKey, t])

  const handleReveal = useCallback(async (path: string) => {
    try {
      await workspaceApi.reveal(path, true)
    } catch (err) {
      // 未登记/未授权（409 挑战）与真失败分开：文案如实，不再一律"加载失败"
      toast.error(t(parseChallenge(err) ? 'browse.revealNotRegistered' : 'browse.loadFailed'))
      console.warn('[browse] reveal 失败:', err)
    }
  }, [t])

  const handleDownload = useCallback((path: string) => {
    const a = document.createElement('a')
    a.href = workspaceApi.downloadUrl(path, true)
    a.download = path.split('/').pop() || 'download'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [])

  // ── 二阶段：从「读」到「写」（2026-09-09）——目标=用户不必再切去系统资源管理器。
  //    全部走 browse=true 面板用户通道（与 list/reveal 同款只跳登记闸）；失败一律 toast 如实报 ──

  /** 双击/菜单「打开」：系统默认程序起（.docx→Word、.xlsx→Excel；目录=资源管理器） */
  const handleOpen = useCallback(async (path: string) => {
    try {
      await workspaceApi.open(path, true)
    } catch (err) {
      toast.error(t(parseChallenge(err) ? 'browse.revealNotRegistered' : 'browse.openFailed'))
      console.warn('[browse] open 失败:', err)
    }
  }, [t])

  const handleCopyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
      toast.success(t('browse.pathCopied'))
    } catch (err) {
      toast.error(t('browse.loadFailed'))
      console.warn('[browse] 复制路径失败:', err)
    }
  }, [t])

  /** 删除：文件与文件夹均先确认；递归删除只对文件夹显式开启，结果由后端如实回传。 */
  const handleDelete = useCallback(async (node: WorkspaceNode) => {
    if (!window.confirm(t('browse.deleteConfirm', { name: node.name }))) return
    try {
      await workspaceApi.delete(node.path, { recursive: node.kind === 'folder', browse: true })
      toast.success(t('browse.deleted'))
      if (selected?.path === node.path) {
        setSelected(null)
        setPreview(null)
      }
      setReloadTick((v) => v + 1)
    } catch (err) {
      toast.error(t(parseChallenge(err) ? 'browse.revealNotRegistered' : 'browse.deleteFailed'))
      console.warn('[browse] 删除失败:', err)
    }
  }, [selected, t])

  /** 行内重命名提交：空名/未改名静默收场；409=同名冲突如实提示 */
  const commitRename = useCallback(async (value: string) => {
    const target = renaming
    setRenaming(null)
    if (!target) return
    const name = value.trim()
    if (!name || name === target.initial) return
    if (INVALID_NAME_CHARS.test(name) || name === '.' || name === '..') {
      toast.error(t('browse.invalidName'))
      return
    }
    try {
      const res = await workspaceApi.rename(target.path, name, true)
      if (selected?.path === target.path) {
        setSelected({ ...selected, path: res.path, name: res.name })
      }
      setReloadTick((v) => v + 1)
    } catch (err) {
      toast.error(t(err instanceof ApiError && err.status === 409 ? 'browse.nameConflict' : 'browse.renameFailed'))
      console.warn('[browse] 重命名失败:', err)
    }
  }, [renaming, selected, t])

  /** 行内新建提交：文件夹=mkdir，文件=write 空内容；建成后重载列表。
   *  bind=true（新建项目入口）：文件夹建成即绑定为本会话项目目录并切到会话层 */
  const commitCreate = useCallback(async (value: string) => {
    const target = creating
    setCreating(null)
    if (!target) return
    const name = value.trim()
    if (!name) return
    if (INVALID_NAME_CHARS.test(name) || name === '.' || name === '..') {
      toast.error(t('browse.invalidName'))
      return
    }
    try {
      const path = joinPath(currentDir, name)
      // 同名预检（Windows 文件名大小写不敏感）：后端 write 是覆盖语义（tmp+Move overwrite），
      // 不预检会把同名既有文件静默清空；面板有当前目录清单在手，预检零成本，
      // 后端 409 仍留作兜底（清单过期/并发）
      if (list?.kind === 'ready' && list.nodes.some((n) => n.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0)) {
        toast.error(t('browse.nameConflict'))
        return
      }
      if (target.kind === 'folder') await workspaceApi.mkdir(path, true)
      else await workspaceApi.write(path, '', undefined, undefined, true)
      if (target.bind && convId != null) {
        const ok = await useConversationStore.getState().setConversationProject(convId, path)
        if (ok) {
          // 绑定成功=切到会话层落在项目根（convNav 随 activeLayer 变化自动复位）
          setActiveLayer('conversation')
          toast.success(t('browse.projectCreated'))
        } else {
          // 文件夹已建成，只是绑定落空——如实报绑定失败，目录仍跳过去
          toast.error(t('browse.projectSetFailed'))
          navigateTo(path)
        }
      }
      setReloadTick((v) => v + 1)
    } catch (err) {
      // 409 两种语义分开：登记挑战（理论不到达——面板全链 browse 直通）≠ 真同名冲突
      const challenge = parseChallenge(err)
      toast.error(t(challenge ? 'browse.revealNotRegistered' : err instanceof ApiError && err.status === 409 ? 'browse.nameConflict' : 'browse.createFailed'))
      console.warn('[browse] 新建失败:', err)
    }
  }, [creating, currentDir, convId, list, navigateTo, setActiveLayer, t])

  /** 设为项目目录（二阶段结构化绑定：写会话记录 ProjectPath 列，模型 set_browse_directory 同源） */
  const handleSetAsProject = useCallback(async (path: string) => {
    if (convId == null) return
    const ok = await useConversationStore.getState().setConversationProject(convId, path)
    if (ok) toast.success(t('browse.projectSet'))
    else toast.error(t('browse.projectSetFailed'))
  }, [convId, t])

  /** 新建项目入口（最近项目区「+」）：当前目录下行内新建文件夹，提交时绑定本会话。
   *  /computer 虚拟层没有可落子的父目录、无会话没有可绑定的对象——两种落空按钮侧已置灰 */
  const handleNewProject = useCallback(() => {
    setSessionsView(null)
    setCreating({ kind: 'folder', defaultName: t('browse.defaultProjectName'), bind: true })
  }, [t])

  /** 切到项目里的会话：与左侧栏点击同一动作链（detach+attach 走视图水合/活态接管），
   *  不能只 setCurrentConversation——那只换指针不装视图（2026-09-09 实测 bug：
   *  侧栏高亮跳了但对话内容停在原会话）。当前会话重点=跳过（Sidebar 同款短路） */
  const openProjectSession = useCallback((id: number) => {
    if (id !== useConversationStore.getState().currentConversationId) {
      const chat = useChatStore.getState()
      chat.detachConversationView()
      chat.attachConversationView(id)
    }
    close()
  }, [close])

  /** 打开项目会话视图（列表区换会话清单）；清文件选中态防预览残留 */
  const openSessionsView = useCallback((path: string) => {
    setSelected(null)
    setPreview(null)
    setSessionsView(path)
  }, [])

  /** 行右键菜单（node=null=空白区菜单）。菜单项按 文件/文件夹/空白 三态组织 */
  const openMenu = useCallback((e: React.MouseEvent, node: WorkspaceNode | null) => {
    e.preventDefault()
    e.stopPropagation()
    const isDir = node?.kind === 'folder'
    const entries: ContextMenuEntry[] = node == null
      ? isComputer
        ? [{ key: 'refresh', label: t('browse.refresh'), icon: RefreshCw, onSelect: () => setReloadTick((v) => v + 1) }]
        : [
            { key: 'newFolder', label: t('browse.newFolder'), icon: FolderPlus, onSelect: () => setCreating({ kind: 'folder', defaultName: t('browse.defaultFolderName') }) },
            { key: 'newText', label: t('browse.newTextFile'), icon: FilePlus2, onSelect: () => setCreating({ kind: 'file', defaultName: t('browse.defaultTextFileName') }) },
            { key: 'newMd', label: t('browse.newMarkdownFile'), icon: FilePlus2, onSelect: () => setCreating({ kind: 'file', defaultName: t('browse.defaultMarkdownFileName') }) },
            'divider',
            { key: 'copyPath', label: t('browse.copyPath'), icon: Copy, onSelect: () => void handleCopyPath(currentDir) },
            { key: 'refresh', label: t('browse.refresh'), icon: RefreshCw, onSelect: () => setReloadTick((v) => v + 1) },
          ]
      : [
          ...(isDir
            ? []
            : [{ key: 'open', label: t('browse.open'), icon: ExternalLink, onSelect: () => void handleOpen(node.path) } as ContextMenuEntry]),
          { key: 'reveal', label: t('browse.openInExplorer'), icon: FolderOpen, onSelect: () => void handleReveal(node.path) },
          ...(isDir
            ? []
            : [{ key: 'download', label: t('browse.download'), icon: Download, onSelect: () => handleDownload(node.path) } as ContextMenuEntry]),
          'divider',
          { key: 'copyPath', label: t('browse.copyPath'), icon: Copy, onSelect: () => void handleCopyPath(node.path) },
          { key: 'rename', label: t('browse.rename'), icon: Pencil, onSelect: () => setRenaming({ path: node.path, isFile: !isDir, initial: node.name }) },
          ...(isDir
            ? [{
                key: 'setProject',
                label: t('browse.setAsProject'),
                icon: FolderGit2,
                disabled: convKey == null,
                disabledTitle: t('browse.conversationNoDir'),
                onSelect: () => void handleSetAsProject(node.path),
              } as ContextMenuEntry]
            : []),
          'divider',
          { key: 'delete', label: t('browse.delete'), icon: Trash2, danger: true, onSelect: () => void handleDelete(node) },
        ]
    setMenu({ x: e.clientX, y: e.clientY, entries, node })
  }, [currentDir, isComputer, convKey, t, handleCopyPath, handleOpen, handleReveal, handleDownload, handleDelete, handleSetAsProject])

  // ── 拖拽（标题栏）与缩放（右下角把柄）：过程走 liveRect，松手才提交 store ──
  const startDrag = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY, rect: useBrowseDirectoryStore.getState().rect }
    const onMove = (ev: PointerEvent) => {
      setLiveRect(clampRect({ ...start.rect, x: start.rect.x + ev.clientX - start.x, y: start.rect.y + ev.clientY - start.y }))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setLiveRect((r) => { if (r) setRect(r); return null })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [setRect])

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const start = { x: e.clientX, y: e.clientY, rect: useBrowseDirectoryStore.getState().rect }
    const onMove = (ev: PointerEvent) => {
      setLiveRect(clampRect({
        ...start.rect,
        width: start.rect.width + ev.clientX - start.x,
        height: start.rect.height + ev.clientY - start.y,
      }))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setLiveRect((r) => { if (r) setRect(r); return null })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [setRect])

  /** 分栏拖拽：以 body 内 x 坐标算预览宽占比（0.25–0.65），实时本地 state */
  const startSplit = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const body = bodyRef.current
    if (!body) return
    const rectBox = body.getBoundingClientRect()
    const onMove = (ev: PointerEvent) => {
      const ratio = 1 - (ev.clientX - rectBox.left) / rectBox.width
      setPreviewRatio(Math.max(0.25, Math.min(0.65, ratio)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  const shownRect = liveRect ?? rect
  const computerLabel = t('browse.placeComputer')
  const crumbs = useMemo(() => breadcrumbSegments(currentDir, computerLabel), [currentDir, computerLabel])
  const parent = parentDir(currentDir)
  const dirName = placeName(currentDir, computerLabel)

  // places 栏位点激活态：按当前位置归属如实高亮（进入物理盘=「我的电脑」位点保持亮）
  const placeActive = {
    workspace: effectiveLayer === 'global' && (currentDir === '/workspace' || currentDir.startsWith('/workspace/')),
    project: effectiveLayer === 'conversation',
    computer: effectiveLayer === 'global' && !currentDir.startsWith('/workspace'),
  }

  if (!isOpen) return null

  // 最小化=右下角胶囊（当前目录名一眼可辨，点回窗口）
  if (minimized) {
    return createPortal(
      <button className="wf-browse-capsule" onClick={open} title={t('browse.title')}>
        <FolderOpen size={14} />
        <span>{dirName}</span>
      </button>,
      document.body
    )
  }

  return createPortal(
    <div
      ref={windowRef}
      className="wf-browse-window"
      style={{ left: shownRect.x, top: shownRect.y, width: shownRect.width, height: shownRect.height }}
      role="dialog"
      aria-label={t('browse.title')}
    >
      {/* ── 标题栏：拖拽区 + 窗口动作 ── */}
      <div className="wf-browse-head" onPointerDown={startDrag}>
        <FolderOpen size={15} className="wf-browse-head-icon" />
        <span className="wf-browse-title">{t('browse.title')}</span>
        <div className="wf-browse-head-actions">
          <button
            onClick={() => void handleReveal(currentDir)}
            disabled={isComputer}
            title={t('browse.openInExplorer')}
            aria-label={t('browse.openInExplorer')}
          >
            <ExternalLink size={14} />
          </button>
          <button onClick={minimize} title={t('browse.minimize')} aria-label={t('browse.minimize')}>
            <Minus size={14} />
          </button>
          <button onClick={close} title={t('browse.close')} aria-label={t('browse.close')}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ── 地址栏：上一级 + 面包屑 + 刷新（对齐系统文件管理器直觉） ── */}
      <div className="wf-browse-addr">
        <button
          className="wf-browse-addr-btn"
          disabled={!parent}
          onClick={() => parent && navigateTo(parent)}
          title={t('browse.up')}
          aria-label={t('browse.up')}
        >
          <ArrowUp size={14} />
        </button>
        <div className="wf-browse-crumbs">
          {crumbs.map((seg, i) => (
            <span key={seg.path} className="wf-browse-crumb-wrap">
              {i > 0 && <ChevronRight size={11} className="wf-browse-crumb-sep" />}
              <button
                className={`wf-browse-crumb${i === crumbs.length - 1 ? ' current' : ''}`}
                onClick={() => navigateTo(seg.path)}
              >
                {seg.label}
              </button>
            </span>
          ))}
        </div>
        <button
          className="wf-browse-addr-btn"
          onClick={() => setReloadTick((v) => v + 1)}
          title={t('browse.refresh')}
          aria-label={t('browse.refresh')}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* ── 主体：places 栏 + 目录列表/盘符网格 + 选中文件预览 ── */}
      <div className="wf-browse-body" ref={bodyRef}>
        <div className="wf-browse-places">
          <button
            className={`wf-browse-place${placeActive.workspace ? ' active' : ''}`}
            onClick={() => jumpToPlace('workspace')}
          >
            <Briefcase size={15} />
            <span>{t('browse.placeWorkspace')}</span>
          </button>
          <button
            className={`wf-browse-place${placeActive.project ? ' active' : ''}`}
            disabled={!convRoot}
            title={convRoot ?? t('browse.conversationNoDir')}
            onClick={() => jumpToPlace('project')}
          >
            <FolderGit2 size={15} />
            <span>{t('browse.placeProject')}</span>
          </button>
          <button
            className={`wf-browse-place${placeActive.computer ? ' active' : ''}`}
            onClick={() => jumpToPlace('computer')}
          >
            <HardDrive size={15} />
            <span>{computerLabel}</span>
          </button>
          {/* 最近项目组（二阶段替代收藏）：会话绑定 GROUP BY 派生，无需用户维护。
              单行双点击区（2026-09-09 显性化拍板）：名字区=跳目录，右端「💬 N ›」整片=进会话清单——
              常驻可见（不 hover）、右端 flex:none 与长名省略互不挤压、点击目标整片放大；
              「+」=当前目录下新建项目并绑定本会话 */}
          <div className="wf-browse-places-sep">
            <span>{t('browse.projects')}</span>
            <button
              className="wf-browse-place-add"
              disabled={isComputer || convId == null}
              title={isComputer ? t('browse.projectNeedDirectory') : convId == null ? t('browse.projectNeedConversation') : t('browse.newProject')}
              aria-label={t('browse.newProject')}
              onClick={handleNewProject}
            >
              <Plus size={12} />
            </button>
          </div>
          {recentProjects.map((p) => (
            <div key={p.path} className={`wf-browse-place wf-browse-project${currentDir === p.path ? ' active' : ''}`}>
              <button
                className="wf-browse-project-main"
                onClick={() => jumpToPlace(p.path)}
                title={p.path}
              >
                <FolderGit2 size={13} />
                <span>{placeName(p.path, computerLabel)}</span>
              </button>
              <button
                className="wf-browse-project-sessions"
                onClick={() => openSessionsView(p.path)}
                title={t('browse.projectSessions', { count: p.count })}
              >
                <MessageSquare size={11} />
                <span>{p.count}</span>
                <ChevronRight size={11} />
              </button>
            </div>
          ))}
        </div>

        <div className="wf-browse-list" onContextMenu={sessionsView == null ? (e) => openMenu(e, null) : undefined}>
          {/* 项目会话视图（二阶段）：最近项目→点会话数进入，替换文件列表。
              点会话=切到该会话并关窗（用户意图明显是"继续那个活儿"）；头部可返回文件/进入目录 */}
          {sessionsView != null && (
            <>
              <div className="wf-browse-sessions-head">
                <button onClick={() => setSessionsView(null)} title={t('browse.backToFiles')} aria-label={t('browse.backToFiles')}>
                  <ArrowLeft size={13} />
                </button>
                <span className="wf-browse-sessions-path" title={sessionsView}>{placeName(sessionsView, computerLabel)}</span>
                <button onClick={() => jumpToPlace(sessionsView)} title={t('browse.openDirectory')} aria-label={t('browse.openDirectory')}>
                  <FolderOpen size={13} />
                </button>
              </div>
              {projectSessions.length === 0 && (
                <div className="wf-browse-state">{t('browse.noSessions')}</div>
              )}
              {projectSessions.map((c) => (
                <div
                  key={c.id}
                  className="wf-browse-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => openProjectSession(c.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openProjectSession(c.id) }}
                  title={c.title}
                >
                  <span className="wf-browse-row-icon"><MessageSquare size={14} /></span>
                  <span className="wf-browse-row-name">{c.title}</span>
                  {c.updatedAt && (
                    <span className="wf-browse-row-meta wf-browse-row-time">
                      {new Date(c.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  )}
                </div>
              ))}
            </>
          )}
          {sessionsView == null && (<>
          {/* 授权给助手提示条（非阻断）：浏览直通后，授权的唯一意义=把当前目录
              加进模型可读集。仅在「物理目录且未覆盖」时出现；盘符根不可登记不显示 */}
          {showGrantHint && (
            <div className="wf-browse-granthint">
              <span className="wf-browse-granthint-text">{t('browse.grantHint')}</span>
              <button className="wf-mini-btn wf-press" disabled={authorizing} onClick={() => void handleAuthorize('conversation')}>
                {authorizing ? t('browse.authorizing') : t('browse.authorize')}
              </button>
              <button className="wf-mini-btn wf-press" disabled={authorizing} onClick={() => void handleAuthorize('longterm')}>
                {t('browse.authorizeLongterm')}
              </button>
              <button
                className="wf-browse-granthint-dismiss"
                title={t('browse.dismissGrantHint')}
                aria-label={t('browse.dismissGrantHint')}
                onClick={() => setDismissedHints((prev) => new Set(prev).add(currentDir))}
              >
                <X size={12} />
              </button>
            </div>
          )}
          {loading && (
            <div className="wf-browse-state"><Loader2 size={15} className="animate-spin" />{t('browse.loading')}</div>
          )}
          {!loading && list?.kind === 'error' && (
            <div className="wf-browse-state"><FileQuestion size={16} />{list.message}</div>
          )}
          {!loading && list?.kind === 'ready' && list.nodes.length === 0 && !creating && (
            <div className="wf-browse-state">{t('browse.empty')}</div>
          )}
          {/* 行内新建伪行（Windows「新建文件夹」同款：先出行再命名，默认名全选可即改） */}
          {!loading && list?.kind === 'ready' && creating && (
            <div className="wf-browse-row creating">
              <span className="wf-browse-row-icon">
                {creating.kind === 'folder' ? <Folder size={14} /> : <FilePlus2 size={14} />}
              </span>
              <InlineNameInput
                initial={creating.defaultName}
                isFile={creating.kind === 'file'}
                onCommit={(v) => void commitCreate(v)}
                onCancel={() => setCreating(null)}
              />
            </div>
          )}
          {/* 盘符总览：大图标网格（Windows 此电脑直觉）——最近项目作为完整入口
              与驱动器平级分组陈列（有项目时才分组，无项目零噪音直出驱动器） */}
          {!loading && list?.kind === 'drives' && (
            <div className="wf-browse-computer">
              {recentProjects.length > 0 && (
                <>
                  <div className="wf-browse-group-label">{t('browse.projects')}</div>
                  <div className="wf-browse-drives">
                    {recentProjects.map((p) => (
                      <div
                        key={p.path}
                        className="wf-browse-drive"
                        onClick={() => navigateTo(p.path)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigateTo(p.path) }}
                        title={p.path}
                      >
                        <FolderGit2 size={30} className="wf-browse-drive-icon" />
                        <span className="wf-browse-drive-name">{placeName(p.path, computerLabel)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="wf-browse-group-label">{t('browse.groupDrives')}</div>
                </>
              )}
              <div className="wf-browse-drives">
                {list.drives.map((d) => {
                  const usedRatio = d.totalBytes && d.freeBytes != null && d.totalBytes > 0
                    ? 1 - d.freeBytes / d.totalBytes
                    : null
                  return (
                    <div
                      key={d.path}
                      className="wf-browse-drive"
                      onClick={() => navigateTo(d.path)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigateTo(d.path) }}
                    >
                      <HardDrive size={30} className="wf-browse-drive-icon" />
                      <span className="wf-browse-drive-name">
                        {d.label ? `${d.label} (${d.path.replace('/', '')})` : d.path.replace('/', '')}
                      </span>
                      {usedRatio != null && (
                        <>
                          <span className="wf-browse-drive-bar">
                            <span style={{ width: `${Math.round(usedRatio * 100)}%` }} />
                          </span>
                          <span className="wf-browse-drive-meta">
                            {t('browse.driveFree', {
                              free: formatFileSize(d.freeBytes ?? 0),
                              total: formatFileSize(d.totalBytes ?? 0),
                            })}
                          </span>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {!loading && list?.kind === 'ready' && list.nodes.map((node) => {
            const isDir = node.kind === 'folder'
            const iconInfo = isDir ? null : getFileIconInfo(node.name)
            const isSelected = selected?.path === node.path
            const isRenaming = renaming?.path === node.path
            return (
              <div
                key={node.path}
                className={`wf-browse-row${isSelected ? ' selected' : ''}`}
                onClick={() => !isRenaming && handleEnter(node)}
                onDoubleClick={() => !isDir && !isRenaming && void handleOpen(node.path)}
                onContextMenu={(e) => openMenu(e, node)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (isRenaming) return
                  if (e.key === 'Enter' || e.key === ' ') handleEnter(node)
                  // Windows 同款快捷键：F2 重命名、Delete 删除（回收站）
                  else if (e.key === 'F2') setRenaming({ path: node.path, isFile: !isDir, initial: node.name })
                  else if (e.key === 'Delete') void handleDelete(node)
                }}
                title={node.path}
              >
                <span className="wf-browse-row-icon">
                  {isDir
                    ? <Folder size={14} />
                    : iconInfo
                      ? <iconInfo.icon size={14} className={iconInfo.colorClass} />
                      : <FileQuestion size={14} />}
                </span>
                {isRenaming ? (
                  <InlineNameInput
                    initial={renaming.initial}
                    isFile={renaming.isFile}
                    onCommit={(v) => void commitRename(v)}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span className="wf-browse-row-name">{node.name}{isDir ? '/' : ''}</span>
                )}
                {/* hover 行内动作：复制路径一键达（面板核心使命=快速取路径） */}
                {!isRenaming && (
                  <span className="wf-browse-row-actions">
                    <button
                      title={t('browse.copyPath')}
                      aria-label={t('browse.copyPath')}
                      onClick={(e) => { e.stopPropagation(); void handleCopyPath(node.path) }}
                    >
                      <Copy size={12} />
                    </button>
                  </span>
                )}
                {!isDir && node.sizeBytes != null && (
                  <span className="wf-browse-row-meta">{formatFileSize(node.sizeBytes)}</span>
                )}
                {node.updatedAt && (
                  <span className="wf-browse-row-meta wf-browse-row-time">
                    {new Date(node.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                )}
              </div>
            )
          })}
          </>)}
        </div>

        {/* 预览：选中文件才出现，关闭即回纯列表（不常驻占宽）；宽占比可调（分隔条拖拽） */}
        {selected && (
          <>
            <div className="wf-browse-splitter" onPointerDown={startSplit} title={t('browse.splitterHint')} />
            <div className="wf-browse-preview" style={{ width: `${Math.round(previewRatio * 100)}%` }}>
            <div className="wf-browse-preview-head">
              <span className="wf-browse-preview-name" title={selected.path}>{selected.name}</span>
              <button onClick={() => setSelected(null)} aria-label={t('browse.close')} title={t('browse.close')}>
                <X size={13} />
              </button>
            </div>
            <div className="wf-browse-preview-body">
              {preview?.loading && (
                <div className="wf-browse-state"><Loader2 size={14} className="animate-spin" />{t('browse.loading')}</div>
              )}
              {preview?.error && <div className="wf-browse-state">{preview.error}</div>}
              {preview?.text !== undefined && (
                <>
                  {selectedIsMarkdown ? (
                    <div className="wf-browse-preview-md wf-prose wf-md">
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                        {normalizeMarkdown(preview.text)}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <pre className="wf-browse-preview-text">{preview.text}</pre>
                  )}
                  {preview.truncated && (
                    <div className="wf-browse-preview-note">{t('browse.previewTruncated', { count: PREVIEW_LINES })}</div>
                  )}
                </>
              )}
              {preview?.imageUrl && (
                <ZoomableImage url={preview.imageUrl} alt={selected.name} />
              )}
              {preview?.binary && (
                <div className="wf-browse-state wf-browse-binary">
                  <FileQuestion size={18} />
                  <p>{t('browse.binaryFile')}</p>
                  <span>{formatFileSize(preview.binary.sizeBytes)}{preview.binary.mimeType ? ` · ${preview.binary.mimeType}` : ''}</span>
                </div>
              )}
            </div>
            <div className="wf-browse-preview-foot">
              <button onClick={() => void handleOpen(selected.path)} title={t('browse.open')}>
                <ExternalLink size={13} />{t('browse.open')}
              </button>
              <button onClick={() => handleDownload(selected.path)}>
                <Download size={13} />{t('browse.download')}
              </button>
              <button onClick={() => void handleReveal(selected.path)}>
                <FolderOpen size={13} />{t('browse.openInExplorer')}
              </button>
            </div>
            </div>
          </>
        )}
      </div>

      {/* 缩放把柄（右下角） */}
      <div className="wf-browse-resize" onPointerDown={startResize} />

      {/* 右键菜单（行/空白区共用；node 只用于菜单语义，不随菜单留存操作） */}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>,
    document.body
  )
})

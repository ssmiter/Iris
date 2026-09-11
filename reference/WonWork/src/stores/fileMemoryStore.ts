import { create } from 'zustand'
import type { MemoryFileEntry } from '@/types/memoryFile'
import { buildMemoryFileContent, memoryFileName } from '@/types/memoryFile'
import { userMemoryApi } from '@/api/client'

/**
 * 文件级记忆 store（2026-09-03 下限工程：记忆从 SQLite 迁到文件系统）。
 *
 * 定位：~/.wonwork/memory/ 目录的缓存视图，是记忆在前端的唯一数据源
 * （旧 memoryStore/SQLite AiMemory 链路已随本批退役删除）。
 * 模型侧不经过本 store——模型用文件原语（read_file/write_file/str_replace/grep）
 * 直接管 ~/.wonwork/memory/ 下的文件（经 run_command 或后端文件 API）。
 * 本 store 只服务前端管理页、划词收入（memoryRemember pipeline）和系统提示词注入（记忆索引）。
 *
 * 数据结构对齐 claude-code memdir：每条记忆一个 .md 文件（frontmatter: name/description/type），
 * MEMORY.md 是索引（一行一条，200行/25KB 上限）。
 */

interface FileMemoryState {
  /** 扫描到的记忆文件清单 */
  entries: MemoryFileEntry[]
  /** MEMORY.md 索引内容 */
  indexContent: string
  /** 索引文件在磁盘上的路径（供提示词引用） */
  indexPath: string
  initialized: boolean
  isLoading: boolean
  error: string | null

  initialize: () => Promise<void>
  refresh: () => Promise<void>
  /** 轻量索引重拉（每轮发送前调）：模型经文件原语改写记忆会绕过本 store，
   *  只重拉索引+路径保注入新鲜；entries 清单不重拉（注入不消费它）。失败静默沿用旧缓存 */
  refreshIndex: () => Promise<void>
  /** 写入记忆文件（两步走第一步） */
  writeMemoryFile: (relativePath: string, content: string) => Promise<boolean>
  /** 删除记忆文件 */
  deleteMemoryFile: (relativePath: string) => Promise<boolean>
  /** 删除一条记忆（文件+索引行一步净）：管理页与覆层共用，不留孤儿索引行 */
  deleteMemoryWithIndex: (relativePath: string) => Promise<boolean>
  /** 写入索引（两步走第二步） */
  writeIndex: (content: string) => Promise<boolean>
  /** 读取单条记忆全文 */
  readMemoryFile: (relativePath: string) => Promise<string | null>
  /** 构建记忆索引文本（附用户消息尾部注入，对齐 cc loadMemoryPrompt；带 <memory_index> 包裹与目录头注） */
  buildMemoryIndex: () => { text: string; count: number }
  /**
   * 快速记一笔（/remember 命令、管理页"记一笔"共用）：无 LLM 誊写，
   * 直接落成无类型速记文件 + 索引行。要归类/提炼请走对话或划词收入。
   */
  addQuickNote: (content: string) => Promise<boolean>
  /** 维护索引行（两步走第二步的封装）：有该行则替换，没有则追加 */
  upsertIndexLine: (relativePath: string, name: string, description: string) => Promise<boolean>
  /** 关键词检索（dag/agentSwarm 的任务上下文注入用；语义检索随 embedding 一并退役） */
  searchMemoryFiles: (query: string, limit?: number) => MemoryFileEntry[]
}

/** 索引行格式（与 cc MEMORY.md 一致）：- [name](relativePath) — description
 *  name/description 先压成单行——多行原文会把索引行与 frontmatter 值断成两行 */
function indexLine(relativePath: string, name: string, description: string): string {
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
  return `- [${oneLine(name)}](${relativePath}) — ${oneLine(description)}`
}

/** 从索引文本中定位某文件的行（匹配 `](path)` 锚） */
function replaceOrAppendLine(index: string, relativePath: string, line: string): string {
  const anchor = `](${relativePath})`
  const lines = index.split('\n')
  const at = lines.findIndex((l) => l.includes(anchor))
  if (at >= 0) lines[at] = line
  else lines.push(line)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/** 文件名去重：同名已存在时追加 -2/-3… */
function uniqueFileName(entries: MemoryFileEntry[], base: string): string {
  const taken = new Set(entries.map((e) => e.relativePath))
  if (!taken.has(base)) return base
  const stem = base.replace(/\.md$/, '')
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}.md`
    if (!taken.has(candidate)) return candidate
  }
  return `${stem}-${Date.now()}.md`
}

export const useFileMemoryStore = create<FileMemoryState>((set, get) => ({
  entries: [],
  indexContent: '',
  indexPath: '',
  initialized: false,
  isLoading: false,
  error: null,

  initialize: async () => {
    if (get().initialized || get().isLoading) return
    set({ isLoading: true, error: null })
    try {
      const [indexRes, files] = await Promise.all([
        userMemoryApi.getIndex(),
        userMemoryApi.listFiles(),
      ])
      set({
        entries: files,
        indexContent: indexRes.content,
        indexPath: indexRes.path,
        initialized: true,
        isLoading: false,
      })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        isLoading: false,
      })
    }
  },

  refresh: async () => {
    set({ isLoading: true, error: null })
    try {
      const [indexRes, files] = await Promise.all([
        userMemoryApi.getIndex(),
        userMemoryApi.listFiles(),
      ])
      set({
        entries: files,
        indexContent: indexRes.content,
        indexPath: indexRes.path,
        isLoading: false,
      })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        isLoading: false,
      })
    }
  },

  writeMemoryFile: async (relativePath, content) => {
    try {
      await userMemoryApi.putFile(relativePath, content)
      await get().refresh()
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return false
    }
  },

  deleteMemoryFile: async (relativePath) => {
    try {
      await userMemoryApi.deleteFile(relativePath)
      await get().refresh()
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return false
    }
  },

  deleteMemoryWithIndex: async (relativePath) => {
    // 先删文件（内部 refresh 会把含孤儿行的磁盘索引读回缓存），再过滤索引行写回
    const ok = await get().deleteMemoryFile(relativePath)
    if (!ok) return false
    const anchor = `](${relativePath})`
    const next = get()
      .indexContent.split('\n')
      .filter((l) => !l.includes(anchor))
      .join('\n')
    return get().writeIndex(next)
  },

  refreshIndex: async () => {
    try {
      const indexRes = await userMemoryApi.getIndex()
      set({ indexContent: indexRes.content, indexPath: indexRes.path })
    } catch {
      // 失败静默——沿用旧缓存，下轮再试
    }
  },

  writeIndex: async (content) => {
    try {
      await userMemoryApi.putIndex(content)
      set({ indexContent: content })
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return false
    }
  },

  readMemoryFile: async (relativePath) => {
    try {
      const res = await userMemoryApi.getFile(relativePath)
      return res.content
    } catch {
      return null
    }
  },

  buildMemoryIndex: () => {
    const { indexContent, entries, indexPath } = get()
    // indexPath 缺席=初始化失败过，不注入（避免给出空路径误导模型）
    if (!indexPath) return { text: '', count: 0 }
    // 头注带目录绝对路径：后端无 ~ 展开，模型写新记忆靠它定位；
    // 空记忆也注入——写第一条记忆的锚点不能依赖"已有索引"才存在
    const dir = indexPath.replace(/[\\/][^\\/]+$/, '')
    // 索引内容直接注入（已经是 MEMORY.md 的一行一条格式）；
    // 如果没有索引但有文件，生成一个简易索引
    const body = indexContent.trim()
      ? indexContent.trim()
      : entries
          .map((e) => `- [${e.name}](${e.relativePath}) — ${e.description || e.content.slice(0, 60)}`)
          .join('\n')
    return { text: `<memory_index dir="${dir}">\n${body || '（空）'}\n</memory_index>`, count: entries.length }
  },

  addQuickNote: async (content) => {
    const text = content.trim()
    if (!text) return false
    await get().initialize()
    const name = text.slice(0, 20)
    const description = text.slice(0, 30)
    const path = uniqueFileName(get().entries, memoryFileName(name))
    const ok = await userMemoryApi
      .putFile(path, buildMemoryFileContent(name, description, undefined, text))
      .then(() => true)
      .catch(() => false)
    if (!ok) return false
    await get().upsertIndexLine(path, name, description)
    await get().refresh()
    return true
  },

  upsertIndexLine: async (relativePath, name, description) => {
    const next = replaceOrAppendLine(
      get().indexContent,
      relativePath,
      indexLine(relativePath, name, description)
    )
    return get().writeIndex(next)
  },

  searchMemoryFiles: (query, limit = 3) => {
    const q = query.toLowerCase()
    // 切词：英文按词、中文按 2 字滑窗（无分词器下的务实近似）
    const terms = new Set<string>()
    for (const w of q.split(/[^a-z0-9一-鿿]+/)) {
      if (!w) continue
      if (/^[a-z0-9]+$/.test(w)) terms.add(w)
      else for (let i = 0; i < w.length - 1; i++) terms.add(w.slice(i, i + 2))
    }
    if (terms.size === 0) return []
    const scored = get().entries.map((e) => {
      const hay = `${e.name}\n${e.description}`.toLowerCase()
      const body = e.content.toLowerCase()
      let score = 0
      for (const t of terms) {
        if (hay.includes(t)) score += 3
        if (body.includes(t)) score += 1
      }
      return { e, score }
    })
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.e.lastModified.localeCompare(a.e.lastModified))
      .slice(0, limit)
      .map((s) => s.e)
  },
}))

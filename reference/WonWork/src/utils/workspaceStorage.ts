import type { SkillManifest, SkillType } from '@/types/skill'
import { IS_STANDALONE } from '@/config/product'
import { getIndexedDBName } from '@/utils/storageScope'

// workspace 作用域在模块加载时确定，避免循环依赖：
// workspaceStorage -> storageScope -> runtimeMode -> authStore -> ... -> workspaceStorage
function getWorkspaceScope(): string {
  return IS_STANDALONE ? 'standalone' : 'mescli'
}

const WORKSPACE_META_KEY = () => `${getWorkspaceScope()}_workspace_dir_handle`
const FALLBACK_SKILLS_KEY = () => `${getWorkspaceScope()}_fallback_skills`

export interface WorkspaceState {
  isConnected: boolean
  isFallbackMode: boolean
  dirHandle: FileSystemDirectoryHandle | null
  workspacePath: string | null
}

let state: WorkspaceState = {
  isConnected: false,
  isFallbackMode: false,
  dirHandle: null,
  workspacePath: null,
}

// ==================== 能力检测 ====================

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

// ==================== IndexedDB 辅助（workspaceMeta）====================

async function openMetaDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // 运行时获取 DB 名，避免模块加载时触发 storageScope -> runtimeMode -> authStore 循环依赖
    const req = indexedDB.open(getIndexedDBName())
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains('workspaceMeta')) {
        db.createObjectStore('workspaceMeta', { keyPath: 'key' })
      }
    }
  })
}

async function metaGet<T>(key: string): Promise<T | undefined> {
  const db = await openMetaDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspaceMeta', 'readonly')
    const store = tx.objectStore('workspaceMeta')
    const req = store.get(key)
    req.onsuccess = () => resolve(req.result?.value as T)
    req.onerror = () => reject(req.error)
  })
}

async function metaSet(key: string, value: unknown): Promise<void> {
  const db = await openMetaDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspaceMeta', 'readwrite')
    const store = tx.objectStore('workspaceMeta')
    const req = store.put({ key, value })
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

async function metaDelete(key: string): Promise<void> {
  const db = await openMetaDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspaceMeta', 'readwrite')
    const store = tx.objectStore('workspaceMeta')
    const req = store.delete(key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

// ==================== 工作区连接 ====================

export function getWorkspaceState(): WorkspaceState {
  return { ...state }
}

export async function initWorkspace(): Promise<void> {
  if (!isFileSystemAccessSupported()) {
    state = { isConnected: false, isFallbackMode: true, dirHandle: null, workspacePath: null }
    return
  }

  // 尝试从 IndexedDB 恢复句柄
  try {
    const saved = await metaGet<FileSystemDirectoryHandle>(WORKSPACE_META_KEY())
    if (saved) {
      // 先查询现有权限
      let permission = await (saved as any).queryPermission?.({ mode: 'readwrite' })
      console.log('[workspace] queryPermission result:', permission)

      // 如果权限是 prompt（过期），尝试重新请求
      if (permission === 'prompt') {
        permission = await (saved as any).requestPermission?.({ mode: 'readwrite' })
        console.log('[workspace] requestPermission result:', permission)
      }

      if (permission === 'granted') {
        state.dirHandle = saved
        state.workspacePath = saved.name
        state.isConnected = true
        state.isFallbackMode = false
        console.log('[workspace] init success:', saved.name)
        return
      }
    }
  } catch (err) {
    console.warn('[workspace] init recovery failed:', err)
  }

  state = { isConnected: false, isFallbackMode: false, dirHandle: null, workspacePath: null }
}

export async function pickWorkspace(): Promise<void> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('当前浏览器不支持文件系统访问，请使用 Chrome 或 Edge')
  }

  console.log('[workspace] opening directory picker...')
  const dirHandle = await (window as any).showDirectoryPicker()
  if (!dirHandle) {
    throw new Error('未选择文件夹')
  }
  console.log('[workspace] selected:', dirHandle.name)

  // showDirectoryPicker 已包含权限请求，但某些版本需要显式确认
  const permission = await (dirHandle as any).requestPermission?.({ mode: 'readwrite' })
  console.log('[workspace] permission:', permission)
  if (permission !== 'granted') {
    throw new Error('需要读写权限才能使用工作区')
  }

  // 创建子目录结构
  await ensureDirectoryStructure(dirHandle)
  console.log('[workspace] directory structure ensured')

  // 保存句柄到 IndexedDB
  await metaSet(WORKSPACE_META_KEY(), dirHandle)
  console.log('[workspace] handle saved to IndexedDB')

  state = {
    isConnected: true,
    isFallbackMode: false,
    dirHandle,
    workspacePath: dirHandle.name,
  }
  console.log('[workspace] state updated:', state)
}

export async function reconnectWorkspace(): Promise<boolean> {
  if (!isFileSystemAccessSupported()) return false

  try {
    const saved = await metaGet<FileSystemDirectoryHandle>(WORKSPACE_META_KEY())
    if (!saved) {
      console.log('[workspace] reconnect: no saved handle')
      return false
    }

    const permission = await (saved as any).requestPermission?.({ mode: 'readwrite' })
    console.log('[workspace] reconnect permission:', permission)
    if (permission === 'granted') {
      state.dirHandle = saved
      state.workspacePath = saved.name
      state.isConnected = true
      state.isFallbackMode = false
      console.log('[workspace] reconnect success:', saved.name)
      return true
    }
  } catch (err) {
    console.warn('[workspace] reconnect failed:', err)
  }

  state = { isConnected: false, isFallbackMode: false, dirHandle: null, workspacePath: null }
  return false
}

export async function disconnectWorkspace(): Promise<void> {
  await metaDelete(WORKSPACE_META_KEY())
  state = { isConnected: false, isFallbackMode: false, dirHandle: null, workspacePath: null }
}

async function ensureDirectoryStructure(root: FileSystemDirectoryHandle): Promise<void> {
  await root.getDirectoryHandle('skills', { create: true })
  await root.getDirectoryHandle('templates', { create: true })
  await root.getDirectoryHandle('exports', { create: true })
  await root.getDirectoryHandle('memory', { create: true })
  const configDir = await root.getDirectoryHandle('config', { create: true })

  // 写入 workspace.json 元数据
  try {
    const fileHandle = await configDir.getFileHandle('workspace.json', { create: true })
    const writable = await (fileHandle as any).createWritable()
    const meta = {
      name: root.name,
      version: '1.0',
      createdAt: new Date().toISOString(),
      schemaVersion: '1.0',
    }
    await writable.write(JSON.stringify(meta, null, 2))
    await writable.close()
  } catch {
    // ignore write errors
  }
}

// ==================== SKILL.md 解析与序列化 ====================

function parseYamlValue(v: string): unknown {
  v = v.trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === '[]' || v === '') return []
  if (v === 'null' || v === '~') return null
  if (v.match(/^-?\d+$/)) return parseInt(v, 10)
  if (v.match(/^-?\d+\.\d+$/)) return parseFloat(v)
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map(s => parseYamlValue(s.trim()))
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

function parseYamlBlock(lines: string[], startIndex: number, baseIndent: number): { result: Record<string, unknown>; endIndex: number } {
  const result: Record<string, unknown> = {}
  let i = startIndex

  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i++; continue }

    const indent = line.search(/\S/)
    if (indent < baseIndent) break
    if (indent > baseIndent) { i++; continue }

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) { i++; continue }

    const key = line.slice(0, colonIdx).trim()
    let value = line.slice(colonIdx + 1).trim()

    if (value === '' || value === '>') {
      const values: string[] = []
      i++
      while (i < lines.length) {
        const nextLine = lines[i]
        const nextIndent = nextLine.search(/\S/)
        if (nextIndent > baseIndent || nextLine.trim() === '') {
          values.push(nextLine.trimStart())
          i++
        } else {
          break
        }
      }
      result[key] = values.join(' ').trim()
      continue
    } else if (value === '') {
      i++
      if (i < lines.length) {
        const nextIndent = lines[i].search(/\S/)
        if (nextIndent > baseIndent) {
          const nested = parseYamlBlock(lines, i, nextIndent)
          result[key] = nested.result
          i = nested.endIndex
          continue
        }
      }
      result[key] = {}
      continue
    } else {
      result[key] = parseYamlValue(value)
    }

    i++
  }

  return { result, endIndex: i }
}

function parseYamlFrontmatter(yaml: string): Record<string, unknown> {
  const lines = yaml.split('\n')
  const { result } = parseYamlBlock(lines, 0, 0)
  return result
}

export function parseSkillMdToManifest(text: string, dirName: string): SkillManifest | null {
  // 移除 BOM 并统一换行符
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const match = normalized.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!match) return null

  const yaml = match[1]
  const body = match[2].trim()
  const fm = parseYamlFrontmatter(yaml)

  const id = String(fm.id || dirName)
  const name = String(fm.name || dirName)
  const description = String(fm.description || '')
  const version = String(fm.version || '1.0.0')
  const author = String(fm.author || 'User')
  const rawType = String(fm.type || 'custom')

  const typeMap: Record<string, SkillType> = {
    'capability': 'custom',
    'custom': 'custom',
    'document-word': 'document-word',
    'document-excel': 'document-excel',
    'document-generic': 'document-generic',
  }
  const type = typeMap[rawType] || 'custom'

  const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : []
  const icon = String(fm.icon || 'Puzzle')

  const triggerRaw = (fm.trigger as Record<string, unknown> | undefined) || {}
  const triggerMode = String(triggerRaw.mode || 'manual') as import('@/types/skill').SkillTriggerMode
  const triggerKeywords = Array.isArray(triggerRaw.keywords)
    ? triggerRaw.keywords.map(String)
    : undefined

  const enabled = fm.enabled === true
  const installedAt = String(fm.installedAt || new Date().toISOString())
  const updatedAt = String(fm.updatedAt || new Date().toISOString())
  const source = String(fm.source || 'local') as SkillManifest['source']

  return {
    id,
    name,
    description,
    version,
    author,
    type,
    tags,
    icon,
    trigger: {
      mode: triggerMode,
      ...(triggerKeywords ? { keywords: triggerKeywords } : {}),
    },
    prompt: body,
    enabled,
    installedAt,
    updatedAt,
    source,
  }
}

function yamlValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    if (v.includes('\n') || v.includes(':') || v.includes('#') || v.includes('"') || v.includes("'") || v.includes(',') ||
        v === '' || v === 'true' || v === 'false' || v.startsWith('[') || v.startsWith('"') || v.startsWith("'")) {
      return `"${v.replace(/"/g, '\\"')}"`
    }
    return v
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return `[${v.map(yamlValue).join(', ')}]`
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v).filter(([, val]) => val !== undefined)
    if (entries.length === 0) return ''
    const lines = entries.map(([k, val]) => `  ${k}: ${yamlValue(val)}`)
    return '\n' + lines.join('\n')
  }
  return String(v)
}

export function skillToYaml(skill: SkillManifest): string {
  const lines: string[] = []

  lines.push(`id: ${skill.id}`)
  lines.push(`name: ${yamlValue(skill.name)}`)
  lines.push(`description: ${yamlValue(skill.description)}`)
  lines.push(`version: ${yamlValue(skill.version)}`)
  lines.push(`author: ${yamlValue(skill.author)}`)
  lines.push(`type: ${skill.type}`)
  lines.push(`tags: ${yamlValue(skill.tags)}`)
  lines.push(`icon: ${skill.icon}`)

  lines.push(`trigger:`)
  lines.push(`  mode: ${skill.trigger.mode}`)
  if (skill.trigger.keywords) {
    lines.push(`  keywords: ${yamlValue(skill.trigger.keywords)}`)
  }

  lines.push(`enabled: ${skill.enabled}`)
  lines.push(`installedAt: ${skill.installedAt}`)
  lines.push(`updatedAt: ${skill.updatedAt}`)
  lines.push(`source: ${skill.source}`)

  return lines.join('\n') + '\n'
}

export function skillToMarkdown(skill: SkillManifest): string {
  return `---\n${skillToYaml(skill)}---\n\n${skill.prompt}`
}

// ==================== Skill 文件操作 ====================

export async function listSkills(): Promise<SkillManifest[]> {
  if (state.isConnected && !state.isFallbackMode && state.dirHandle) {
    try {
      const skills: SkillManifest[] = []
      const skipDirs = new Set(['templates', 'exports', 'config'])

      for await (const [name, handle] of (state.dirHandle as any).entries()) {
        if (handle.kind !== 'directory') continue
        if (skipDirs.has(name)) continue

        try {
          const skillDir = await state.dirHandle.getDirectoryHandle(name)
          const fileHandle = await skillDir.getFileHandle('SKILL.md')
          const file = await fileHandle.getFile()
          const text = await file.text()
          const manifest = parseSkillMdToManifest(text, name)
          if (manifest) {
            skills.push(manifest)
            console.log('[workspace] listSkills: loaded', manifest.name)
          }
        } catch (err) {
          console.warn('[workspace] listSkills: failed to load', name, err)
        }
      }

      console.log('[workspace] listSkills: total skills:', skills.length)
      await metaSet(FALLBACK_SKILLS_KEY(), skills)
      return skills.sort((a, b) => a.name.localeCompare(b.name))
    } catch (err) {
      console.warn('[workspace] listSkills: filesystem read failed:', err)
    }
  }

  // 降级模式：从 IndexedDB 读取
  try {
    return (await metaGet<SkillManifest[]>(FALLBACK_SKILLS_KEY())) || []
  } catch {
    return []
  }
}

export async function readSkill(id: string): Promise<SkillManifest | null> {
  if (state.isConnected && !state.isFallbackMode && state.dirHandle) {
    try {
      const skillDir = await state.dirHandle.getDirectoryHandle(id)
      const fileHandle = await skillDir.getFileHandle('SKILL.md')
      const file = await fileHandle.getFile()
      const text = await file.text()
      return parseSkillMdToManifest(text, id)
    } catch {
      // not found
    }
  }

  const skills = (await metaGet<SkillManifest[]>(FALLBACK_SKILLS_KEY())) || []
  return skills.find((s) => s.id === id) || null
}

export async function writeSkill(skill: SkillManifest): Promise<void> {
  const yaml = skillToYaml(skill)
  const body = skill.prompt
  const content = `---\n${yaml}---\n\n${body}`

  console.log('[workspace] writeSkill:', skill.id, 'state.isConnected:', state.isConnected)

  if (state.isConnected && !state.isFallbackMode && state.dirHandle) {
    try {
      const skillDir = await state.dirHandle.getDirectoryHandle(skill.id, { create: true })
      const handle = await skillDir.getFileHandle('SKILL.md', { create: true })
      const writable = await (handle as any).createWritable()
      await writable.write(content)
      await writable.close()
      console.log('[workspace] writeSkill: success for', skill.id)
    } catch (err) {
      console.error('[workspace] writeSkill: filesystem write failed:', err)
    }
  }

  // 始终同步到 IndexedDB 缓存
  const skills = (await metaGet<SkillManifest[]>(FALLBACK_SKILLS_KEY())) || []
  const idx = skills.findIndex((s) => s.id === skill.id)
  if (idx >= 0) {
    skills[idx] = skill
  } else {
    skills.push(skill)
  }
  await metaSet(FALLBACK_SKILLS_KEY(), skills)
}

export async function deleteSkill(id: string): Promise<void> {
  if (state.isConnected && !state.isFallbackMode && state.dirHandle) {
    try {
      await (state.dirHandle as any).removeEntry(id, { recursive: true })
      console.log('[workspace] deleteSkill: removed directory', id)
    } catch (err) {
      console.error('[workspace] deleteSkill: failed to remove directory', id, err)
    }
  }

  // 同步更新 IndexedDB 缓存
  const skills = (await metaGet<SkillManifest[]>(FALLBACK_SKILLS_KEY())) || []
  const filtered = skills.filter((s) => s.id !== id)
  await metaSet(FALLBACK_SKILLS_KEY(), filtered)
}

// ==================== 通用文件操作 ====================

export async function statWorkspaceFile(path: string): Promise<{ size: number; lastModified: number } | null> {
  if (!state.isConnected || state.isFallbackMode) return null
  try {
    const parts = path.split('/').filter(Boolean)
    let dir = state.dirHandle!
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i])
    }
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1])
    const file = await fileHandle.getFile()
    return { size: file.size, lastModified: file.lastModified }
  } catch {
    return null
  }
}

export async function readWorkspaceFile(path: string): Promise<string | null> {
  if (!state.isConnected || state.isFallbackMode) return null
  try {
    const parts = path.split('/').filter(Boolean)
    let dir = state.dirHandle!
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i])
    }
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1])
    const file = await fileHandle.getFile()
    return await file.text()
  } catch {
    return null
  }
}

export async function writeWorkspaceFile(path: string, content: string): Promise<void> {
  if (!state.isConnected || state.isFallbackMode) {
    throw new Error('工作区未连接')
  }
  const parts = path.split('/').filter(Boolean)
  let dir = state.dirHandle!
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create: true })
  }
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true })
  const writable = await (fileHandle as any).createWritable()
  await writable.write(content)
  await writable.close()
}

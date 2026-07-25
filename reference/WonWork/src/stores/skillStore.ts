import { create } from 'zustand'
import type { SkillManifest } from '@/types/skill'
import {
  initWorkspace,
  pickWorkspace,
  reconnectWorkspace,
  disconnectWorkspace,
  getWorkspaceState,
  listSkills as fsListSkills,
  readSkill as fsReadSkill,
  writeSkill as fsWriteSkill,
  deleteSkill as fsDeleteSkill,
  isFileSystemAccessSupported,
  parseSkillMdToManifest,
  skillToMarkdown,
} from '@/utils/workspaceStorage'
import { skillApi } from '@/api/skillApi'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

interface SkillStoreState {
  skills: SkillManifest[]
  activeSkillIds: string[]
  isLoading: boolean
  isWorkspaceConnected: boolean
  isFallbackMode: boolean
  workspacePath: string | null

  init(): Promise<void>
  pickWorkspace(): Promise<void>
  reconnectWorkspace(): Promise<void>
  disconnectWorkspace(): Promise<void>

  installSkill(skill: SkillManifest): Promise<void>
  uninstallSkill(id: string): Promise<void>
  updateSkill(id: string, updates: Partial<SkillManifest>): Promise<void>
  toggleSkill(id: string): Promise<void>
  loadSkill(id: string): void
  unloadSkill(id: string): void

  importFromFile(file: File): Promise<void>
  exportToFile(id: string): void
  createSkill(data: Partial<SkillManifest>): Promise<SkillManifest>

  getEnabledSkills(): SkillManifest[]
  getActiveSkillsForMessage(message: string): SkillManifest[]
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

async function listSkills(): Promise<SkillManifest[]> {
  return IS_STANDALONE ? fsListSkills() : skillApi.listSkills()
}

async function readSkill(id: string): Promise<SkillManifest | null> {
  return IS_STANDALONE ? fsReadSkill(id) : skillApi.readSkill(id)
}

async function writeSkill(skill: SkillManifest): Promise<void> {
  if (IS_STANDALONE) {
    await fsWriteSkill(skill)
  } else {
    await skillApi.writeSkill(skill)
  }
}

async function deleteSkill(id: string): Promise<void> {
  if (IS_STANDALONE) {
    await fsDeleteSkill(id)
  } else {
    await skillApi.deleteSkill(id)
  }
}

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  skills: [],
  activeSkillIds: [],
  isLoading: false,
  isWorkspaceConnected: false,
  isFallbackMode: false,
  workspacePath: null,

  init: async () => {
    set({ isLoading: true })
    try {
      if (IS_STANDALONE) {
        await initWorkspace()
        const ws = getWorkspaceState()
        const skills = await listSkills()
        await syncBuiltInSkills(skills)

        set({
          skills,
          isWorkspaceConnected: ws.isConnected,
          isFallbackMode: ws.isFallbackMode,
          workspacePath: ws.workspacePath,
          isLoading: false,
        })
      } else {
        // MESCLI/安装包模式：后端托管工作区，无需用户选择
        const skills = await listSkills()
        await syncBuiltInSkills(skills)

        set({
          skills,
          isWorkspaceConnected: true,
          isFallbackMode: false,
          workspacePath: '{InstallDir}\\workspace\\skills',
          isLoading: false,
        })
      }
    } catch (err) {
      console.error('Skill Store 初始化失败:', err)
      set({ isLoading: false })
    }
  },

  pickWorkspace: async () => {
    if (!IS_STANDALONE) return

    set({ isLoading: true })
    try {
      await pickWorkspace()
      const ws = getWorkspaceState()
      const skills = await listSkills()
      await syncBuiltInSkills(skills)

      set({
        skills,
        isWorkspaceConnected: ws.isConnected,
        isFallbackMode: ws.isFallbackMode,
        workspacePath: ws.workspacePath,
        isLoading: false,
      })
    } catch (err) {
      console.error('[skillStore] 选择工作区失败:', err)
      set({ isLoading: false })
      throw err
    }
  },

  reconnectWorkspace: async () => {
    if (!IS_STANDALONE) return

    const success = await reconnectWorkspace()
    if (success) {
      const ws = getWorkspaceState()
      const skills = await listSkills()
      set({
        skills,
        isWorkspaceConnected: ws.isConnected,
        isFallbackMode: ws.isFallbackMode,
        workspacePath: ws.workspacePath,
      })
    }
  },

  disconnectWorkspace: async () => {
    if (!IS_STANDALONE) return

    await disconnectWorkspace()
    set({
      skills: [],
      isWorkspaceConnected: false,
      isFallbackMode: false,
      workspacePath: null,
      activeSkillIds: [],
    })
  },

  installSkill: async (skill) => {
    const toInstall: SkillManifest = {
      ...skill,
      installedAt: skill.installedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await writeSkill(toInstall)
    set((s) => ({
      skills: s.skills.some((sk) => sk.id === toInstall.id)
        ? s.skills.map((sk) => (sk.id === toInstall.id ? toInstall : sk))
        : [...s.skills, toInstall],
    }))
  },

  uninstallSkill: async (id) => {
    await deleteSkill(id)
    set((s) => ({
      skills: s.skills.filter((sk) => sk.id !== id),
      activeSkillIds: s.activeSkillIds.filter((aid) => aid !== id),
    }))
  },

  updateSkill: async (id, updates) => {
    const skill = get().skills.find((s) => s.id === id)
    if (!skill) return

    const updated: SkillManifest = { ...skill, ...updates, updatedAt: new Date().toISOString() }
    await writeSkill(updated)
    set((s) => ({
      skills: s.skills.map((sk) => (sk.id === id ? updated : sk)),
    }))
  },

  toggleSkill: async (id) => {
    const skill = get().skills.find((s) => s.id === id)
    if (!skill) return
    await get().updateSkill(id, { enabled: !skill.enabled })
  },

  loadSkill: (id) => {
    set((s) => ({
      activeSkillIds: s.activeSkillIds.includes(id) ? s.activeSkillIds : [...s.activeSkillIds, id],
    }))
  },

  unloadSkill: (id) => {
    set((s) => ({
      activeSkillIds: s.activeSkillIds.filter((aid) => aid !== id),
    }))
  },

  importFromFile: async (file) => {
    const text = await file.text()
    const manifest = parseSkillMdToManifest(text, file.name.replace(/\.md$/i, ''))
    if (!manifest || !manifest.id) {
      throw new Error('无效的 Skill 文件，请确认文件为正确的 SKILL.md 格式')
    }

    const skill: SkillManifest = {
      ...manifest,
      source: manifest.source === 'built-in' ? 'local' : manifest.source,
      updatedAt: new Date().toISOString(),
    }

    await writeSkill(skill)
    set((s) => ({
      skills: s.skills.some((sk) => sk.id === skill.id)
        ? s.skills.map((sk) => (sk.id === skill.id ? skill : sk))
        : [...s.skills, skill],
      activeSkillIds: s.activeSkillIds.includes(skill.id)
        ? s.activeSkillIds
        : [...s.activeSkillIds, skill.id],
    }))
  },

  exportToFile: (id) => {
    const skill = get().skills.find((s) => s.id === id)
    if (!skill) return

    const content = skillToMarkdown(skill)
    const blob = new Blob([content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${skill.id}.SKILL.md`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  },

  createSkill: async (data) => {
    const skill: SkillManifest = {
      id: generateId(),
      name: data.name || '未命名 Skill',
      description: data.description || '',
      version: '1.0.0',
      author: data.author || 'User',
      type: data.type || 'custom',
      tags: data.tags || [],
      icon: data.icon || 'Puzzle',
      trigger: data.trigger || { mode: 'manual' },
      prompt: data.prompt || '',
      enabled: true,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: 'local',
      ...data,
    }
    await writeSkill(skill)
    set((s) => ({ skills: [...s.skills, skill] }))
    return skill
  },

  getEnabledSkills: () => {
    return get().skills.filter((s) => s.enabled)
  },

  getActiveSkillsForMessage: (message) => {
    const enabled = get().getEnabledSkills()
    return enabled.filter((skill) => {
      if (skill.trigger.mode === 'always') return true
      if (skill.trigger.mode === 'keyword' && skill.trigger.keywords) {
        const lower = message.toLowerCase()
        return skill.trigger.keywords.some((kw) => lower.includes(kw.toLowerCase()))
      }
      return false
    })
  },
}))

// ==================== 内置 Skill ====================

const BUILT_IN_SKILL_IDS = [
  'word-professional-report',
  'excel-data-analysis',
  'pptx-presentation',
]

async function loadBuiltInSkills(): Promise<SkillManifest[]> {
  const skills: SkillManifest[] = []
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')

  for (const id of BUILT_IN_SKILL_IDS) {
    try {
      const res = await fetch(`${base}/skills/${id}.SKILL.md`)
      if (!res.ok) {
        console.warn(`[skillStore] 内置 Skill 资源加载失败: ${id}`)
        continue
      }
      const text = await res.text()
      const manifest = parseSkillMdToManifest(text, id)
      if (manifest) {
        skills.push(manifest)
      }
    } catch (err) {
      console.warn(`[skillStore] 加载内置 Skill 失败: ${id}`, err)
    }
  }

  return skills
}

async function syncBuiltInSkills(skills: SkillManifest[]): Promise<void> {
  const builtIns = await loadBuiltInSkills()
  const builtInIds = new Set(builtIns.map((s) => s.id))

  // 清理已不再是内置的 skill（如下架/合并的内置 skill），避免僵尸条目残留
  for (let i = skills.length - 1; i >= 0; i--) {
    const skill = skills[i]
    if (skill.source === 'built-in' && !builtInIds.has(skill.id)) {
      try {
        await deleteSkill(skill.id)
        skills.splice(i, 1)
      } catch (err) {
        console.warn(`[skillStore] 清理废弃内置 skill 失败: ${skill.id}`, err)
      }
    }
  }

  for (const skill of builtIns) {
    const exists = skills.find((s) => s.id === skill.id)
    if (!exists) {
      await writeSkill(skill)
      skills.push(skill)
    } else if (exists.source === 'built-in' && exists.version !== skill.version) {
      await writeSkill(skill)
      const idx = skills.findIndex((s) => s.id === skill.id)
      if (idx >= 0) skills[idx] = skill
    }
  }
}

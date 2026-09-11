import { create } from 'zustand'
import type { SkillManifest, SkillUsageStat } from '@/types/skill'
import {
  parseSkillMdToManifest,
  skillToMarkdown,
} from '@/utils/workspaceStorage'
import { skillApi } from '@/api/skillApi'
import { withRetry } from '@/utils/retry'
import { useConversationStore } from '@/stores/conversationStore'
import { buildDomainPackSkills } from '@/agent/domainPackSkills'


interface SkillStoreState {
  skills: SkillManifest[]
  /** 用户挂载（pin）的技能 id：正文常驻 system section，语义=用户强制本场有效 */
  activeSkillIds: string[]
  /** 技能用量统计（运行态，持久化在前端本地，驱动管理页排序与斜杠菜单 recency） */
  usageStats: Record<string, SkillUsageStat>
  isLoading: boolean
  /** 是否完成过首次加载（2026-08-09 排版闪帧根治）：区分"从未加载"与"已有数据在刷新"——
   *  视图据此决定首帧渲染骨架还是直接铺存量行，杜绝"空状态闪一帧→骨架→真行"的三段跳 */
  hasLoaded: boolean
  isWorkspaceConnected: boolean
  isFallbackMode: boolean
  workspacePath: string | null
  /** 技能根目录绝对路径（MESCLI 车道从后端取；Standalone 为 null）。模型清单头注入用 */
  skillsDir: string | null

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
  recordSkillUsage(id: string): void

  importFromFile(file: File): Promise<void>
  exportToFile(id: string): void
  createSkill(data: Partial<SkillManifest>): Promise<SkillManifest>

  getEnabledSkills(): SkillManifest[]

  /**
   * @deprecated v1 关键词触发已随 SKILL v2 退役（见 types/skill.ts 头注）。
   * 仅为兼容仍走 v1 注入路径的调用方保留（chatStore/agentSwarmStore
   * 的未迁版本）：v2 语义下消息不再触发技能注入，恒返回空——手动 pin（activeSkillIds）
   * 由调用方自行合并，enabled 技能经元数据清单（层级 1）常驻。
   */
  getActiveSkillsForMessage(message: string): SkillManifest[]
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

async function listSkills(): Promise<SkillManifest[]> {
  return skillApi.listSkills()
}

async function readSkill(id: string): Promise<SkillManifest | null> {
  return skillApi.readSkill(id)
}

async function writeSkill(skill: SkillManifest): Promise<void> {
  await skillApi.writeSkill(skill)
}

async function deleteSkill(id: string): Promise<void> {
  await skillApi.deleteSkill(id)
}

/** 用量统计持久化（localStorage）：前端是 agent 闭环，用量天然是按客户端统计的运行态 */
const USAGE_STORAGE_KEY = 'wonwork_skill_usage'

function loadUsageStats(): Record<string, SkillUsageStat> {
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, SkillUsageStat>) : {}
  } catch {
    return {}
  }
}

/**
 * pin 会话级持久化（2026-08-09 第二波，审计缺口修复）：
 * activeSkillIds 原是全局纯内存态——刷新即丢、切会话串台。现按会话 id 分桶存
 * localStorage，订阅 conversationStore 切换即恢复对应桶；无会话（尚未建会话）落 'none' 桶。
 * skillStore ← conversationStore 单向引用，无环（chatStore 同时引用两者）。
 */
const PINS_STORAGE_KEY = 'wonwork_skill_pins'

function loadPinsMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(PINS_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {}
  } catch {
    return {}
  }
}

function pinsKeyOf(conversationId: number | null): string {
  return conversationId != null ? String(conversationId) : 'none'
}

let currentPinsKey = pinsKeyOf(useConversationStore.getState().currentConversationId)

function persistPins(ids: string[]): void {
  try {
    const map = loadPinsMap()
    if (ids.length > 0) map[currentPinsKey] = ids
    else delete map[currentPinsKey]
    localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 存储满等异常不影响主流程
  }
}

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  skills: [],
  activeSkillIds: loadPinsMap()[currentPinsKey] ?? [],
  usageStats: loadUsageStats(),
  isLoading: false,
  hasLoaded: false,
  isWorkspaceConnected: false,
  isFallbackMode: false,
  workspacePath: null,
  skillsDir: null,

  init: async () => {
    set({ isLoading: true })
    try {
      await withRetry(async () => {
        // 【Iris】standalone 已删除，恒走后端托管工作区（MESCLI 车道）
        const skills = await listSkills()
        await syncBuiltInSkills(skills)
        // 技能根目录绝对路径（2026-09-03 文件化）：注入清单头，模型用文件原语直读 SKILL.md
        const skillsDir = await skillApi.getDir()

        set({
          skills,
          isWorkspaceConnected: true,
          isFallbackMode: false,
          workspacePath: skillsDir ?? '{UserProfile}\\.wonwork\\skills',
          skillsDir,
          isLoading: false,
          hasLoaded: true,
        })
      }, {
        maxRetries: 1,
        baseDelayMs: 300,
      })
    } catch (err) {
      console.error('Skill Store 初始化失败:', err)
      // 失败也落 hasLoaded——视图据此显示空态/错误而非永远转骨架
      set({ isLoading: false, hasLoaded: true })
    }
  },

  pickWorkspace: async () => {
    // 【Iris】standalone 已删除，无本地工作区可选
  },

  reconnectWorkspace: async () => {
    // 【Iris】standalone 已删除，无本地工作区可重连
  },

  disconnectWorkspace: async () => {
    // 【Iris】standalone 已删除，无本地工作区可断开
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
    persistPins(get().activeSkillIds)
  },

  updateSkill: async (id, updates) => {
    // 先重读磁盘再合并（2026-09-03 审计修复）：模型可能用文件原语改过 SKILL.md 正文，
    // 用内存旧 manifest 整文件重写会把模型改动盖掉
    const fresh = await readSkill(id).catch(() => null)
    const base = fresh ?? get().skills.find((s) => s.id === id)
    if (!base) return

    const updated: SkillManifest = { ...base, ...updates, updatedAt: new Date().toISOString() }
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
    persistPins(get().activeSkillIds)
  },

  unloadSkill: (id) => {
    set((s) => ({
      activeSkillIds: s.activeSkillIds.filter((aid) => aid !== id),
    }))
    persistPins(get().activeSkillIds)
  },

  recordSkillUsage: (id) => {
    set((s) => {
      const prev = s.usageStats[id]
      const usageStats = {
        ...s.usageStats,
        [id]: { count: (prev?.count ?? 0) + 1, lastUsedAt: new Date().toISOString() },
      }
      try {
        localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(usageStats))
      } catch {
        // 存储满等异常不影响主流程
      }
      return { usageStats }
    })
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
      whenToUse: data.whenToUse || '',
      domain: data.domain || 'general',
      keywords: data.keywords || [],
      version: '1.0.0',
      author: data.author || 'User',
      icon: data.icon || 'Puzzle',
      prompt: data.prompt || '',
      enabled: true,
      userInvocable: true,
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

  // v1 兼容壳：关键词/always 触发已退役，消息不再触发技能（见接口处 @deprecated 说明）
  getActiveSkillsForMessage: (_message) => {
    return []
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

  // 域知识包技能化（2026-08-09 S4）：程序化内置条目，单一事实来源=domainPacks.ts
  // （版本号驱动下面的同步覆盖，改包 bump version 即生效）
  skills.push(...buildDomainPackSkills())

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

// 会话切换 → 恢复对应 pin 桶（subscribe 每次 conversationStore 变更都触发，靠 key 比较短路）
useConversationStore.subscribe((state) => {
  const key = pinsKeyOf(state.currentConversationId)
  if (key === currentPinsKey) return
  currentPinsKey = key
  useSkillStore.setState({ activeSkillIds: loadPinsMap()[key] ?? [] })
})

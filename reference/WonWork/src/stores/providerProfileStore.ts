/**
 * 供应商预设库 store（2026-09-07 对齐 claude-code/cc-switch）
 *
 * 存储分层（与记忆/技能文件化同一模式）：
 * - 事实源 = ~/.wonwork/providers.json（后端 /api/providerprofiles 只存取文本）
 * - localStorage 缓存 = 离线/standalone 兜底 + 启动快读
 *
 * 迁移：首次加载且两边皆空时，把 localStorage 保险柜（wonwork_provider_keys）
 * 里的存量配置逐个导入为 profile，并尽量恢复"当前在用"——老用户零重配。
 */
import { create } from 'zustand'
import { providerProfilesApi } from '@/api/client'
import {
  deriveProfileRuntime,
  emptyProfileFile,
  generateProfileId,
  PROFILE_PROVIDER_PREFIX,
  type ProviderProfile,
  type ProviderProfileFile,
} from '@/types/providerProfile'

const CACHE_KEY = 'wonwork_provider_profiles'

interface ProviderProfileState {
  profiles: ProviderProfile[]
  activeId: string | null
  /** 首次加载完成（含迁移）后置 true */
  loaded: boolean
  /** 离线/standalone 时后端不可用，降级纯 localStorage */
  backendAvailable: boolean

  ensureLoaded: () => Promise<void>
  upsert: (profile: ProviderProfile) => Promise<void>
  remove: (id: string) => Promise<void>
  setActive: (id: string | null) => Promise<void>
  getActiveRuntime: () => ReturnType<typeof deriveProfileRuntime>
}

function readCache(): ProviderProfileFile | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ProviderProfileFile
    if (!parsed || !Array.isArray(parsed.profiles)) return null
    return { version: 1, activeId: parsed.activeId ?? null, profiles: parsed.profiles }
  } catch {
    return null
  }
}

function writeCache(file: ProviderProfileFile): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(file))
  } catch {
    // 缓存写不进不影响主链路
  }
}

/** 内置 anthropic 协议 id（迁移时识别 apiFormat） */
const ANTHROPIC_IDS = new Set(['claude', 'kimi-code', 'anthropic'])

/**
 * 一次性迁移：保险柜存量 → profiles。
 * 保险柜条目只有 apiKey/baseUrl/model 三字段，按 provider id 猜协议。
 */
function migrateFromVault(): ProviderProfileFile {
  const file = emptyProfileFile()
  // 保险柜没有枚举 API——读原始 localStorage 键拿全量
  let vault: Record<string, { apiKey?: string; baseUrl?: string; model?: string }> = {}
  try {
    const raw = localStorage.getItem('wonwork_provider_keys')
    if (raw) vault = JSON.parse(raw) ?? {}
  } catch {
    return file
  }

  const migratedFrom: string[] = [] // 与 file.profiles 同序的来源 provider id
  for (const [providerId, entry] of Object.entries(vault)) {
    if (!entry || (!entry.apiKey && !entry.baseUrl && !entry.model)) continue
    const anthropic = ANTHROPIC_IDS.has(providerId)
    const profile: ProviderProfile = {
      id: generateProfileId(),
      name: providerId,
      category: 'custom',
      settingsConfig: anthropic
        ? {
            env: {
              ANTHROPIC_BASE_URL: entry.baseUrl ?? '',
              ANTHROPIC_AUTH_TOKEN: entry.apiKey ?? '',
              ANTHROPIC_MODEL: entry.model ?? '',
            },
          }
        : {
            env: {
              OPENAI_BASE_URL: entry.baseUrl ?? '',
              OPENAI_API_KEY: entry.apiKey ?? '',
              OPENAI_MODEL: entry.model ?? '',
            },
          },
      meta: { apiFormat: anthropic ? 'anthropic' : 'openai' },
      createdAt: Date.now(),
    }
    if (deriveProfileRuntime(profile)) {
      file.profiles.push(profile)
      migratedFrom.push(providerId)
    }
  }

  // 恢复"当前在用"：wonclaw_active_provider 的 provider 命中某迁移条目即设为 active
  try {
    const raw = localStorage.getItem('wonclaw_active_provider')
    if (raw) {
      const active = JSON.parse(raw) as { provider?: string }
      const idx = migratedFrom.indexOf(active.provider ?? '')
      if (idx >= 0) file.activeId = file.profiles[idx].id
    }
  } catch {
    // 存档损坏不影响迁移主体
  }
  return file
}

let loadPromise: Promise<void> | null = null

export const useProviderProfileStore = create<ProviderProfileState>((set, get) => {
  const persist = async (file: ProviderProfileFile, backendAvailable: boolean) => {
    const stamped: ProviderProfileFile = { ...file, updatedAt: Date.now() }
    writeCache(stamped)
    if (backendAvailable) {
      try {
        await providerProfilesApi.put(JSON.stringify(stamped))
      } catch {
        // 后端写失败：缓存已更新且带新戳，下次启动 ensureLoaded 按 updatedAt 对齐回填。
        // 置 false 让本次会话后续写不再徒劳打后端（2026-09-07 修复：原静默吞掉会
        // 留下"缓存新/后端旧"分叉，下次启动后端优先=刚加的供应商刷新后消失）
        set({ backendAvailable: false })
      }
    }
  }

  return {
    profiles: [],
    activeId: null,
    loaded: false,
    backendAvailable: true,

    ensureLoaded: async () => {
      if (get().loaded) return
      if (!loadPromise) {
        loadPromise = (async () => {
          // 1. 后端可达（文件可能不存在/损坏/陈旧，分开处理）
          try {
            const { content } = await providerProfilesApi.get()
            // 解析失败=内容损坏，不当后端不可用（2026-09-07 修复：原落外层 catch 置
            // backendAvailable=false，此后永不写后端，损坏文件永不自愈）
            let backendFile: ProviderProfileFile | null = null
            if (content) {
              try {
                const parsed = JSON.parse(content) as ProviderProfileFile
                if (parsed && Array.isArray(parsed.profiles)) {
                  backendFile = { version: 1, activeId: parsed.activeId ?? null, profiles: parsed.profiles, updatedAt: parsed.updatedAt ?? 0 }
                }
              } catch {
                // 损坏文件：交给下方缓存/迁移分支，persist 回填即修复
              }
            }
            const cached = readCache()
            // 2. 分叉对齐：updatedAt 新的赢（无戳旧数据视为 0=最旧）
            const backendNewer = backendFile && (backendFile.updatedAt ?? 0) >= (cached?.updatedAt ?? 0)
            if (backendFile && (backendNewer || !cached || cached.profiles.length === 0)) {
              writeCache(backendFile)
              set({ profiles: backendFile.profiles, activeId: backendFile.activeId, loaded: true, backendAvailable: true })
              return
            }
            // 3. 缓存较新（上次 PUT 失败遗留）或后端空/损坏 → 用缓存并回填后端
            if (cached && cached.profiles.length > 0) {
              set({ profiles: cached.profiles, activeId: cached.activeId, loaded: true, backendAvailable: true })
              void persist(cached, true)
              return
            }
            // 4. 两边皆空 → 迁移保险柜
            const migrated = migrateFromVault()
            set({ profiles: migrated.profiles, activeId: migrated.activeId, loaded: true, backendAvailable: true })
            if (migrated.profiles.length > 0) {
              writeCache(migrated)
              void persist(migrated, true)
            }
          } catch {
            // 后端不可用：缓存兜底，再不行迁移（不写回后端）
            const cached = readCache()
            if (cached) {
              set({ profiles: cached.profiles, activeId: cached.activeId, loaded: true, backendAvailable: false })
            } else {
              const migrated = migrateFromVault()
              if (migrated.profiles.length > 0) writeCache(migrated)
              set({ profiles: migrated.profiles, activeId: migrated.activeId, loaded: true, backendAvailable: false })
            }
          }
        })().finally(() => {
          loadPromise = null
        })
      }
      await loadPromise
    },

    upsert: async (profile) => {
      await get().ensureLoaded()
      const profiles = [...get().profiles]
      const idx = profiles.findIndex((p) => p.id === profile.id)
      if (idx >= 0) profiles[idx] = profile
      else profiles.push(profile)
      const file: ProviderProfileFile = { version: 1, activeId: get().activeId, profiles }
      set({ profiles })
      await persist(file, get().backendAvailable)
    },

    remove: async (id) => {
      await get().ensureLoaded()
      const profiles = get().profiles.filter((p) => p.id !== id)
      const activeId = get().activeId === id ? null : get().activeId
      const file: ProviderProfileFile = { version: 1, activeId, profiles }
      set({ profiles, activeId })
      await persist(file, get().backendAvailable)
    },

    setActive: async (id) => {
      await get().ensureLoaded()
      const file: ProviderProfileFile = { version: 1, activeId: id, profiles: get().profiles }
      set({ activeId: id })
      await persist(file, get().backendAvailable)
    },

    getActiveRuntime: () => {
      const { profiles, activeId } = get()
      const profile = profiles.find((p) => p.id === activeId)
      return profile ? deriveProfileRuntime(profile) : null
    },
  }
})

export { PROFILE_PROVIDER_PREFIX }

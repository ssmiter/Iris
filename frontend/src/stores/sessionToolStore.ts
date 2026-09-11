import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ToolCatalogItem } from '@/types/mescli'
import type { RuntimeMode } from '@/utils/runtimeMode'

/**
 * 会话级工具状态存储
 *
 * M1 工具生命周期基调：L2 Demo / L3 MES 工具在会话启动时通过 /api/capabilities
 * 静态投影到当前会话， discovered 工具在会话内持续可用，页面刷新后恢复。
 */

interface SessionToolEntry {
  /** 后端返回的完整工具目录（静态投影） */
  catalog: ToolCatalogItem[]
  /**
   * 旧格式：已发现工具名数组（2026-08-05 租约化前）。
   * 仅用于兼容读取——persist 里的老会话恢复时迁移进 discoveredLeases（租约时间 0 = 最老，
   * 优先成为驱逐候选，方向安全）；写入路径不再产生此字段。
   */
  discoveredNames?: string[]
  /** 已发现工具的租约表（小写名 → 最近使用时间戳，2026-08-05 租约式生命周期） */
  discoveredLeases?: Record<string, number>
  /** 加载时间戳 */
  loadedAt: number
  /** 加载时的运行时模式 */
  mode: RuntimeMode
  /** 加载时的 systemCode */
  systemCode?: string
  /** 后端 capabilities.features（用于每轮重算 frontend_loop_online 等开关，缓存命中也要能读到） */
  features?: string[]
  /** 后端实时生成的业务域宏观洞察（注入系统提示用） */
  domainInsight?: string
}

interface SessionToolState {
  sessions: Record<number, SessionToolEntry>

  /**
   * 确保指定会话已加载后端工具目录。
   * 如果已存在且模式/systemCode 未变，则直接返回缓存目录。
   */
  ensureSessionTools(
    conversationId: number,
    mode: RuntimeMode,
    systemCode: string | undefined,
    fetcher: () => Promise<{ tools: ToolCatalogItem[]; features: string[]; domainInsight?: string }>
  ): Promise<{ tools: ToolCatalogItem[]; features: string[]; domainInsight?: string }>

  /** 获取某会话已发现的工具名集合（新旧格式并集） */
  getDiscoveredNames(conversationId: number): Set<string>

  /** 获取某会话的租约表（小写名 → 最近使用时间戳；旧格式名字按 0 处理） */
  getDiscoveredLeases(conversationId: number): Map<string, number>

  /** 向某会话追加发现工具租约（同名取较新时间戳） */
  addDiscoveredLeases(conversationId: number, leases: { name: string; lastUsedAt: number }[]): void

  /** 租约驱逐：从某会话移除工具（新旧格式都清） */
  removeDiscoveredNames(conversationId: number, names: string[]): void

  /** loop 收尾租约表权威回写（loop 内续租只在内存，收尾一次性落盘） */
  syncDiscoveredLeases(conversationId: number, leases: Record<string, number>): void

  /** 清除某会话的工具缓存（切换模式/登出时） */
  clearSession(conversationId: number): void
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/** 新旧格式合并出租约表：旧格式名字按 0（最老）处理，租约表同名优先 */
function entryLeases(entry: SessionToolEntry | undefined): Record<string, number> {
  const leases: Record<string, number> = {}
  for (const name of entry?.discoveredNames ?? []) {
    leases[normalizeName(name)] = 0
  }
  for (const [name, ts] of Object.entries(entry?.discoveredLeases ?? {})) {
    leases[normalizeName(name)] = ts
  }
  return leases
}

export const useSessionToolStore = create<SessionToolState>()(
  persist(
    (set, get) => ({
      sessions: {},

      ensureSessionTools: async (conversationId, mode, systemCode, fetcher) => {
        const existing = get().sessions[conversationId]
        const now = Date.now()
        const isFresh =
          existing &&
          // persist 落盘时剔除 catalog，rehydrate 回来的条目该键缺失，用 ?. 防御
          (existing.catalog?.length ?? 0) > 0 &&
          existing.mode === mode &&
          existing.systemCode === systemCode &&
          now - existing.loadedAt < SESSION_TTL_MS &&
          // 旧缓存（本次修复前写入）没有 features，视为不新鲜以触发一次重拉填充，避免 Online 第二轮仍回落旧 ChatService
          existing.features !== undefined

        if (isFresh) {
          // 缓存命中也要返回 features，供调用方每轮重算 frontend_loop_online。
          // 之前该开关靠 fetcher 副作用赋值，缓存命中时 fetcher 被跳过，第二轮起 enableFrontendToolLoop 回落 false，
          // 请求落入旧 ChatService(/api/chat/stream-sse)，报“对话不存在或无权限访问”。
          return {
            tools: existing.catalog,
            features: existing.features ?? [],
            domainInsight: existing.domainInsight,
          }
        }

        const { tools, features, domainInsight } = await fetcher()
        set((state) => ({
          sessions: {
            ...state.sessions,
            [conversationId]: {
              catalog: tools,
              discoveredNames: existing?.discoveredNames,
              discoveredLeases: existing?.discoveredLeases,
              loadedAt: now,
              mode,
              systemCode,
              features,
              domainInsight,
            },
          },
        }))
        return { tools, features, domainInsight }
      },

      getDiscoveredNames: (conversationId) => {
        return new Set(Object.keys(entryLeases(get().sessions[conversationId])))
      },

      getDiscoveredLeases: (conversationId) => {
        return new Map(Object.entries(entryLeases(get().sessions[conversationId])))
      },

      addDiscoveredLeases: (conversationId, leases) => {
        if (!leases.length) return
        set((state) => {
          const entry = state.sessions[conversationId]
          const merged = entryLeases(entry)
          for (const { name, lastUsedAt } of leases) {
            const key = normalizeName(name)
            merged[key] = Math.max(merged[key] ?? 0, lastUsedAt)
          }
          return {
            sessions: {
              ...state.sessions,
              [conversationId]: {
                catalog: entry?.catalog ?? [],
                // 写入即完成新旧格式迁移：旧数组字段不再回写
                discoveredLeases: merged,
                loadedAt: entry?.loadedAt ?? Date.now(),
                mode: entry?.mode ?? 'mescli-local',
                systemCode: entry?.systemCode,
                features: entry?.features,
                domainInsight: entry?.domainInsight,
              },
            },
          }
        })
      },

      removeDiscoveredNames: (conversationId, names) => {
        if (!names.length) return
        set((state) => {
          const entry = state.sessions[conversationId]
          if (!entry) return state
          const merged = entryLeases(entry)
          for (const name of names) {
            delete merged[normalizeName(name)]
          }
          return {
            sessions: {
              ...state.sessions,
              [conversationId]: {
                ...entry,
                catalog: entry.catalog ?? [],
                discoveredNames: undefined,
                discoveredLeases: merged,
              },
            },
          }
        })
      },

      syncDiscoveredLeases: (conversationId, leases) => {
        set((state) => {
          const entry = state.sessions[conversationId]
          if (!entry) return state
          return {
            sessions: {
              ...state.sessions,
              [conversationId]: {
                ...entry,
                catalog: entry.catalog ?? [],
                discoveredNames: undefined,
                discoveredLeases: leases,
              },
            },
          }
        })
      },

      clearSession: (conversationId) => {
        set((state) => {
          const next = { ...state.sessions }
          delete next[conversationId]
          return { sessions: next }
        })
      },
    }),
    {
      name: 'wonwork_session_tools',
      // 工具 schema 数量很大，完整持久化会超过浏览器 Storage 配额。
      // 刷新后重新拉取目录，只持久化很小的发现状态和功能开关。
      // 2026-07-31 形状收敛：解构剔除 catalog（原先是展开后覆盖 catalog: [] 的僵尸字段）；
      // 无任何可复用信息的条目（无发现工具/无 features/无洞察）回话后必然重拉，不落盘。
      partialize: (state) => ({
        sessions: Object.fromEntries(
          Object.entries(state.sessions)
            .filter(
              ([, entry]) =>
                (entry.discoveredNames?.length ?? 0) > 0 ||
                Object.keys(entry.discoveredLeases ?? {}).length > 0 ||
                entry.features ||
                entry.domainInsight
            )
            .map(([id, { catalog: _dropped, ...rest }]) => [id, rest])
        ),
      }),
    }
  )
)

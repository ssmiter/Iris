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
  /** 已通过 tool_search 发现的工具名（小写） */
  discoveredNames: string[]
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

  /** 获取某会话已发现的工具名集合 */
  getDiscoveredNames(conversationId: number): Set<string>

  /** 向某会话追加 discovered 工具名 */
  addDiscoveredNames(conversationId: number, names: string[]): void

  /** 清除某会话的工具缓存（切换模式/登出时） */
  clearSession(conversationId: number): void
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
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
          existing.catalog.length > 0 &&
          existing.mode === mode &&
          existing.systemCode === systemCode &&
          now - existing.loadedAt < SESSION_TTL_MS &&
          // 旧缓存（本次修复前写入）没有 features，视为不新鲜以触发一次重拉填充，避免 Online 第二轮仍回落旧 ChatService
          existing.features !== undefined

        if (isFresh) {
          // 缓存命中也要返回 features，供调用方每轮重算 frontend_loop_online。
          // 之前该开关靠 fetcher 副作用赋值，缓存命中时 fetcher 被跳过，第二轮起 enableFrontendToolLoop 回落 false，
          // 请求落入旧 ChatService(/api/chat/stream-sse)，报"对话不存在或无权限访问"。
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
              discoveredNames: existing?.discoveredNames ?? [],
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
        const entry = get().sessions[conversationId]
        return new Set(entry?.discoveredNames ?? [])
      },

      addDiscoveredNames: (conversationId, names) => {
        if (!names.length) return
        set((state) => {
          const entry = state.sessions[conversationId]
          const base = entry?.discoveredNames ?? []
          const merged = new Set(base)
          for (const name of names) {
            merged.add(normalizeName(name))
          }
          return {
            sessions: {
              ...state.sessions,
              [conversationId]: {
                catalog: entry?.catalog ?? [],
                discoveredNames: Array.from(merged),
                loadedAt: entry?.loadedAt ?? Date.now(),
                mode: entry?.mode ?? 'mescli-local',
                systemCode: entry?.systemCode,
                features: entry?.features,
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
      partialize: (state) => ({
        sessions: Object.fromEntries(
          Object.entries(state.sessions).map(([id, entry]) => [
            id,
            { ...entry, catalog: [] },
          ])
        ),
      }),
    }
  )
)

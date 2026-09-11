import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { apiKeyApi } from '@/api/apiKeyApi'
import type { ApiKeyDto, ApiKeyScope, ApiKeyProvider, CreateApiKeyRequest } from '@/types/mescli'

interface ApiKeyState {
  apiKeys: ApiKeyDto[]
  isLoading: boolean
  isCreating: boolean
  error: string | null

  loadApiKeys: () => Promise<void>
  createApiKey: (req: CreateApiKeyRequest) => Promise<ApiKeyDto | null>
  updateApiKey: (id: string, patch: { key?: string; baseUrl?: string }) => Promise<void>
  deleteApiKey: (id: string) => Promise<void>
  setDefaultApiKey: (id: string) => Promise<void>
  getDefaultApiKey: (scope?: ApiKeyScope) => ApiKeyDto | undefined
  clearError: () => void
}

export const useApiKeyStore = create<ApiKeyState>()(
  persist(
    (set, get) => ({
      apiKeys: [],
      isLoading: false,
      isCreating: false,
      error: null,

      loadApiKeys: async () => {
        set({ isLoading: true, error: null })
        try {
          const apiKeys = await apiKeyApi.getApiKeys()
          set({ apiKeys, isLoading: false })
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '加载 API Key 失败',
            isLoading: false,
          })
        }
      },

      createApiKey: async (req) => {
        set({ isCreating: true, error: null })
        try {
          const created = await apiKeyApi.createApiKey(req)
          set((s) => ({
            apiKeys: s.apiKeys
              .map((k): ApiKeyDto => ({ ...k, isDefault: req.isDefault ? false : k.isDefault }))
              .concat(created),
            isCreating: false,
          }))
          return created
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '创建 API Key 失败',
            isCreating: false,
          })
          return null
        }
      },

      updateApiKey: async (id, patch) => {
        set({ isLoading: true, error: null })
        try {
          const updated = await apiKeyApi.updateApiKey(id, patch)
          if (!updated) throw new Error('API Key 不存在')
          set((s) => ({
            apiKeys: s.apiKeys.map((k) => (k.id === id ? updated : k)),
            isLoading: false,
          }))
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '更新 API Key 失败',
            isLoading: false,
          })
          throw err
        }
      },

      deleteApiKey: async (id) => {
        set({ isLoading: true, error: null })
        try {
          await apiKeyApi.deleteApiKey(id)
          set((s) => ({
            apiKeys: s.apiKeys.filter((k) => k.id !== id),
            isLoading: false,
          }))
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '删除 API Key 失败',
            isLoading: false,
          })
        }
      },

      setDefaultApiKey: async (id) => {
        set({ isLoading: true, error: null })
        try {
          await apiKeyApi.setDefaultApiKey(id)
          set((s) => ({
            apiKeys: s.apiKeys.map((k): ApiKeyDto => ({ ...k, isDefault: k.id === id })),
            isLoading: false,
          }))
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '设置默认 API Key 失败',
            isLoading: false,
          })
        }
      },

      getDefaultApiKey: (scope) => {
        const keys = get().apiKeys
        const candidates = scope
          ? keys.filter((k) => k.scope === scope || k.scope === 'all')
          : keys
        return candidates.find((k) => k.isDefault) || candidates[0]
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'wonwork-apikeys',
      partialize: (state) => ({
        apiKeys: state.apiKeys,
      }),
    }
  )
)

/**
 * 按 provider 找可用 BYOK Key（非平台托管、有 Key、scope 覆盖目标场景，优先默认项）。
 * 供对话凭据解析（chatStore.resolveProviderCredentials）与下拉 Key 状态探测（ChatView）
 * 共用——原来只认"默认 Key"，多 Key 并存时选中非默认 provider 会落空。
 */
export function findByokApiKey(provider: string, scope: ApiKeyScope = 'chat'): ApiKeyDto | undefined {
  const candidates = useApiKeyStore
    .getState()
    .apiKeys.filter(
      (k) =>
        !k.isPlatformManaged &&
        !!k.key &&
        k.provider === provider &&
        (k.scope === scope || k.scope === 'all')
    )
  return candidates.find((k) => k.isDefault) || candidates[0]
}

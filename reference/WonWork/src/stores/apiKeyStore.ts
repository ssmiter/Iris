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

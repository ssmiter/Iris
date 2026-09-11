import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  localModelApi,
  OLLAMA_DEFAULT_BASE_URL,
  LMSTUDIO_DEFAULT_BASE_URL,
} from '@/api/localModelApi'
import type { LocalModelConfig, LocalModelInfo, LocalModelProvider, ProviderConfig } from '@/types/mescli'

interface LocalModelState {
  config: LocalModelConfig
  models: LocalModelInfo[]
  isAvailable: boolean
  isDetecting: boolean
  error: string | null

  setProvider: (provider: LocalModelProvider) => void
  setBaseUrl: (baseUrl: string) => void
  setModel: (model: string) => void
  setApiKey: (apiKey: string) => void
  detect: () => Promise<void>
  clearError: () => void
  getProviderConfigs: () => ProviderConfig[]
  getDefaultProviderConfig: () => ProviderConfig | null
}

const LOCAL_MODEL_STORAGE_KEY = 'wonwork_local_model_config'

function readConfig(): LocalModelConfig {
  const raw = localStorage.getItem(LOCAL_MODEL_STORAGE_KEY)
  if (raw) {
    try {
      return JSON.parse(raw) as LocalModelConfig
    } catch {
      // ignore
    }
  }
  return {
    provider: 'ollama',
    baseUrl: OLLAMA_DEFAULT_BASE_URL,
  }
}

function saveConfig(config: LocalModelConfig): void {
  localStorage.setItem(LOCAL_MODEL_STORAGE_KEY, JSON.stringify(config))
}

function defaultBaseUrl(provider: LocalModelProvider): string {
  switch (provider) {
    case 'ollama':
      return OLLAMA_DEFAULT_BASE_URL
    case 'lmstudio':
      return LMSTUDIO_DEFAULT_BASE_URL
    case 'webllm':
      return ''
    default:
      return ''
  }
}

export const useLocalModelStore = create<LocalModelState>()(
  persist(
    (set, get) => ({
      config: readConfig(),
      models: [],
      isAvailable: false,
      isDetecting: false,
      error: null,

      setProvider: (provider) => {
        const config = { ...get().config, provider, baseUrl: defaultBaseUrl(provider) }
        saveConfig(config)
        set({ config, models: [], isAvailable: false, error: null })
      },

      setBaseUrl: (baseUrl) => {
        const config = { ...get().config, baseUrl }
        saveConfig(config)
        set({ config })
      },

      setModel: (model) => {
        const config = { ...get().config, model }
        saveConfig(config)
        set({ config })
      },

      setApiKey: (apiKey) => {
        const config = { ...get().config, apiKey }
        saveConfig(config)
        set({ config })
      },

      detect: async () => {
        set({ isDetecting: true, error: null })
        try {
          const models = await localModelApi.listModels(get().config)
          set({
            models,
            isAvailable: models.length > 0,
            isDetecting: false,
            error: models.length === 0 ? '未检测到可用模型' : null,
          })
        } catch (err) {
          set({
            models: [],
            isAvailable: false,
            isDetecting: false,
            error: err instanceof Error ? err.message : '检测本地模型失败',
          })
        }
      },

      clearError: () => set({ error: null }),

      getProviderConfigs: () => {
        const { config, models } = get()
        if (models.length > 0) {
          return models.map((m) => ({
            provider: m.provider,
            model: m.id,
            baseUrl: m.baseUrl || config.baseUrl || '',
          }))
        }
        if (config.model) {
          return [
            {
              provider: config.provider,
              model: config.model,
              baseUrl: config.baseUrl,
            },
          ]
        }
        return []
      },

      getDefaultProviderConfig: () => {
        const configs = get().getProviderConfigs()
        return configs[0] || null
      },
    }),
    {
      name: 'wonwork-local-model',
      partialize: (state) => ({
        config: state.config,
      }),
    }
  )
)

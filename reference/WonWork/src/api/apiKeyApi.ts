import type { ApiKeyDto, CreateApiKeyRequest } from '@/types/mescli'

const API_KEY_STORAGE_KEY = 'wonwork_api_keys'

function readStoredKeys(): ApiKeyDto[] {
  const raw = localStorage.getItem(API_KEY_STORAGE_KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as ApiKeyDto[]
  } catch {
    return []
  }
}

function saveStoredKeys(keys: ApiKeyDto[]): void {
  localStorage.setItem(API_KEY_STORAGE_KEY, JSON.stringify(keys))
}

/**
 * BYOK（用户自备 Key）统一为客户端本地存储。
 *
 * 历史：曾按构建目标分流——preview 走 localStorage，mescli/online 走后端
 * /api/apikeys，但后端从未实现该端点（POST 恒 404），导致非 preview 构建里
 * BYOK 无法保存。BYOK 的本质就是"这把 key 只属于这台设备上的我"（对话时由
 * resolveProviderCredentials 从 apiKeyStore 直接取用），客户端存储是正确语义；
 * 若未来需要跨设备同步，再引入后端端点（届时注意密钥加密与归属隔离）。
 */
const localApiKeyApi = {
  getApiKeys: async (): Promise<ApiKeyDto[]> => {
    return readStoredKeys()
  },

  createApiKey: async (req: CreateApiKeyRequest): Promise<ApiKeyDto> => {
    const keys = readStoredKeys()
    const newKey: ApiKeyDto = {
      id: `ak-${Date.now().toString(36)}`,
      name: req.name,
      provider: req.provider,
      baseUrl: req.baseUrl,
      key: req.key,
      keyHint: `${req.key.slice(0, 4)}****${req.key.slice(-4)}`,
      scope: req.scope || 'all',
      isDefault: req.isDefault ?? false,
      isPlatformManaged: false,
      createdAt: new Date().toISOString(),
    }

    // 若新 Key 设为默认，取消其他默认
    if (newKey.isDefault) {
      keys.forEach((k) => {
        k.isDefault = false
      })
    }

    keys.push(newKey)
    saveStoredKeys(keys)
    return newKey
  },

  deleteApiKey: async (id: string): Promise<{ success: boolean }> => {
    const keys = readStoredKeys().filter((k) => k.id !== id)
    saveStoredKeys(keys)
    return { success: true }
  },

  setDefaultApiKey: async (id: string): Promise<{ success: boolean }> => {
    const keys = readStoredKeys()
    keys.forEach((k) => {
      k.isDefault = k.id === id
    })
    saveStoredKeys(keys)
    return { success: true }
  },
}

export const apiKeyApi = localApiKeyApi

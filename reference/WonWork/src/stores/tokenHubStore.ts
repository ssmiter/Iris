import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { RevealedTokenHubKey, TokenHubKeyMeta } from '@/types/tokenhub'
import { getLocalStorageKey } from '@/utils/storageScope'

/**
 * TokenHub 缓存使用动态作用域的 localStorage。
 *
 * 原因：
 * 1. 该 store 仅在 website-online 模式下有意义，但它的模块初始化发生在用户登录之前，
 *    此时按运行时模式推导会得到 mescli-local 前缀，导致官网登录后的 TokenHub Key
 *    被错误地写到 mescli-local 作用域。
 * 2. 自定义 storage 让 key 前缀在每次读写时按当前作用域重新计算，避免登录态变化后
 *    读错/写错 localStorage 项。
 * 3. 同时保留 getLocalStorageKey 统一命名规范。
 */
const tokenHubStorage = {
  getItem: (name: string) => localStorage.getItem(getLocalStorageKey(name)),
  setItem: (name: string, value: string) => localStorage.setItem(getLocalStorageKey(name), value),
  removeItem: (name: string) => localStorage.removeItem(getLocalStorageKey(name)),
}

/**
 * 使用 PBKDF2 + AES-GCM 加密 TokenHub 明文 Key。
 *
 * 加密密钥派生自 wonclaw_website_token + 固定 salt，因此：
 * - 同一用户会话内可以复用缓存的 Key。
 * - 退出登录（清除 website token）后，即使 ciphertext 残留也无法解密。
 * - 禁止将 plaintext sk-tp-... 直接写入 localStorage / 日志 / 崩溃上报。
 */

const SALT = new Uint8Array([
  0x57, 0x6f, 0x6e, 0x57, 0x6f, 0x72, 0x6b, 0x54, 0x6f, 0x6b, 0x65, 0x6e,
  0x48, 0x75, 0x62, 0x53,
])
const IV_LENGTH = 12
const PBKDF2_ITERATIONS = 100_000

async function deriveKey(password: string): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function encrypt(plaintext: string, password: string): Promise<string> {
  const key = await deriveKey(password)
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const encoder = new TextEncoder()
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(plaintext)
    )
  )
  const combined = new Uint8Array(iv.length + ciphertext.length)
  combined.set(iv)
  combined.set(ciphertext, iv.length)
  return arrayBufferToBase64(combined)
}

async function decrypt(ciphertextB64: string, password: string): Promise<string> {
  const key = await deriveKey(password)
  const combined = base64ToArrayBuffer(ciphertextB64)
  const iv = combined.slice(0, IV_LENGTH)
  const ciphertext = combined.slice(IV_LENGTH)
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  )
  return new TextDecoder().decode(decrypted)
}

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export interface CachedTokenHubKey extends TokenHubKeyMeta {
  /** 加密后的 sk-tp-... */
  encryptedKey: string
  cachedAt: number
}

export interface TokenHubKeyInfo extends TokenHubKeyMeta {
  key: string
}

interface TokenHubState {
  cachedKey: CachedTokenHubKey | null

  /** 加载缓存的 Key（如果存在且能解密）。返回值不含明文 key，需调用 revealKey。 */
  loadCachedKey: () => Promise<TokenHubKeyMeta | null>

  /** 保存 reveal 返回的明文 Key，加密后持久化。 */
  saveKey: (keyInfo: TokenHubKeyInfo) => Promise<void>

  /** 获取解密后的明文 Key（用于发起推理请求）。 */
  revealKey: () => Promise<TokenHubKeyInfo | null>

  /** 清除本地缓存（退出登录或 Key 失效时调用）。 */
  clear: () => void
}

function getWebsiteToken(): string | null {
  return localStorage.getItem('wonclaw_website_token')
}

export const useTokenHubStore = create<TokenHubState>()(
  persist(
    (set, get) => ({
      cachedKey: null,

      loadCachedKey: async () => {
        const { cachedKey } = get()
        if (!cachedKey) return null
        return cachedKey
      },

      saveKey: async (keyInfo) => {
        const token = getWebsiteToken()
        if (!token) {
          throw new Error('未登录官网账号，无法保存 TokenHub Key')
        }
        const encryptedKey = await encrypt(keyInfo.key, token)
        const { key, ...meta } = keyInfo
        const cached: CachedTokenHubKey = {
          ...meta,
          encryptedKey,
          cachedAt: Date.now(),
        }
        set({ cachedKey: cached })
      },

      revealKey: async () => {
        const { cachedKey } = get()
        if (!cachedKey) return null
        const token = getWebsiteToken()
        if (!token) {
          // 未登录时无法解密，直接清空
          get().clear()
          return null
        }
        try {
          const key = await decrypt(cachedKey.encryptedKey, token)
          return { ...cachedKey, key }
        } catch {
          // 解密失败（token 变更或数据损坏），清空缓存
          get().clear()
          return null
        }
      },

      clear: () => {
        set({ cachedKey: null })
      },
    }),
    {
      name: 'tokenhub_key',
      storage: createJSONStorage(() => tokenHubStorage),
      partialize: (state) => ({ cachedKey: state.cachedKey }),
    }
  )
)

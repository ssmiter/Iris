import { create } from 'zustand'
import type { FavoriteItem } from '@/types/chat'
import { favoriteApi } from '@/api/client'
import { getErrorMessage } from '@/utils/error'
import { toast } from 'sonner'

interface FavoriteState {
  favorites: FavoriteItem[]
  isLoadingFavorites: boolean
  favoritesLoaded: boolean

  loadFavorites: () => Promise<void>
  addFavorite: (title: string, prompt: string) => Promise<void>
  updateFavorite: (id: number, title: string, prompt: string) => Promise<void>
  deleteFavorite: (id: number) => Promise<void>
}

export const useFavoriteStore = create<FavoriteState>((set, get) => ({
  favorites: [],
  isLoadingFavorites: false,
  favoritesLoaded: false,

  loadFavorites: async () => {
    if (get().isLoadingFavorites) return
    set({ isLoadingFavorites: true })
    try {
      const favorites = await favoriteApi.getFavorites()
      set({ favorites, favoritesLoaded: true })
    } catch (err) {
      const msg = getErrorMessage(err, '加载收藏失败')
      console.error('加载收藏失败', err)
      toast.error(msg)
    } finally {
      set({ isLoadingFavorites: false })
    }
  },

  addFavorite: async (title, prompt) => {
    try {
      await favoriteApi.addFavorite({ title, prompt })
      await get().loadFavorites()
    } catch (err) {
      const msg = getErrorMessage(err, '添加收藏失败')
      toast.error(msg)
    }
  },

  updateFavorite: async (id, title, prompt) => {
    try {
      await favoriteApi.updateFavorite(id, { title, prompt })
      set((s) => ({
        favorites: s.favorites.map((f) => (f.id === id ? { ...f, title, prompt } : f)),
      }))
    } catch (err) {
      const msg = getErrorMessage(err, '更新收藏失败')
      toast.error(msg)
    }
  },

  deleteFavorite: async (id) => {
    try {
      await favoriteApi.deleteFavorite(id)
      set((s) => ({ favorites: s.favorites.filter((f) => f.id !== id) }))
    } catch (err) {
      const msg = getErrorMessage(err, '删除收藏失败')
      toast.error(msg)
    }
  },
}))

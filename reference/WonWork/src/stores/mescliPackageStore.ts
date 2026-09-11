import { create } from 'zustand'
import { toast } from 'sonner'
import { mescliPackageApi } from '@/api/client'
import { invalidateCapabilityIndex } from '@/services/capabilityFs'
import type {
  MescliPackageListItem,
  MescliPackageSystemItem,
  MescliPackageUpdate,
  MescliPackageMutationResponse,
} from '@/types/mescliPackage'

interface MescliPackageState {
  packages: MescliPackageListItem[]
  systems: MescliPackageSystemItem[]
  updates: MescliPackageUpdate[]
  isLoading: boolean
  error: string | null
  restartRequired: boolean
  load: () => Promise<void>
  loadSystems: () => Promise<void>
  checkUpdates: () => Promise<void>
  install: (file: File) => Promise<void>
  pull: (code: string) => Promise<void>
  setEnabled: (packageId: string, isEnabled: boolean) => Promise<void>
  rollback: (packageId: string) => Promise<void>
  uninstall: (packageId: string) => Promise<void>
  clearError: () => void
  clearRestartNotice: () => void
}

const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

export const useMescliPackageStore = create<MescliPackageState>((set, get) => {
  const applyMutation = async (operation: () => Promise<MescliPackageMutationResponse>) => {
    const result = await operation()
    set((state) => ({ restartRequired: state.restartRequired || result.restartRequired }))
    // 诚实=真信号：后端 detail 带如实语义（热装成功/失败原因/是否需重启），直接吐司，不二次包装
    if (result.detail) toast.success(result.detail)
    // 包变更即失效能力索引：下一个新对话重新拉目录（进行中对话快照不变，代际守卫防在途回写）
    invalidateCapabilityIndex()
    await Promise.all([get().load(), get().loadSystems()])
  }

  return {
    packages: [],
    systems: [],
    updates: [],
    isLoading: false,
    error: null,
    restartRequired: false,

    load: async () => {
      set({ isLoading: true, error: null })
      try {
        set({ packages: await mescliPackageApi.list(), isLoading: false })
      } catch (error) {
        set({ error: message(error, '加载客户工具包失败'), isLoading: false })
      }
    },

    loadSystems: async () => {
      try {
        set({ systems: await mescliPackageApi.systems() })
      } catch {
        // 登录弹窗和应用启动不能被本地包状态读取失败阻断。
      }
    },

    checkUpdates: async () => {
      try {
        set({ updates: await mescliPackageApi.updates() })
      } catch {
        // 更新提示是非关键能力；离线时已安装工具继续正常工作。
      }
    },

    install: async (file) => {
      if (!file.name.toLowerCase().endsWith('.wwtool')) {
        const error = '请选择 .wwtool 客户工具包'
        set({ error })
        throw new Error(error)
      }
      set({ isLoading: true, error: null })
      try {
        await applyMutation(() => mescliPackageApi.install(file))
      } catch (error) {
        set({ error: message(error, '安装客户工具包失败') })
        throw error
      } finally {
        set({ isLoading: false })
      }
    },

    // Code 一键拉取（2026-08-20）：逐项如实吐司（失败红/装成绿），全部最新则一句说明；
    // Code 由视图持有，用完不落 store——刷新页面即清，不做持久化
    pull: async (code) => {
      set({ isLoading: true, error: null })
      try {
        const result = await mescliPackageApi.pull(code)
        const items = result.items ?? []
        for (const item of items) {
          if (item.outcome === 'failed') toast.error(`${item.packageId}：${item.detail ?? '拉取失败'}`)
          else if (item.outcome === 'installed' && item.detail) toast.success(item.detail)
        }
        if (items.length === 0) toast.info('该客户名下暂无可安装的工具包')
        else if (items.every((item) => item.outcome === 'up_to_date' || item.outcome === 'already_installed')) {
          toast.info('所有工具包均已是最新')
        }
        set((state) => ({ restartRequired: state.restartRequired || result.restartRequired }))
        // 与单包安装同一纪律：包变更即失效能力索引，下一个新对话重新拉目录
        invalidateCapabilityIndex()
        await Promise.all([get().load(), get().loadSystems()])
      } catch (error) {
        set({ error: message(error, '拉取客户工具包失败') })
      } finally {
        set({ isLoading: false })
      }
    },

    setEnabled: async (packageId, isEnabled) => {
      try {
        await applyMutation(() => mescliPackageApi.setEnabled(packageId, isEnabled))
      } catch (error) {
        set({ error: message(error, '切换工具包状态失败') })
      }
    },

    rollback: async (packageId) => {
      try {
        await applyMutation(() => mescliPackageApi.rollback(packageId))
      } catch (error) {
        set({ error: message(error, '回滚工具包失败') })
      }
    },

    uninstall: async (packageId) => {
      try {
        await applyMutation(() => mescliPackageApi.uninstall(packageId))
      } catch (error) {
        set({ error: message(error, '卸载工具包失败') })
      }
    },

    clearError: () => set({ error: null }),
    clearRestartNotice: () => set({ restartRequired: false }),
  }
})

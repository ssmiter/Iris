import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { paymentApi } from '@/api/paymentApi'
import type { Order, PaymentQrCode } from '@/types/mescli'

interface PaymentState {
  orders: Order[]
  currentOrder: Order | null
  currentQrCode: PaymentQrCode | null
  isLoading: boolean
  error: string | null

  loadOrders: () => Promise<void>
  createOrder: (planId: string, paymentMethod?: string) => Promise<Order | null>
  loadOrder: (orderId: string) => Promise<void>
  loadQrCode: (orderId: string) => Promise<void>
  submitProof: (orderId: string, proofImageUrl: string, note?: string) => Promise<boolean>
  /** 轮询订单状态，直到完成/取消/超时 */
  pollOrderStatus: (orderId: string, maxAttempts?: number) => Promise<Order | null>
  clearError: () => void
}

export const usePaymentStore = create<PaymentState>()(
  persist(
    (set, get) => ({
      orders: [],
      currentOrder: null,
      currentQrCode: null,
      isLoading: false,
      error: null,

      loadOrders: async () => {
        set({ isLoading: true, error: null })
        try {
          const orders = await paymentApi.getOrders()
          set({ orders, isLoading: false })
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '加载订单失败',
            isLoading: false,
          })
        }
      },

      createOrder: async (planId, paymentMethod) => {
        set({ isLoading: true, error: null })
        try {
          const order = await paymentApi.createOrder({ planId, paymentMethod })
          set((state) => ({
            orders: [order, ...state.orders],
            currentOrder: order,
            isLoading: false,
          }))
          return order
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '创建订单失败',
            isLoading: false,
          })
          return null
        }
      },

      loadOrder: async (orderId) => {
        set({ isLoading: true, error: null })
        try {
          const order = await paymentApi.getOrder(orderId)
          set({ currentOrder: order, isLoading: false })
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '加载订单失败',
            isLoading: false,
          })
        }
      },

      loadQrCode: async (orderId) => {
        set({ isLoading: true, error: null })
        try {
          const qrCode = await paymentApi.getQrCode(orderId)
          set({ currentQrCode: qrCode, isLoading: false })
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '加载收款码失败',
            isLoading: false,
          })
        }
      },

      submitProof: async (orderId, proofImageUrl, note) => {
        set({ isLoading: true, error: null })
        try {
          const result = await paymentApi.submitProof({ orderId, proofImageUrl, note })
          if (result.success) {
            await get().loadOrders()
            set({ isLoading: false })
            return true
          }
          set({ error: '提交凭证失败', isLoading: false })
          return false
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : '提交凭证失败',
            isLoading: false,
          })
          return false
        }
      },

      pollOrderStatus: async (orderId, maxAttempts = 60) => {
        const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

        for (let i = 0; i < maxAttempts; i++) {
          try {
            const order = await paymentApi.getOrder(orderId)
            set({ currentOrder: order })
            if (order.status === 'completed' || order.status === 'cancelled' || order.status === 'refunded') {
              return order
            }
          } catch {
            // 忽略单次失败，继续轮询
          }
          await delay(5000)
        }
        return null
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'wonwork-payment',
      partialize: (state) => ({
        orders: state.orders,
        currentOrder: state.currentOrder,
      }),
    }
  )
)

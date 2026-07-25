import { supportsPayment } from '@/config/product'
import { fetchApi } from './client'
import { cloudApi } from './cloudApi'
import type {
  Order,
  PaymentQrCode,
  CreateOrderRequest,
  SubmitPaymentProofRequest,
} from '@/types/mescli'

// ==================== Online 实现（Wongoing Cloud） ====================

function mapCloudOrder(cloud: Awaited<ReturnType<typeof cloudApi.getOrders>>[number]): Order {
  return {
    id: String(cloud.id),
    planId: String(cloud.planId),
    planName: cloud.planName ?? `Plan #${cloud.planId}`,
    amount: Number(cloud.amount),
    currency: cloud.currency || 'CNY',
    status: mapCloudOrderStatus(cloud.status),
    createdAt: cloud.createdAt,
    paidAt: cloud.paidAt,
  }
}

function mapCloudOrderStatus(status: string): Order['status'] {
  switch (status) {
    case 'paid':
      return 'completed'
    case 'pending':
      return 'pending_payment'
    case 'cancelled':
      return 'cancelled'
    case 'refunded':
      return 'refunded'
    default:
      return 'pending_payment'
  }
}

const onlinePaymentApi = {
  /** GET /api/cloud/payment/orders */
  getOrders: async (): Promise<Order[]> => {
    const orders = await cloudApi.getOrders()
    return orders.map(mapCloudOrder)
  },

  /** GET /api/cloud/payment/orders/{id} */
  getOrder: async (orderId: string): Promise<Order> => {
    const order = await cloudApi.getOrder(Number(orderId))
    return mapCloudOrder(order)
  },

  /** POST /api/cloud/payment/create-order */
  createOrder: async (req: CreateOrderRequest): Promise<Order> => {
    const result = await cloudApi.createOrder({
      planId: Number(req.planId),
      provider: req.paymentMethod || 'personal',
    })
    const order = mapCloudOrder(result.order)
    qrCache[order.id] = {
      type: 'alipay',
      amount: order.amount,
      currency: order.currency,
      qrImageUrl: result.payUrl,
    }
    return order
  },

  /** 从创建订单时的缓存获取收款码 */
  getQrCode: async (orderId: string): Promise<PaymentQrCode> => {
    const cached = qrCache[orderId]
    if (cached) return cached
    return {
      type: 'alipay',
      amount: 0,
      currency: 'CNY',
      qrImageUrl: '',
    }
  },

  /** Online 模式下个人收款码采用管理员人工确认，前端提交凭证仅作记录 */
  submitProof: async (_req: SubmitPaymentProofRequest): Promise<{ success: boolean }> => {
    return { success: true }
  },
}

const qrCache: Record<string, PaymentQrCode> = {}

// ==================== 禁用实现（Preview / MESCLI） ====================

const disabledPaymentApi = {
  getOrders: async (): Promise<Order[]> => {
    throw new Error('当前产品版本不支持支付功能')
  },

  getOrder: async (_orderId: string): Promise<Order> => {
    throw new Error('当前产品版本不支持支付功能')
  },

  createOrder: async (_req: CreateOrderRequest): Promise<Order> => {
    throw new Error('当前产品版本不支持支付功能')
  },

  getQrCode: async (_orderId: string): Promise<PaymentQrCode> => {
    throw new Error('当前产品版本不支持支付功能')
  },

  submitProof: async (_req: SubmitPaymentProofRequest): Promise<{ success: boolean }> => {
    throw new Error('当前产品版本不支持支付功能')
  },
}

export const paymentApi = supportsPayment ? onlinePaymentApi : disabledPaymentApi

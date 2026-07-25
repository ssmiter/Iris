import { useState, useEffect, useCallback } from 'react'
import { cn } from '@/utils'
import { useTranslation } from 'react-i18next'
import { useQuotaStore } from '@/stores/quotaStore'
import { usePaymentStore } from '@/stores/paymentStore'
import { useLicenseStore } from '@/stores/licenseStore'
import { X, Sparkles, Check, Loader2, AlertCircle } from 'lucide-react'

interface PlanUpgradeDialogProps {
  isOpen: boolean
  onClose: () => void
}

export function PlanUpgradeDialog({ isOpen, onClose }: PlanUpgradeDialogProps) {
  const { t } = useTranslation()
  const { plans, loadPlans } = useQuotaStore()
  const {
    currentOrder,
    currentQrCode,
    isLoading: isPaymentLoading,
    error: paymentError,
    createOrder,
    loadQrCode,
    pollOrderStatus,
    clearError: clearPaymentError,
  } = usePaymentStore()
  const { refresh: refreshLicense } = useLicenseStore()
  const { refresh: refreshQuota } = useQuotaStore()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [step, setStep] = useState<'select' | 'pay' | 'success'>('select')
  const [polling, setPolling] = useState(false)

  useEffect(() => {
    if (isOpen) {
      loadPlans()
      setSelectedId(null)
      setStep('select')
    }
  }, [isOpen, loadPlans])

  useEffect(() => {
    if (currentOrder?.id && currentOrder.status === 'pending_payment') {
      loadQrCode(currentOrder.id)
      setStep('pay')
    }
  }, [currentOrder?.id, currentOrder?.status, loadQrCode])

  const handleSelectPlan = useCallback(async () => {
    if (!selectedId) return
    clearPaymentError()
    const order = await createOrder(selectedId)
    if (order) {
      await loadQrCode(order.id)
      setStep('pay')
      startPolling(order.id)
    }
  }, [selectedId, createOrder, loadQrCode, clearPaymentError])

  const startPolling = useCallback(
    async (orderId: string) => {
      setPolling(true)
      try {
        const order = await pollOrderStatus(orderId)
        if (order?.status === 'completed') {
          setStep('success')
          await refreshLicense()
          await refreshQuota()
        }
      } finally {
        setPolling(false)
      }
    },
    [pollOrderStatus, refreshLicense, refreshQuota]
  )

  const handleClose = () => {
    if (!polling) {
      onClose()
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-200">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-primary-500" />
            <h3 className="text-base font-semibold text-surface-800">{t('license.upgrade.title')}</h3>
          </div>
          <button
            onClick={handleClose}
            disabled={polling}
            className="p-1.5 rounded-lg text-surface-400 hover:bg-surface-100 transition-colors disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {paymentError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
              <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700">{paymentError}</p>
            </div>
          )}

          {step === 'select' && (
            <>
              <p className="text-sm text-surface-500">{t('license.upgrade.subtitle')}</p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {plans.length === 0 && (
                  <div className="col-span-full text-center py-8 text-sm text-surface-400">
                    {t('license.upgrade.noPlans')}
                  </div>
                )}
                {plans.map((plan) => (
                  <button
                    key={plan.id}
                    onClick={() => setSelectedId(plan.id)}
                    disabled={isPaymentLoading}
                    className={cn(
                      'text-left p-4 border rounded-xl transition-all',
                      selectedId === plan.id
                        ? 'border-primary-500 bg-primary-50 ring-1 ring-primary-500'
                        : 'border-surface-200 hover:border-primary-300 hover:bg-surface-50'
                    )}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold text-surface-800">{plan.name}</span>
                      {selectedId === plan.id && <Check size={16} className="text-primary-500" />}
                    </div>
                    <div className="text-2xl font-bold text-surface-900 mb-1">
                      ¥{plan.monthlySeatPrice ?? plan.price}
                      <span className="text-xs font-normal text-surface-500">;/{t('license.upgrade.perSeatMonth')}</span>
                    </div>
                    <p className="text-xs text-surface-500 mb-3">
                      {plan.tokenAmount.toLocaleString()} tokens
                      {plan.durationDays && ` · ${plan.durationDays}${t('license.upgrade.days')}`}
                    </p>
                    {plan.features && plan.features.length > 0 && (
                      <ul className="space-y-1">
                        {plan.features.map((feature) => (
                          <li key={feature} className="flex items-center gap-1.5 text-xs text-surface-600">
                            <Check size={12} className="text-primary-500" />
                            {feature}
                          </li>
                        ))}
                      </ul>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 'pay' && currentOrder && (
            <div className="space-y-4 text-center">
              <p className="text-sm text-surface-600">
                {currentOrder.planName} · ¥{currentOrder.amount}
              </p>

              {currentQrCode ? (
                <div className="flex flex-col items-center gap-2">
                  <img
                    src={currentQrCode.qrImageUrl}
                    alt="Payment QR Code"
                    className="w-48 h-48 object-contain border border-surface-200 rounded-xl bg-white"
                  />
                  <p className="text-xs text-surface-500">
                    {t('settings.payment.qrHint', { type: currentQrCode.type })}
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-surface-500">
                  <Loader2 size={16} className="animate-spin" />
                  {t('settings.payment.loadingQr')}
                </div>
              )}

              {polling && (
                <div className="flex items-center justify-center gap-2 text-xs text-primary-600">
                  <Loader2 size={12} className="animate-spin" />
                  {t('license.upgrade.polling')}
                </div>
              )}
            </div>
          )}

          {step === 'success' && (
            <div className="flex flex-col items-center gap-3 py-8">
              <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                <Check size={32} className="text-green-600" />
              </div>
              <p className="text-lg font-semibold text-surface-800">{t('license.upgrade.successTitle')}</p>
              <p className="text-sm text-surface-500">{t('license.upgrade.successDescription')}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-surface-200 bg-surface-50">
          <button
            onClick={handleClose}
            disabled={polling}
            className="px-4 py-2 text-sm font-medium text-surface-600 hover:text-surface-800 transition-colors disabled:opacity-50"
          >
            {step === 'success' ? t('license.upgrade.close') : t('license.upgrade.cancel')}
          </button>
          {step === 'select' && (
            <button
              disabled={!selectedId || isPaymentLoading}
              onClick={handleSelectPlan}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                !selectedId || isPaymentLoading
                  ? 'bg-surface-200 text-surface-400 cursor-not-allowed'
                  : 'bg-primary-500 text-white hover:bg-primary-600'
              )}
            >
              {isPaymentLoading && <Loader2 size={14} className="animate-spin" />}
              {t('license.upgrade.confirm')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

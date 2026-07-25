import { useTranslation } from 'react-i18next'
import { useState, useRef, useCallback } from 'react'
import { webBridgeClient } from '@/api/webbridgeClient'
import type { ElementSelector } from '@/types/webbridge'
import { X, MousePointer2, Loader2, Check } from 'lucide-react'

interface VisualSelectorPickerProps {
  screenshotUrl: string
  onSelect: (selector: ElementSelector | null) => void
  onClose: () => void
}

interface Point {
  x: number
  y: number
}

export function VisualSelectorPicker({ screenshotUrl, onSelect, onClose }: VisualSelectorPickerProps) {
  const { t } = useTranslation()
  const imgRef = useRef<HTMLImageElement>(null)
  const [pointer, setPointer] = useState<Point | null>(null)
  const [resolved, setResolved] = useState<ElementSelector | null>(null)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleImageClick = useCallback(async (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current
    if (!img) return

    const rect = img.getBoundingClientRect()
    const scaleX = img.naturalWidth / rect.width
    const scaleY = img.naturalHeight / rect.height
    const x = Math.round((e.clientX - rect.left) * scaleX)
    const y = Math.round((e.clientY - rect.top) * scaleY)

    setPointer({ x, y })
    setResolved(null)
    setError(null)
    setResolving(true)

    try {
      const selector = await webBridgeClient.resolveSelector(x, y)
      setResolved(selector)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve selector')
    } finally {
      setResolving(false)
    }
  }, [])

  const handleConfirm = () => {
    onSelect(resolved)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-200">
          <div className="flex items-center gap-2">
            <MousePointer2 size={18} className="text-primary-600" />
            <h3 className="text-sm font-semibold text-surface-900">{t('webbridge.visualSelector.title')}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-surface-400 hover:text-surface-700 hover:bg-surface-100 rounded transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <p className="text-sm text-surface-500 mb-3">{t('webbridge.visualSelector.hint')}</p>

          <div className="relative inline-block">
            <img
              ref={imgRef}
              src={screenshotUrl}
              alt="screenshot"
              onClick={handleImageClick}
              className="max-w-full h-auto rounded border border-surface-200 cursor-crosshair"
              draggable={false}
            />
            {pointer && (
              <div
                className="absolute pointer-events-none w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-red-500 bg-red-500/30"
                style={{
                  left: `${(pointer.x / (imgRef.current?.naturalWidth || 1)) * 100}%`,
                  top: `${(pointer.y / (imgRef.current?.naturalHeight || 1)) * 100}%`,
                }}
              />
            )}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-surface-200 space-y-3">
          {resolving && (
            <div className="flex items-center gap-2 text-sm text-surface-600">
              <Loader2 size={16} className="animate-spin" />
              {t('webbridge.visualSelector.resolving')}
            </div>
          )}

          {error && (
            <div className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded">{error}</div>
          )}

          {resolved && (
            <div className="space-y-2">
              <div className="text-sm text-surface-700">
                <span className="font-medium">{t('webbridge.visualSelector.selectorType')}:</span> {resolved.selector_type}
              </div>
              <div className="text-sm text-surface-700">
                <span className="font-medium">{t('webbridge.visualSelector.selectorValue')}:</span>{' '}
                <code className="px-1.5 py-0.5 bg-surface-100 rounded text-xs font-mono">{resolved.value}</code>
              </div>
              {pointer && (
                <div className="text-xs text-surface-400">
                  x: {pointer.x}, y: {pointer.y}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-surface-700 hover:bg-surface-100 rounded-lg transition-colors"
            >
              {t('webbridge.workflowPanel.cancel')}
            </button>
            <button
              onClick={handleConfirm}
              disabled={!resolved}
              className="flex items-center gap-1.5 px-4 py-2 bg-primary-600 hover:bg-primary-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-60"
            >
              <Check size={16} />
              {t('webbridge.visualSelector.confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

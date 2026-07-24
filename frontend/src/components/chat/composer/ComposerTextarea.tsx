import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from '@/lib/cn'

interface ComposerTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onSubmit'> {
  onSubmit: () => void
}

export const ComposerTextarea = forwardRef<
  HTMLTextAreaElement,
  ComposerTextareaProps
>(({ className, value, onSubmit, onKeyDown, ...props }, forwardedRef) => {
  const localRef = useRef<HTMLTextAreaElement | null>(null)
  const composingRef = useRef(false)

  const setRefs = useCallback(
    (element: HTMLTextAreaElement | null) => {
      localRef.current = element
      if (typeof forwardedRef === 'function') forwardedRef(element)
      else if (forwardedRef) forwardedRef.current = element
    },
    [forwardedRef],
  )

  const resize = useCallback(() => {
    const element = localRef.current
    if (!element) return
    element.style.height = 'auto'
    const lineHeight = Number.parseFloat(
      window.getComputedStyle(element).lineHeight,
    )
    const maxHeight = lineHeight * 8
    element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`
    element.style.overflowY =
      element.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    resize()
  }, [resize, value])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || composingRef.current || event.nativeEvent.isComposing) {
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSubmit()
    }
  }

  return (
    <textarea
      ref={setRefs}
      rows={1}
      value={value}
      className={cn(
        'min-h-6 min-w-0 flex-1 resize-none bg-transparent text-body text-ink outline-none',
        'placeholder:text-ink-muted disabled:cursor-not-allowed disabled:opacity-50',
        'subtle-scrollbar',
        className,
      )}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => {
        composingRef.current = true
      }}
      onCompositionEnd={() => {
        composingRef.current = false
      }}
      {...props}
    />
  )
})

ComposerTextarea.displayName = 'ComposerTextarea'

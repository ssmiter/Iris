import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { RevealController } from './revealEngine'
import { motionPreferenceChangeEventName } from '@/theme/theme'

function manualReduceMotion() {
  return (
    typeof document !== 'undefined'
    && document.documentElement.dataset.motion === 'reduce'
  )
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined'
      && (window.matchMedia('(prefers-reduced-motion: reduce)').matches
        || manualReduceMotion()),
  )

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches || manualReduceMotion())
    query.addEventListener('change', update)
    window.addEventListener(motionPreferenceChangeEventName(), update)
    return () => {
      query.removeEventListener('change', update)
      window.removeEventListener(motionPreferenceChangeEventName(), update)
    }
  }, [])

  return reduced
}

export function useReveal(target: string, streaming: boolean) {
  const reducedMotion = useReducedMotion()
  const controllerRef = useRef<RevealController | null>(null)
  const wasStreamingRef = useRef(streaming)

  if (controllerRef.current === null) {
    controllerRef.current = new RevealController(target, streaming && !reducedMotion)
  }

  const controller = controllerRef.current
  const visible = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )

  useLayoutEffect(() => {
    if (streaming && !reducedMotion) {
      controller.setTarget(target, true)
    } else if (wasStreamingRef.current && !reducedMotion) {
      controller.settleTarget(target)
    } else {
      controller.setTarget(target, false)
    }
    wasStreamingRef.current = streaming
  }, [controller, reducedMotion, streaming, target])

  useEffect(() => () => controller.dispose(), [controller])

  return visible
}

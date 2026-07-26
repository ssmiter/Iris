import { revealMotion } from './transitions'

type RevealListener = () => void

const graphemeSegmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null

const activeControllers = new Set<RevealController>()
let animationFrame: number | null = null
let previousFrameAt = 0

function requestNextFrame() {
  if (animationFrame !== null || activeControllers.size === 0) {
    return
  }

  animationFrame = window.requestAnimationFrame(runFrame)
}

function runFrame(now: number) {
  animationFrame = null
  const elapsed = previousFrameAt === 0 ? 16 : Math.min(now - previousFrameAt, revealMotion.maximumFrameDeltaMs)
  previousFrameAt = now

  for (const controller of activeControllers) {
    if (!controller.advance(elapsed, now)) {
      activeControllers.delete(controller)
    }
  }

  if (activeControllers.size > 0) {
    requestNextFrame()
  } else {
    previousFrameAt = 0
  }
}

function activate(controller: RevealController) {
  activeControllers.add(controller)
  requestNextFrame()
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

export class RevealController {
  private target = ''
  private visible = ''
  private frontier = 0
  private animated = false
  private arrivalRate = 0
  private lastArrivalAt = 0
  private lastArrivalLength = 0
  private lastPublishedAt = 0
  private readonly listeners = new Set<RevealListener>()

  constructor(target: string, animated: boolean) {
    this.setTarget(target, animated, true)
  }

  subscribe = (listener: RevealListener) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.visible

  setTarget(target: string, animated: boolean, initial = false) {
    const now = performance.now()
    const previousLength = this.target.length
    const targetChanged = target !== this.target

    this.target = target
    this.animated = animated

    if (!animated) {
      this.frontier = target.length
      this.visible = target
      this.publish()
      activeControllers.delete(this)
      return
    }

    if (targetChanged && target.length >= previousLength) {
      this.observeArrival(target.length, now)
    }

    if (initial) {
      this.frontier = Math.max(0, target.length - revealMotion.firstFrameTail)
      this.revealThrough(Math.floor(this.frontier))
      this.lastArrivalLength = target.length
      this.lastArrivalAt = now
    } else if (target.length < previousLength) {
      this.frontier = Math.min(this.frontier, target.length)
      const previousVisible = this.visible
      this.visible = ''
      this.revealThrough(Math.floor(this.frontier))
      if (this.visible !== previousVisible) {
        this.publish()
      }
    }

    const backlog = target.length - this.frontier
    if (backlog > revealMotion.backlogFastForwardThreshold) {
      this.frontier = Math.max(this.frontier, target.length - revealMotion.retainedBacklog)
      if (this.revealThrough(Math.floor(this.frontier))) {
        this.publish()
      }
    }

    if (this.frontier < target.length) {
      activate(this)
    }
  }

  settleTarget(target: string) {
    const targetChanged = target !== this.target
    this.target = target
    this.animated = true

    if (targetChanged && this.frontier > target.length) {
      this.frontier = target.length
      this.visible = target
      this.publish()
    }

    if (this.frontier < target.length) {
      activate(this)
    } else {
      this.visible = target
      this.publish()
      activeControllers.delete(this)
    }
  }

  advance(elapsedMs: number, now: number) {
    if (!this.animated || this.frontier >= this.target.length) {
      return false
    }

    const measuredRate = this.arrivalRate > 0
      ? this.arrivalRate * revealMotion.arrivalRateMultiplier
      : 72
    const charactersPerSecond = clamp(
      measuredRate,
      revealMotion.minCharactersPerSecond,
      revealMotion.maxCharactersPerSecond,
    )

    this.frontier = Math.min(
      this.target.length,
      this.frontier + charactersPerSecond * elapsedMs / 1_000,
    )

    const requestedLength = Math.floor(this.frontier)
    const completed = requestedLength >= this.target.length
    if (
      requestedLength !== this.visible.length
      && (completed || now - this.lastPublishedAt >= revealMotion.minimumPublishIntervalMs)
    ) {
      if (this.revealThrough(requestedLength)) {
        this.lastPublishedAt = now
        this.publish()
      }
    }

    return !completed
  }

  dispose() {
    activeControllers.delete(this)
    this.listeners.clear()
  }

  private observeArrival(length: number, now: number) {
    if (this.lastArrivalAt > 0 && length > this.lastArrivalLength) {
      const elapsedSeconds = Math.max((now - this.lastArrivalAt) / 1_000, 0.001)
      const instantaneousRate = (length - this.lastArrivalLength) / elapsedSeconds
      this.arrivalRate = this.arrivalRate === 0
        ? instantaneousRate
        : this.arrivalRate * 0.72 + instantaneousRate * 0.28
    }

    this.lastArrivalLength = length
    this.lastArrivalAt = now
  }

  private revealThrough(requestedLength: number) {
    const clampedLength = clamp(
      requestedLength,
      this.visible.length,
      this.target.length,
    )
    if (clampedLength <= this.visible.length) {
      return false
    }
    if (clampedLength === this.target.length || graphemeSegmenter === null) {
      this.visible = this.target.slice(0, clampedLength)
      return true
    }

    const scanStart = this.visible.length
    const lookaheadEnd = Math.min(this.target.length, clampedLength + 64)
    const remainder = this.target.slice(scanStart, lookaheadEnd)
    let safeBoundary = scanStart

    for (const segment of graphemeSegmenter.segment(remainder)) {
      const segmentEnd = scanStart + segment.index + segment.segment.length
      if (segmentEnd > clampedLength) break
      safeBoundary = segmentEnd
    }

    if (safeBoundary === this.visible.length) {
      return false
    }
    this.visible = this.target.slice(0, safeBoundary)
    return true
  }

  private publish() {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

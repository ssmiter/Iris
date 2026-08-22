export const revealMotion = {
  firstFrameTail: 24,
  retainedBacklog: 160,
  backlogFastForwardThreshold: 260,
  minCharactersPerSecond: 60,
  maxCharactersPerSecond: 1400,
  arrivalRateMultiplier: 1.4,
  maximumFrameDeltaMs: 100,
  minimumPublishIntervalMs: 40,
} as const

export const interactionMotion = {
  quick: 120,
  standard: 180,
  deliberate: 260,
} as const

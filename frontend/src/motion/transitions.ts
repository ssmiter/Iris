export const revealMotion = {
  firstFrameTail: 24,
  retainedBacklog: 220,
  backlogFastForwardThreshold: 360,
  minCharactersPerSecond: 40,
  maxCharactersPerSecond: 600,
  arrivalRateMultiplier: 1.25,
  maximumFrameDeltaMs: 100,
  minimumPublishIntervalMs: 80,
} as const

export const interactionMotion = {
  quick: 120,
  standard: 180,
  deliberate: 260,
} as const

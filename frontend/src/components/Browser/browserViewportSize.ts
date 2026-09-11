const MIN_VIEWPORT_WIDTH = 320
const MIN_VIEWPORT_HEIGHT = 240
const MAX_VIEWPORT_WIDTH = 1920
const MAX_VIEWPORT_HEIGHT = 1440

function normalizeDimension(
  value: number,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const finiteValue = Number.isFinite(value) ? value : fallback
  return Math.min(maximum, Math.max(minimum, Math.round(finiteValue)))
}

export function normalizeBrowserViewportSize(width: number, height: number) {
  return {
    width: normalizeDimension(width, 1280, MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH),
    height: normalizeDimension(height, 720, MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT),
  }
}

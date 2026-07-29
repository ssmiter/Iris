import path from 'node:path'

function integer(name, fallback, minimum, maximum) {
  const raw = process.env[name]
  const value = raw ? Number.parseInt(raw, 10) : fallback
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function requiredSecret() {
  const value = process.env.IRIS_BRIDGE_TOKEN?.trim()
  if (!value || value.length < 24) {
    throw new Error('IRIS_BRIDGE_TOKEN must contain at least 24 characters')
  }
  return value
}

const localData = process.env.LOCALAPPDATA
  || path.join(process.cwd(), '.iris-runtime')

export const config = Object.freeze({
  host: '127.0.0.1',
  port: integer('IRIS_WEBBRIDGE_PORT', 19223, 1, 65535),
  token: requiredSecret(),
  protocolVersion: 2,
  browserPath: process.env.IRIS_WEBBRIDGE_BROWSER_PATH?.trim() || undefined,
  userDataDir: process.env.IRIS_WEBBRIDGE_USER_DATA_DIR?.trim()
    || path.join(localData, 'Iris', 'BrowserProfiles', 'default'),
  headless: process.env.IRIS_WEBBRIDGE_HEADLESS === 'true',
  sessionTtlMs: integer(
    'IRIS_WEBBRIDGE_SESSION_TTL_MINUTES',
    10,
    1,
    1440,
  ) * 60_000,
})

import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { config } from './config.js'
import {
  applyAction,
  browserInstallation,
  captureScreenshot,
  closeSession,
  createSession,
  listSessions,
  observeSession,
  readActionResult,
  reapExpiredSessions,
  resolveElement,
  runtimeState,
  shutdown,
  waitForPage,
} from './browserRuntime.js'

const server = http.createServer(async (request, response) => {
  try {
    if (!authorized(request)) {
      return json(response, 401, {
        error: {
          code: 'webbridge_unauthorized',
          message: 'A valid local bearer token is required',
        },
      })
    }

    const url = new URL(
      request.url || '/',
      `http://${config.host}:${config.port}`,
    )
    const parts = url.pathname.split('/').filter(Boolean)

    if (request.method === 'GET' && url.pathname === '/health') {
      return json(response, 200, {
        ok: true,
        status: 'ok',
        version: '0.2.0',
        protocolVersion: config.protocolVersion,
        ...await runtimeState(),
      })
    }

    if (request.method === 'GET' && url.pathname === '/sessions') {
      const sessions = listSessions()
      return json(response, 200, {
        sessions,
        count: sessions.length,
      })
    }

    if (request.method === 'POST' && url.pathname === '/sessions') {
      const body = await readJson(request)
      const result = await createSession(
        typeof body.url === 'string' ? body.url : 'about:blank',
      )
      return json(response, 201, result)
    }

    if (
      request.method === 'POST'
      && parts.length === 3
      && parts[0] === 'sessions'
      && parts[2] === 'observe'
    ) {
      const body = await readJson(request)
      const result = await observeSession(parts[1], body)
      return json(response, 200, result)
    }

    if (
      request.method === 'GET'
      && parts.length === 4
      && parts[0] === 'sessions'
      && parts[2] === 'actions'
    ) {
      const result = readActionResult(parts[1], parts[3])
      return json(response, 200, result)
    }

    if (
      request.method === 'POST'
      && parts.length === 3
      && parts[0] === 'sessions'
      && parts[2] === 'wait'
    ) {
      const body = await readJson(request)
      const result = await waitForPage(parts[1], body)
      return json(response, 200, result)
    }

    if (
      request.method === 'POST'
      && parts.length === 4
      && parts[0] === 'sessions'
      && parts[2] === 'elements'
      && parts[3] === 'resolve'
    ) {
      const body = await readJson(request)
      const result = resolveElement(parts[1], body)
      return json(response, 200, result)
    }

    if (
      request.method === 'POST'
      && parts.length === 3
      && parts[0] === 'sessions'
      && parts[2] === 'actions'
    ) {
      const body = await readJson(request)
      const result = await applyAction(parts[1], body)
      return json(response, 200, result)
    }

    if (
      request.method === 'POST'
      && parts.length === 3
      && parts[0] === 'sessions'
      && parts[2] === 'screenshot'
    ) {
      const body = await readJson(request)
      const result = await captureScreenshot(parts[1], body)
      return binary(response, 200, result.bytes, {
        'Content-Type': result.mediaType,
        'X-Iris-Observation-Ref': result.observationRef,
        'X-Iris-Page-Id': result.pageId,
      })
    }

    if (
      request.method === 'DELETE'
      && parts.length === 2
      && parts[0] === 'sessions'
    ) {
      const closed = await closeSession(parts[1])
      return json(response, 200, {
        closed: true,
        alreadyAbsent: !closed,
        sessionId: parts[1],
      })
    }

    return json(response, 404, {
      error: {
        code: 'webbridge_route_not_found',
        message: 'WebBridge route not found',
      },
    })
  } catch (error) {
    console.error(
      `[iris-webbridge] ${request.method} ${request.url || '/'} failed:`,
      error?.code || error?.name || 'error',
      error instanceof Error ? error.message : 'unknown error',
    )
    return json(response, error.statusCode || 500, {
      error: {
        code: error.code || 'webbridge_internal_error',
        message: safeMessage(error),
      },
    })
  }
})

server.listen(config.port, config.host, () => {
  const browser = browserInstallation()
  console.log(
    `[iris-webbridge] listening on http://${config.host}:${config.port}`
    + ` (protocol ${config.protocolVersion}, browser ${
      browser.available ? 'ready' : 'unavailable'
    })`,
  )
})

const reaper = setInterval(
  () => reapExpiredSessions().catch(() => undefined),
  30_000,
)
reaper.unref()

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close()
    clearInterval(reaper)
    void shutdown().finally(() => process.exit(0))
  })
}

function authorized(request) {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return false
  const actual = Buffer.from(authorization.slice('Bearer '.length).trim())
  const expected = Buffer.from(config.token)
  return actual.length === expected.length
    && timingSafeEqual(actual, expected)
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(httpError(
          'webbridge_request_too_large',
          'Request body exceeds 1 MB',
          413,
        ))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || Array.isArray(value) || typeof value !== 'object') {
          throw new Error('JSON object required')
        }
        resolve(value)
      } catch {
        reject(httpError(
          'invalid_webbridge_request',
          'Request body must be a JSON object',
          400,
        ))
      }
    })
    request.on('error', reject)
  })
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(body))
}

function binary(response, statusCode, body, headers) {
  response.writeHead(statusCode, {
    ...headers,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function httpError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function safeMessage(error) {
  if (error?.statusCode && error instanceof Error) return error.message
  return 'Browser Runtime could not complete the request'
}

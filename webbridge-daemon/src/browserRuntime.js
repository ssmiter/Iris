import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as chromeLauncher from 'chrome-launcher'
import CDP from 'chrome-remote-interface'
import { config } from './config.js'
import { observePage } from './observation.js'

const sessions = new Map()
let chrome = null

export function browserInstallation() {
  if (config.browserPath) {
    return fs.existsSync(config.browserPath)
      ? { available: true, path: config.browserPath }
      : {
          available: false,
          error: 'IRIS_WEBBRIDGE_BROWSER_PATH does not exist',
        }
  }
  try {
    const detected = chromeLauncher.Launcher.getInstallations()[0]
    if (detected) return { available: true, path: detected }
  } catch (error) {
    // Fall through to deterministic Windows paths below.
  }
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA
    || path.join(home, 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)']
    || 'C:\\Program Files (x86)'
  const candidates = [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  const detected = candidates.find(candidate => fs.existsSync(candidate))
  return detected
    ? { available: true, path: detected }
    : {
        available: false,
        error: 'Chrome / Edge / Chromium was not found',
      }
}

export function runtimeState() {
  const installation = browserInstallation()
  return {
    browserReady: installation.available,
    browserRunning: Boolean(chrome),
    browserPath: installation.path,
    browserError: installation.error,
    sessionCount: sessions.size,
  }
}

export function listSessions() {
  return [...sessions.values()]
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(session => ({
      sessionId: session.sessionId,
      pageId: session.pageId,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      url: session.lastObservation?.url || '',
      title: session.lastObservation?.title || '',
      observationRef: session.lastObservation?.ref,
      revision: session.lastObservation?.revision || 0,
    }))
}

export async function createSession(initialUrl = 'about:blank') {
  initialUrl = requireWebUrl(initialUrl)
  const launched = await ensureChrome()
  const target = await CDP.New({
    port: launched.port,
    url: 'about:blank',
  })
  const client = await CDP({
    port: launched.port,
    target: target.id,
  })
  await Promise.all([
    client.Page.enable(),
    client.Runtime.enable(),
  ])

  const session = {
    sessionId: `brs_${randomUUID().replaceAll('-', '')}`,
    pageId: target.id,
    client,
    createdAt: new Date(),
    lastUsedAt: new Date(),
    revision: 0,
    lastObservation: null,
    elementSelectors: new Map(),
    elements: new Map(),
    actionResults: new Map(),
  }
  sessions.set(session.sessionId, session)
  try {
    if (initialUrl !== 'about:blank') {
      await navigateAndSettle(session, initialUrl)
    }
    const observation = await observePage(session)
    return {
      sessionId: session.sessionId,
      pageId: session.pageId,
      createdAt: session.createdAt.toISOString(),
      observation,
    }
  } catch (error) {
    await closeSession(session.sessionId)
    throw error
  }
}

export async function observeSession(sessionId, body) {
  const session = requireSession(sessionId)
  requirePage(session, body.pageId)
  const observation = await observePage(session, body)
  return {
    sessionId,
    pageId: session.pageId,
    observation,
  }
}

export async function waitForPage(sessionId, body) {
  const session = requireSession(sessionId)
  requirePage(session, body.pageId)
  const baselineRef = requiredText(
    body.afterObservationRef,
    'afterObservationRef',
  )
  if (baselineRef !== session.lastObservation?.ref) {
    throw protocolError(
      'browser_observation_stale',
      'Wait baseline is no longer current; use the latest observation',
      409,
    )
  }
  const condition = ['change', 'ready', 'text'].includes(body.condition)
    ? body.condition
    : 'change'
  const text = condition === 'text'
    ? requiredText(body.text, 'text')
    : ''
  const timeoutMs = Number.isInteger(body.timeoutMs)
    ? Math.max(250, Math.min(body.timeoutMs, 15_000))
    : 5_000
  const baselineFingerprint = session.lastObservation?.fingerprint
  const deadline = Date.now() + timeoutMs
  let observation = session.lastObservation
  let conditionMet = matchesWait(
    condition,
    text,
    baselineFingerprint,
    observation,
  )
  while (!conditionMet && Date.now() < deadline) {
    await delay(250)
    observation = await observePage(session, body)
    conditionMet = matchesWait(
      condition,
      text,
      baselineFingerprint,
      observation,
    )
  }
  return {
    sessionId,
    pageId: session.pageId,
    condition,
    conditionMet,
    waitedMs: timeoutMs - Math.max(0, deadline - Date.now()),
    observation,
  }
}

export function resolveElement(sessionId, body) {
  const session = requireSession(sessionId)
  requirePage(session, body.pageId)
  const observationRef = requiredText(
    body.observationRef,
    'observationRef',
  )
  if (observationRef !== session.lastObservation?.ref) {
    throw protocolError(
      'browser_observation_stale',
      'The page changed after this observation; observe again',
      409,
    )
  }
  const elementRef = requiredText(body.elementRef, 'elementRef')
  const element = session.elements.get(elementRef)
  if (!element) {
    throw protocolError(
      'browser_element_not_found',
      'Element reference does not belong to the current observation',
      404,
    )
  }
  return {
    sessionId,
    pageId: session.pageId,
    observationRef,
    element,
  }
}

export async function applyAction(sessionId, request) {
  const session = requireSession(sessionId)
  const key = requiredText(request.idempotencyKey, 'idempotencyKey')
  requiredText(request.toolExecutionId, 'toolExecutionId')
  const requestFingerprint = createHash('sha256')
    .update(JSON.stringify({
      toolExecutionId: request.toolExecutionId,
      actionAttemptId: request.actionAttemptId,
      expectedObservationRef: request.expectedObservationRef,
      primitive: request.primitive,
      normalizedArgs: request.normalizedArgs,
    }))
    .digest('hex')
  const previous = session.actionResults.get(key)
  if (previous) {
    if (previous.requestFingerprint !== requestFingerprint) {
      throw protocolError(
        'browser_idempotency_conflict',
        'Idempotency key was already used for a different browser action',
        409,
      )
    }
    return previous.result
  }

  const actionAttemptId = requiredText(
    request.actionAttemptId,
    'actionAttemptId',
  )
  if (!['navigate', 'click', 'fill', 'select'].includes(request.primitive)) {
    throw protocolError(
      'unsupported_browser_primitive',
      `Unsupported primitive: ${request.primitive}`,
      400,
    )
  }
  const pageId = requiredText(request.normalizedArgs?.pageId, 'pageId')
  requirePage(session, pageId)
  if (['click', 'fill', 'select'].includes(request.primitive)
      && !request.expectedObservationRef) {
    throw protocolError(
      'browser_observation_required',
      'Element actions require an expected observation reference',
      400,
    )
  }

  if (
    request.expectedObservationRef
    && request.expectedObservationRef !== session.lastObservation?.ref
  ) {
    const result = {
      status: 'not_applied',
      actionAttemptId,
      idempotencyKey: key,
      message: 'The page changed after the expected observation; observe again',
      currentObservationRef: session.lastObservation?.ref,
    }
    storeActionResult(
      session,
      key,
      requestFingerprint,
      result,
    )
    return result
  }

  const before = session.lastObservation
  const pageIdsBefore = request.primitive === 'click'
    ? await pageTargetIds()
    : null
  let result
  try {
    const target = request.primitive === 'navigate'
      ? requireWebUrl(request.normalizedArgs?.url)
      : request.primitive === 'click'
        ? requiredText(request.normalizedArgs?.elementRef, 'elementRef')
        : {
            elementRef: requiredText(
              request.normalizedArgs?.elementRef,
              'elementRef',
            ),
            value: requireFillValue(request.normalizedArgs?.value),
          }
    if (request.primitive === 'navigate') {
      await navigateAndSettle(session, target)
    } else if (request.primitive === 'click') {
      await clickElement(session, target)
      await adoptNewPage(session, pageIdsBefore)
    } else if (request.primitive === 'fill') {
      await fillElement(session, target.elementRef, target.value)
    } else {
      await selectOption(session, target.elementRef, target.value)
    }
    const observation = await observePage(session)
    const applied = request.primitive === 'navigate'
      ? equivalentUrl(observation.url, target)
      : true
    if (!applied) {
      result = {
        status: 'outcome_unknown',
        actionAttemptId,
        idempotencyKey: key,
        message: `Navigation returned a different URL: ${observation.url}`,
        observation,
      }
    } else {
      result = {
        status: 'applied',
        actionAttemptId,
        idempotencyKey: key,
        pageId: session.pageId,
        openedNewPage: before?.url !== observation.url
          && pageIdsBefore !== null
          && !pageIdsBefore.has(session.pageId),
        observation,
        evidence: evidenceFor(
          request.primitive,
          before,
          target,
          observation,
        ),
      }
    }
  } catch (error) {
    if (request.primitive === 'navigate') {
      result = await recoverNavigation(
        session,
        actionAttemptId,
        key,
        before,
        request.normalizedArgs?.url,
        error,
      )
    } else {
      result = {
        status: 'outcome_unknown',
        actionAttemptId,
        idempotencyKey: key,
        message: error instanceof Error
          ? error.message
          : 'Element action outcome could not be proven',
        currentObservationRef: session.lastObservation?.ref,
      }
    }
  }
  storeActionResult(session, key, requestFingerprint, result)
  return result
}

export function readActionResult(sessionId, idempotencyKey) {
  const session = requireSession(sessionId)
  const stored = session.actionResults.get(idempotencyKey)
  if (!stored) {
    throw protocolError(
      'browser_action_result_not_found',
      'No browser action result exists for this idempotency key',
      404,
    )
  }
  return stored.result
}

export async function captureScreenshot(sessionId, body) {
  const session = requireSession(sessionId)
  requirePage(session, body.pageId)
  const format = body.format === 'png' ? 'png' : 'jpeg'
  const quality = Number.isInteger(body.quality)
    ? Math.max(30, Math.min(body.quality, 90))
    : 70
  const result = await session.client.Page.captureScreenshot({
    format,
    ...(format === 'jpeg' ? { quality } : {}),
    fromSurface: true,
    captureBeyondViewport: body.fullPage === true,
  })
  const bytes = Buffer.from(result.data, 'base64')
  if (bytes.length > 12 * 1024 * 1024) {
    throw protocolError(
      'browser_screenshot_too_large',
      'Screenshot exceeds the 12 MB runtime limit',
      413,
    )
  }
  session.lastUsedAt = new Date()
  return {
    bytes,
    mediaType: format === 'png' ? 'image/png' : 'image/jpeg',
    observationRef: session.lastObservation?.ref || '',
    pageId: session.pageId,
  }
}

export async function closeSession(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return false
  sessions.delete(sessionId)
  await session.client.close().catch(() => undefined)
  if (chrome) {
    await CDP.Close({ port: chrome.port, id: session.pageId })
      .catch(() => undefined)
  }
  return true
}

export async function reapExpiredSessions() {
  const threshold = Date.now() - config.sessionTtlMs
  const expired = [...sessions.values()]
    .filter(session => session.lastUsedAt.getTime() < threshold)
    .map(session => session.sessionId)
  await Promise.all(expired.map(closeSession))
}

export async function shutdown() {
  await Promise.all([...sessions.keys()].map(closeSession))
  if (chrome) {
    const running = chrome
    chrome = null
    try {
      await running.kill()
    } catch {
      // The browser may already have exited during shutdown.
    }
  }
}

async function ensureChrome() {
  if (chrome) return chrome
  const installation = browserInstallation()
  if (!installation.available) {
    throw protocolError(
      'browser_not_available',
      installation.error || 'Browser is not available',
      503,
    )
  }
  fs.mkdirSync(config.userDataDir, { recursive: true })
  chrome = await chromeLauncher.launch({
    chromePath: installation.path,
    userDataDir: config.userDataDir,
    logLevel: 'silent',
    chromeFlags: [
      '--remote-debugging-address=127.0.0.1',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
      ...(config.headless ? ['--headless=new'] : []),
    ],
  })
  return chrome
}

function requireSession(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) {
    throw protocolError(
      'browser_session_not_found',
      'BrowserSession expired or does not exist; list or open a session',
      404,
    )
  }
  session.lastUsedAt = new Date()
  return session
}

function requirePage(session, pageId) {
  if (pageId && pageId !== session.pageId) {
    throw protocolError(
      'browser_page_not_found',
      'Page does not belong to this BrowserSession',
      404,
    )
  }
}

async function navigateAndSettle(session, url) {
  const navigation = await session.client.Page.navigate({ url })
  if (navigation.errorText) {
    throw new Error(navigation.errorText)
  }
  await waitForDocument(session.client.Runtime, 20_000)
  await delay(250)
}

async function clickElement(session, elementRef) {
  const selector = session.elementSelectors.get(elementRef)
  const metadata = session.elements.get(elementRef)
  if (!selector || !metadata) {
    throw protocolError(
      'browser_element_not_found',
      'Element reference does not belong to the current observation',
      404,
    )
  }
  if (metadata.disabled) {
    throw protocolError(
      'browser_element_disabled',
      'The selected element is disabled',
      409,
    )
  }
  const evaluation = await session.client.Runtime.evaluate({
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!element) return { applied: false, reason: 'element_not_found' }
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      if (style.display === 'none' || style.visibility === 'hidden'
          || rect.width <= 0 || rect.height <= 0) {
        return { applied: false, reason: 'element_not_visible' }
      }
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') {
        return { applied: false, reason: 'element_disabled' }
      }
      element.scrollIntoView({ block: 'center', inline: 'center' })
      element.click()
      return { applied: true }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  })
  const result = evaluation.result?.value
  if (!result?.applied) {
    throw protocolError(
      result?.reason || 'browser_click_not_applied',
      `Element click was not applied: ${result?.reason || 'unknown'}`,
      409,
    )
  }
  await delay(400)
  await waitForDocument(session.client.Runtime, 5_000).catch(() => undefined)
}

async function pageTargetIds() {
  if (!chrome) return new Set()
  const targets = await CDP.List({ port: chrome.port })
  return new Set(
    targets
      .filter(target => target.type === 'page')
      .map(target => target.id),
  )
}

async function adoptNewPage(session, previousIds) {
  if (!chrome || !previousIds) return false
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const targets = await CDP.List({ port: chrome.port })
    const created = targets.find(target =>
      target.type === 'page' && !previousIds.has(target.id)
    )
    if (created) {
      const nextClient = await CDP({
        port: chrome.port,
        target: created.id,
      })
      await Promise.all([
        nextClient.Page.enable(),
        nextClient.Runtime.enable(),
      ])
      await session.client.close().catch(() => undefined)
      session.client = nextClient
      session.pageId = created.id
      session.revision = 0
      session.lastObservation = null
      session.elementSelectors = new Map()
      session.elements = new Map()
      await waitForDocument(nextClient.Runtime, 10_000)
        .catch(() => undefined)
      return true
    }
    await delay(100)
  }
  return false
}

async function fillElement(session, elementRef, value) {
  const selector = session.elementSelectors.get(elementRef)
  const metadata = session.elements.get(elementRef)
  if (!selector || !metadata) {
    throw protocolError(
      'browser_element_not_found',
      'Element reference does not belong to the current observation',
      404,
    )
  }
  const tag = metadata.tag
  const type = String(metadata.type || '').toLowerCase()
  const supported = tag === 'input'
    || tag === 'textarea'
    || metadata.contentEditable === true
    || metadata.role === 'textbox'
  if (!supported || ['password', 'file', 'hidden'].includes(type)) {
    throw protocolError(
      'browser_field_not_fillable',
      'Field type is unsupported or sensitive; use takeover when appropriate',
      409,
    )
  }
  if (metadata.disabled) {
    throw protocolError(
      'browser_element_disabled',
      'The selected field is disabled',
      409,
    )
  }
  const evaluation = await session.client.Runtime.evaluate({
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!element) return { applied: false, reason: 'element_not_found' }
      const value = ${JSON.stringify(value)}
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') {
        return { applied: false, reason: 'element_disabled' }
      }
      element.scrollIntoView({ block: 'center', inline: 'center' })
      element.focus()
      if (element.isContentEditable) {
        element.textContent = value
      } else {
        const prototype = element.tagName.toLowerCase() === 'textarea'
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (!setter) return { applied: false, reason: 'value_setter_unavailable' }
        setter.call(element, value)
      }
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: value,
      }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      const actual = element.isContentEditable
        ? String(element.textContent || '')
        : String(element.value || '')
      return { applied: actual === value }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  })
  const result = evaluation.result?.value
  if (!result?.applied) {
    throw protocolError(
      result?.reason || 'browser_fill_not_confirmed',
      'Field value could not be confirmed after input',
      409,
    )
  }
  await delay(250)
}

async function selectOption(session, elementRef, value) {
  const selector = session.elementSelectors.get(elementRef)
  const metadata = session.elements.get(elementRef)
  if (!selector || !metadata || metadata.tag !== 'select') {
    throw protocolError(
      'browser_select_not_supported',
      'Element reference is not a native select field',
      409,
    )
  }
  if (metadata.disabled) {
    throw protocolError(
      'browser_element_disabled',
      'The selected field is disabled',
      409,
    )
  }
  const evaluation = await session.client.Runtime.evaluate({
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!(element instanceof HTMLSelectElement)) {
        return { applied: false, reason: 'select_not_found' }
      }
      const value = ${JSON.stringify(value)}
      const option = Array.from(element.options).find(item => item.value === value)
      if (!option || option.disabled) {
        return { applied: false, reason: 'option_not_available' }
      }
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value',
      )?.set
      if (!setter) return { applied: false, reason: 'value_setter_unavailable' }
      setter.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return { applied: element.value === value }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  })
  const result = evaluation.result?.value
  if (!result?.applied) {
    throw protocolError(
      result?.reason || 'browser_select_not_confirmed',
      'Select value could not be confirmed after change',
      409,
    )
  }
  await delay(250)
}

async function waitForDocument(Runtime, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const result = await Runtime.evaluate({
        expression: 'document.readyState',
        returnByValue: true,
      })
      if (['interactive', 'complete'].includes(result.result?.value)) {
        return
      }
    } catch {
      // Navigation can temporarily replace the execution context.
    }
    await delay(100)
  }
  throw new Error('Page did not become observable before timeout')
}

async function recoverNavigation(
  session,
  actionAttemptId,
  key,
  before,
  url,
  error,
) {
  try {
    const observation = await observePage(session)
    if (equivalentUrl(observation.url, url)) {
      return {
        status: 'applied',
        actionAttemptId,
        idempotencyKey: key,
        observation,
        evidence: evidenceFor('navigate', before, url, observation),
      }
    }
    return {
      status: 'outcome_unknown',
      actionAttemptId,
      idempotencyKey: key,
      observation,
      message: error instanceof Error ? error.message : 'Navigation failed',
    }
  } catch {
    return {
      status: 'outcome_unknown',
      actionAttemptId,
      idempotencyKey: key,
      message: error instanceof Error ? error.message : 'Navigation failed',
    }
  }
}

function evidenceFor(primitive, before, target, observation) {
  const ref = createHash('sha256')
    .update(JSON.stringify({
      primitive,
      beforeRef: before?.ref,
      target,
      afterRef: observation.ref,
      actualUrl: observation.url,
    }))
    .digest('hex')
  return {
    kind: `browser_${primitive}`,
    ref: `ev_${ref.slice(0, 32)}`,
    stateChanged: before?.fingerprint !== observation.fingerprint,
    summary: actionSummary(primitive, target, before, observation),
  }
}

function actionSummary(primitive, target, before, observation) {
  const changed = before?.fingerprint !== observation.fingerprint
  if (primitive === 'navigate') {
    return `Navigation applied; page is now ${observation.url}`
  }
  if (primitive === 'fill') {
    return `Field ${target.elementRef} was filled and read back; page state ${
      changed ? 'changed' : 'did not otherwise change'
    }`
  }
  if (primitive === 'select') {
    return `Select ${target.elementRef} changed to the requested option; page state ${
      changed ? 'changed' : 'did not otherwise change'
    }`
  }
  return `Click dispatched to ${target}; page state ${
    changed ? 'changed' : 'did not visibly change'
  }`
}

function storeActionResult(
  session,
  idempotencyKey,
  requestFingerprint,
  result,
) {
  session.actionResults.set(idempotencyKey, {
    requestFingerprint,
    result,
  })
}

function equivalentUrl(actual, expected) {
  try {
    const left = new URL(actual)
    const right = new URL(expected)
    left.hash = ''
    right.hash = ''
    return left.href === right.href
  } catch {
    return actual === expected
  }
}

function requireWebUrl(value) {
  const text = requiredText(value, 'url')
  let url
  try {
    url = new URL(text)
  } catch {
    throw protocolError('invalid_browser_url', 'URL is invalid', 400)
  }
  if (!['http:', 'https:', 'about:'].includes(url.protocol)) {
    throw protocolError(
      'invalid_browser_url',
      'Only http, https, and about:blank are allowed',
      400,
    )
  }
  if (url.username || url.password) {
    throw protocolError(
      'invalid_browser_url',
      'URL user information is not allowed',
      400,
    )
  }
  if (url.protocol === 'about:' && url.href !== 'about:blank') {
    throw protocolError(
      'invalid_browser_url',
      'Only about:blank is allowed',
      400,
    )
  }
  return url.href
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw protocolError(
      'invalid_webbridge_request',
      `${field} is required`,
      400,
    )
  }
  return value.trim()
}

function requireFillValue(value) {
  if (typeof value !== 'string') {
    throw protocolError(
      'invalid_browser_field_value',
      'Field value must be a string',
      400,
    )
  }
  if (value.length > 20_000) {
    throw protocolError(
      'invalid_browser_field_value',
      'Field value exceeds 20000 characters',
      400,
    )
  }
  return value
}

function matchesWait(
  condition,
  text,
  baselineFingerprint,
  observation,
) {
  if (!observation) return false
  if (condition === 'ready') return observation.readyState === 'complete'
  if (condition === 'text') return observation.text?.includes(text) === true
  return observation.fingerprint !== baselineFingerprint
}

function protocolError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

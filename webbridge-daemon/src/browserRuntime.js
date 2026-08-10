import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as chromeLauncher from 'chrome-launcher'
import CDP from 'chrome-remote-interface'
import { config } from './config.js'
import {
  observationIsCurrent,
  observePage,
  probePage,
} from './observation.js'

const sessions = new Map()
const MAX_ACTION_RESULTS_PER_SESSION = 256
let chrome = null
let chromeLaunch = null

export function browserInstallation() {
  if (config.browserPath) {
    return fs.existsSync(config.browserPath)
      ? { available: true, path: config.browserPath, product: 'configured' }
      : {
          available: false,
          error: 'IRIS_WEBBRIDGE_BROWSER_PATH does not exist',
        }
  }
  const home = os.homedir()
  const localAppData = process.env.LOCALAPPDATA
    || path.join(home, 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)']
    || 'C:\\Program Files (x86)'
  const candidates = [
    ['edge', path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['edge', path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['edge', path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['chrome', path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome', path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome', path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')],
  ]
  const detected = candidates.find(([, candidate]) => fs.existsSync(candidate))
  if (detected) {
    return { available: true, product: detected[0], path: detected[1] }
  }
  try {
    const fallback = chromeLauncher.Launcher.getInstallations()[0]
    if (fallback) {
      return { available: true, product: 'chromium', path: fallback }
    }
  } catch {
    // Report one stable availability error below.
  }
  return {
    available: false,
    error: 'Microsoft Edge / Chrome / Chromium was not found',
  }
}

export async function runtimeState() {
  const installation = browserInstallation()
  const running = await chromeIsAlive()
  await reconcileSessions(running)
  return {
    browserReady: installation.available,
    browserRunning: running,
    browserPath: installation.path,
    browserProduct: installation.product,
    browserError: installation.error,
    sessionCount: sessions.size,
  }
}

export async function listSessions() {
  await reconcileSessions(await chromeIsAlive())
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
      pageCount: session.backgroundPages.size + 1,
      pages: ownedPageSummaries(session),
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
    client.DOM.enable(),
  ])

  const session = {
    sessionId: `brs_${randomUUID().replaceAll('-', '')}`,
    pageId: target.id,
    client,
    createdAt: new Date(),
    pageCreatedAt: new Date(),
    lastUsedAt: new Date(),
    revision: 0,
    lastObservation: null,
    lastObservationLimits: null,
    lastActionFingerprint: null,
    elementLocators: new Map(),
    elements: new Map(),
    backgroundPages: new Map(),
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

export async function openPage(sessionId, body) {
  const session = requireSession(sessionId)
  const url = requireWebUrl(body.url)
  const key = requiredText(body.idempotencyKey, 'idempotencyKey')
  const actionAttemptId = requiredText(
    body.actionAttemptId,
    'actionAttemptId',
  )
  const requestFingerprint = createHash('sha256')
    .update(JSON.stringify({ primitive: 'open_page', url }))
    .digest('hex')
  const previous = session.actionResults.get(key)
  if (previous) {
    if (previous.requestFingerprint !== requestFingerprint) {
      throw protocolError(
        'browser_idempotency_conflict',
        'Idempotency key was already used for another browser page',
        409,
      )
    }
    return previous.result
  }

  const launched = await ensureChrome()
  const target = await CDP.New({ port: launched.port, url: 'about:blank' })
  let nextClient
  const previousPageId = session.pageId
  let activated = false
  try {
    nextClient = await CDP({ port: launched.port, target: target.id })
    await Promise.all([
      nextClient.Page.enable(),
      nextClient.Runtime.enable(),
      nextClient.DOM.enable(),
    ])
    saveActivePage(session)
    activateFreshPage(session, target.id, nextClient)
    activated = true
    if (url !== 'about:blank') {
      await navigateAndSettle(session, url)
    }
    const observation = await observePage(session)
    const result = {
      status: 'applied',
      actionAttemptId,
      idempotencyKey: key,
      pageId: session.pageId,
      openedNewPage: true,
      pages: ownedPageSummaries(session),
      observation,
      evidence: evidenceFor('open_page', null, { url }, observation),
    }
    storeActionResult(session, key, requestFingerprint, result)
    return result
  } catch (error) {
    await nextClient?.close().catch(() => undefined)
    await CDP.Close({ port: launched.port, id: target.id })
      .catch(() => undefined)
    const previousPage = activated
      ? session.backgroundPages.get(previousPageId)
      : null
    if (previousPage) {
      session.backgroundPages.delete(previousPageId)
      restorePage(session, previousPage)
    }
    throw error
  }
}

export async function switchPage(sessionId, body) {
  const session = requireSession(sessionId)
  const pageId = requiredText(body.pageId, 'pageId')
  if (pageId !== session.pageId) {
    const next = session.backgroundPages.get(pageId)
    if (!next) {
      throw protocolError(
        'browser_page_not_found',
        'Page does not belong to this BrowserSession',
        404,
      )
    }
    saveActivePage(session)
    session.backgroundPages.delete(pageId)
    restorePage(session, next)
  }
  await session.client.Page.bringToFront().catch(() => undefined)
  const observation = await observePage(session, body)
  return {
    sessionId,
    pageId: session.pageId,
    activePageId: session.pageId,
    pages: ownedPageSummaries(session),
    observation,
  }
}

export async function closePage(sessionId, body) {
  const session = requireSession(sessionId)
  if (!await chromeIsAlive()) {
    throw protocolError(
      'browser_not_running',
      'Browser process is no longer available',
      503,
    )
  }
  const pageId = requiredText(body.pageId, 'pageId')
  const key = requiredText(body.idempotencyKey, 'idempotencyKey')
  const actionAttemptId = requiredText(body.actionAttemptId, 'actionAttemptId')
  const requestFingerprint = createHash('sha256')
    .update(JSON.stringify({ primitive: 'close_page', pageId }))
    .digest('hex')
  const previous = session.actionResults.get(key)
  if (previous) {
    if (previous.requestFingerprint !== requestFingerprint) {
      throw protocolError(
        'browser_idempotency_conflict',
        'Idempotency key was already used for another page close',
        409,
      )
    }
    return previous.result
  }
  const closingActive = pageId === session.pageId
  const closingPage = closingActive
    ? pageState(session)
    : session.backgroundPages.get(pageId)
  if (!closingPage) {
    throw protocolError(
      'browser_page_not_found',
      'Page does not belong to this BrowserSession',
      404,
    )
  }
  if (session.backgroundPages.size === 0) {
    throw protocolError(
      'browser_last_page_requires_session_close',
      'The last page cannot be closed alone; close the BrowserSession',
      409,
    )
  }
  if (closingActive) {
    const replacements = [...session.backgroundPages.values()]
    const replacement = replacements.at(-1)
    session.backgroundPages.delete(replacement.pageId)
    restorePage(session, replacement)
  } else {
    session.backgroundPages.delete(pageId)
  }

  await CDP.Close({ port: chrome.port, id: pageId })
    .catch(() => undefined)
  const livePageIds = await pageTargetIds()
  const closed = !livePageIds.has(pageId)
  if (closed) {
    await closingPage.client.close().catch(() => undefined)
  }
  if (!closed) {
    session.backgroundPages.set(pageId, closingPage)
    const result = {
      status: 'outcome_unknown',
      actionAttemptId,
      idempotencyKey: key,
      closedPageId: pageId,
      activePageId: session.pageId,
      pages: ownedPageSummaries(session),
      message: 'Browser target still appeared after close was requested',
    }
    storeActionResult(session, key, requestFingerprint, result)
    return result
  }
  const observation = closingActive
    ? await observePage(session).catch(() => session.lastObservation)
    : session.lastObservation
  const evidenceHash = createHash('sha256')
    .update(JSON.stringify({ pageId, activePageId: session.pageId, key }))
    .digest('hex')
  const result = {
    status: 'applied',
    actionAttemptId,
    idempotencyKey: key,
    closedPageId: pageId,
    activePageId: session.pageId,
    pages: ownedPageSummaries(session),
    observation,
    evidence: {
      kind: 'browser_page_close',
      ref: `ev_${evidenceHash.slice(0, 32)}`,
      summary: closingActive
        ? `Closed active page and switched to ${session.pageId}`
        : `Closed background page ${pageId}`,
    },
  }
  storeActionResult(session, key, requestFingerprint, result)
  return result
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
  const observationLimits = {
    ...body,
    purpose: condition === 'text' ? 'read' : 'interact',
  }
  let observation = await probePage(session, observationLimits)
  let conditionMet = matchesWait(
    condition,
    text,
    baselineFingerprint,
    observation,
  )
  while (!conditionMet && Date.now() < deadline) {
    await delay(250)
    observation = await probePage(session, observationLimits)
    conditionMet = matchesWait(
      condition,
      text,
      baselineFingerprint,
      observation,
    )
  }
  observation = await observePage(session, observationLimits)
  conditionMet = matchesWait(
    condition,
    text,
    baselineFingerprint,
    observation,
  )
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
  if (!['navigate', 'history', 'click', 'fill', 'upload', 'select', 'scroll', 'press'].includes(
    request.primitive,
  )) {
    throw protocolError(
      'unsupported_browser_primitive',
      `Unsupported primitive: ${request.primitive}`,
      400,
    )
  }
  const pageId = requiredText(request.normalizedArgs?.pageId, 'pageId')
  requirePage(session, pageId)
  if (['history', 'click', 'fill', 'upload', 'select', 'scroll', 'press'].includes(request.primitive)
      && !request.expectedObservationRef) {
    throw protocolError(
      'browser_observation_required',
      'Page actions require an expected observation reference',
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
  if (
    request.expectedObservationRef
    && !await observationIsCurrent(session)
  ) {
    const result = {
      status: 'not_applied',
      actionAttemptId,
      idempotencyKey: key,
      message: 'The page changed after the expected observation; observe again',
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
  const pageIdsBefore = ['click', 'press'].includes(request.primitive)
    ? await pageTargetIds()
    : null
  let result
  try {
    let target
    if (request.primitive === 'navigate') {
      target = requireWebUrl(request.normalizedArgs?.url)
    } else if (request.primitive === 'history') {
      target = requireHistoryDirection(request.normalizedArgs?.direction)
    } else if (request.primitive === 'click') {
      target = requiredText(
        request.normalizedArgs?.elementRef,
        'elementRef',
      )
    } else if (request.primitive === 'scroll') {
      target = {
        direction: requireScrollDirection(
          request.normalizedArgs?.direction,
        ),
        amount: boundScrollAmount(request.normalizedArgs?.amount),
      }
    } else if (request.primitive === 'press') {
      target = {
        key: requireBrowserKey(request.normalizedArgs?.key),
        elementRef: optionalText(request.normalizedArgs?.elementRef),
      }
    } else if (request.primitive === 'upload') {
      target = requireUploadTarget(request.normalizedArgs)
    } else {
      target = {
        elementRef: requiredText(
          request.normalizedArgs?.elementRef,
          'elementRef',
        ),
        value: requireFillValue(request.normalizedArgs?.value),
      }
    }
    if (request.primitive === 'navigate') {
      await navigateAndSettle(session, target)
    } else if (request.primitive === 'history') {
      await navigateHistory(session, target)
    } else if (request.primitive === 'click') {
      await clickElement(session, target)
      await adoptNewPage(session, pageIdsBefore)
    } else if (request.primitive === 'fill') {
      await fillElement(session, target.elementRef, target.value)
    } else if (request.primitive === 'upload') {
      await uploadFile(session, target)
    } else if (request.primitive === 'select') {
      await selectOption(session, target.elementRef, target.value)
    } else if (request.primitive === 'press') {
      await pressKey(session, target.key, target.elementRef)
      await adoptNewPage(session, pageIdsBefore)
    } else {
      await scrollPage(session, target.direction, target.amount)
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
        openedNewPage: pageIdsBefore !== null
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
    } else if (knownNotApplied(error)) {
      result = {
        status: 'not_applied',
        actionAttemptId,
        idempotencyKey: key,
        message: error instanceof Error
          ? error.message
          : 'Browser action was not applied',
        currentObservationRef: session.lastObservation?.ref,
      }
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
  const pages = [
    pageState(session),
    ...session.backgroundPages.values(),
  ]
  await Promise.all(pages.map(page =>
    page.client.close().catch(() => undefined)
  ))
  if (chrome) {
    await Promise.all(pages.map(page =>
      CDP.Close({ port: chrome.port, id: page.pageId })
        .catch(() => undefined)
    ))
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

async function reconcileSessions(browserRunning) {
  if (!browserRunning || !chrome) {
    await Promise.all([...sessions.keys()].map(closeSession))
    return
  }
  let livePageIds
  try {
    livePageIds = await pageTargetIds()
  } catch {
    return
  }
  for (const session of [...sessions.values()]) {
    for (const [pageId, page] of session.backgroundPages) {
      if (!livePageIds.has(pageId)) {
        session.backgroundPages.delete(pageId)
        await page.client.close().catch(() => undefined)
      }
    }
    if (livePageIds.has(session.pageId)) continue

    await session.client.close().catch(() => undefined)
    const replacement = session.backgroundPages.values().next().value
    if (!replacement) {
      await closeSession(session.sessionId)
      continue
    }
    session.backgroundPages.delete(replacement.pageId)
    restorePage(session, replacement)
  }
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
  if (await chromeIsAlive()) return chrome
  if (!chromeLaunch) {
    chromeLaunch = launchChrome().finally(() => {
      chromeLaunch = null
    })
  }
  return chromeLaunch
}

async function launchChrome() {
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

async function chromeIsAlive() {
  if (!chrome) return false
  try {
    await CDP.Version({ port: chrome.port })
    return true
  } catch {
    const stale = chrome
    chrome = null
    await stale.kill().catch(() => undefined)
    return false
  }
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
  await waitForObservableContent(session.client.Runtime, 2_500)
}

async function navigateHistory(session, direction) {
  if (direction === 'reload') {
    await session.client.Page.reload()
  } else {
    const history = await session.client.Page.getNavigationHistory()
    const offset = direction === 'back' ? -1 : 1
    const entry = history.entries?.[history.currentIndex + offset]
    if (!entry) {
      throw protocolError(
        'browser_history_unavailable',
        `Browser history has no ${direction} entry`,
        409,
      )
    }
    await session.client.Page.navigateToHistoryEntry({ entryId: entry.id })
  }
  await waitForDocument(session.client.Runtime, 20_000)
  await waitForObservableContent(session.client.Runtime, 2_500)
}

async function clickElement(session, elementRef) {
  const locator = session.elementLocators.get(elementRef)
  const metadata = session.elements.get(elementRef)
  if (!locator || !metadata) {
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
    expression: locatedElementExpression(locator, `
      element.scrollIntoView({ block: 'center', inline: 'center' })
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      if (style.display === 'none' || style.visibility === 'hidden'
          || rect.width <= 0 || rect.height <= 0) {
        return { applied: false, reason: 'element_not_visible' }
      }
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') {
        return { applied: false, reason: 'element_disabled' }
      }
      let x = rect.left + rect.width / 2
      let y = rect.top + rect.height / 2
      let view = element.ownerDocument?.defaultView
      while (view && view !== window) {
        const frame = view.frameElement
        if (!frame) break
        const frameRect = frame.getBoundingClientRect()
        x += frameRect.left
        y += frameRect.top
        view = frame.ownerDocument?.defaultView
      }
      x = Math.max(0, Math.min(window.innerWidth - 1, x))
      y = Math.max(0, Math.min(window.innerHeight - 1, y))
      const hit = document.elementFromPoint(x, y)
      const nested = element.ownerDocument !== document
        || element.getRootNode() instanceof ShadowRoot
      if (!nested && (!hit || (hit !== element && !element.contains(hit)))) {
        return { applied: false, reason: 'element_obscured' }
      }
      return { applied: true, x, y }
    `),
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
  await session.client.Input.dispatchMouseEvent({
    type: 'mouseMoved',
    x: result.x,
    y: result.y,
  })
  await session.client.Input.dispatchMouseEvent({
    type: 'mousePressed',
    x: result.x,
    y: result.y,
    button: 'left',
    clickCount: 1,
  })
  await session.client.Input.dispatchMouseEvent({
    type: 'mouseReleased',
    x: result.x,
    y: result.y,
    button: 'left',
    clickCount: 1,
  })
  await delay(400)
  await waitForDocument(session.client.Runtime, 5_000).catch(() => undefined)
}

async function scrollPage(session, direction, amount) {
  const expression = `(() => {
    const direction = ${JSON.stringify(direction)}
    const amount = ${JSON.stringify(amount)}
    if (direction === 'top') {
      window.scrollTo({ top: 0, left: window.scrollX, behavior: 'instant' })
    } else if (direction === 'bottom') {
      window.scrollTo({
        top: Math.max(
          document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0,
        ),
        left: window.scrollX,
        behavior: 'instant',
      })
    } else {
      window.scrollBy({
        top: direction === 'up' ? -amount : amount,
        left: 0,
        behavior: 'instant',
      })
    }
    return { scrollX: window.scrollX, scrollY: window.scrollY }
  })()`
  await session.client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  await delay(250)
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
        nextClient.DOM.enable(),
      ])
      saveActivePage(session)
      activateFreshPage(session, created.id, nextClient)
      await waitForDocument(nextClient.Runtime, 10_000)
        .catch(() => undefined)
      return true
    }
    await delay(100)
  }
  return false
}

function activateFreshPage(session, pageId, client) {
  session.client = client
  session.pageId = pageId
  session.pageCreatedAt = new Date()
  session.revision = 0
  session.lastObservation = null
  session.lastObservationLimits = null
  session.lastActionFingerprint = null
  session.elementLocators = new Map()
  session.elements = new Map()
}

function saveActivePage(session) {
  session.backgroundPages.set(session.pageId, pageState(session))
}

function pageState(session) {
  return {
    pageId: session.pageId,
    client: session.client,
    pageCreatedAt: session.pageCreatedAt,
    revision: session.revision,
    lastObservation: session.lastObservation,
    lastObservationLimits: session.lastObservationLimits,
    lastActionFingerprint: session.lastActionFingerprint,
    elementLocators: session.elementLocators,
    elements: session.elements,
  }
}

function restorePage(session, page) {
  session.pageId = page.pageId
  session.client = page.client
  session.pageCreatedAt = page.pageCreatedAt
  session.revision = page.revision
  session.lastObservation = page.lastObservation
  session.lastObservationLimits = page.lastObservationLimits
  session.lastActionFingerprint = page.lastActionFingerprint
  session.elementLocators = page.elementLocators
  session.elements = page.elements
}

function ownedPageSummaries(session) {
  const active = pageSummary(pageState(session), true)
  const background = [...session.backgroundPages.values()]
    .map(page => pageSummary(page, false))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  return [active, ...background]
}

function pageSummary(page, active) {
  return {
    pageId: page.pageId,
    active,
    createdAt: page.pageCreatedAt.toISOString(),
    url: page.lastObservation?.url || '',
    title: page.lastObservation?.title || '',
    observationRef: page.lastObservation?.ref,
    revision: page.lastObservation?.revision || 0,
  }
}

async function fillElement(session, elementRef, value) {
  const locator = session.elementLocators.get(elementRef)
  const metadata = session.elements.get(elementRef)
  if (!locator || !metadata) {
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
    expression: locatedElementExpression(locator, `
      const value = ${JSON.stringify(value)}
      if (element.disabled || element.getAttribute('aria-disabled') === 'true') {
        return { applied: false, reason: 'element_disabled' }
      }
      element.scrollIntoView({ block: 'center', inline: 'center' })
      element.focus()
      if (element.isContentEditable) {
        element.textContent = value
      } else {
        const view = element.ownerDocument?.defaultView || window
        const prototype = element.tagName.toLowerCase() === 'textarea'
          ? view.HTMLTextAreaElement.prototype
          : view.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
        if (!setter) return { applied: false, reason: 'value_setter_unavailable' }
        setter.call(element, value)
      }
      const view = element.ownerDocument?.defaultView || window
      element.dispatchEvent(new view.InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: value,
      }))
      element.dispatchEvent(new view.Event('change', { bubbles: true }))
      const actual = element.isContentEditable
        ? String(element.textContent || '')
        : String(element.value || '')
      return { applied: actual === value }
    `),
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
  const locator = session.elementLocators.get(elementRef)
  const metadata = session.elements.get(elementRef)
  if (!locator || !metadata || metadata.tag !== 'select') {
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
    expression: locatedElementExpression(locator, `
      const view = element.ownerDocument?.defaultView || window
      if (!(element instanceof view.HTMLSelectElement)) {
        return { applied: false, reason: 'select_not_found' }
      }
      const value = ${JSON.stringify(value)}
      const option = Array.from(element.options).find(item => item.value === value)
      if (!option || option.disabled) {
        return { applied: false, reason: 'option_not_available' }
      }
      const setter = Object.getOwnPropertyDescriptor(
        view.HTMLSelectElement.prototype,
        'value',
      )?.set
      if (!setter) return { applied: false, reason: 'value_setter_unavailable' }
      setter.call(element, value)
      element.dispatchEvent(new view.Event('input', { bubbles: true }))
      element.dispatchEvent(new view.Event('change', { bubbles: true }))
      return { applied: element.value === value }
    `),
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

async function uploadFile(session, target) {
  const locator = session.elementLocators.get(target.elementRef)
  const metadata = session.elements.get(target.elementRef)
  if (!locator || !metadata) {
    throw protocolError(
      'browser_element_not_found',
      'Element reference does not belong to the current observation',
      404,
    )
  }
  if (metadata.tag !== 'input' || metadata.type !== 'file') {
    throw protocolError(
      'browser_file_input_required',
      'Element reference is not a file input',
      409,
    )
  }
  if (metadata.disabled) {
    throw protocolError(
      'browser_element_disabled',
      'The selected file input is disabled',
      409,
    )
  }
  const evaluation = await session.client.Runtime.evaluate({
    expression: locatedElementObjectExpression(locator),
    returnByValue: false,
    awaitPromise: true,
  })
  const objectId = evaluation.result?.objectId
  if (!objectId) {
    throw protocolError(
      'browser_element_not_found',
      'File input could not be resolved from the current observation',
      404,
    )
  }
  try {
    const described = await session.client.DOM.describeNode({ objectId })
    const backendNodeId = described.node?.backendNodeId
    if (!backendNodeId) {
      throw protocolError(
        'browser_element_not_found',
        'File input no longer has a browser node identity',
        404,
      )
    }
    await session.client.DOM.setFileInputFiles({
      files: [target.filePath],
      backendNodeId,
    })
    const confirmed = await session.client.Runtime.callFunctionOn({
      objectId,
      functionDeclaration: `function() {
        const file = this.files?.[0]
        return file ? { name: file.name, size: file.size } : null
      }`,
      returnByValue: true,
    })
    const actual = confirmed.result?.value
    if (!actual
        || actual.name !== target.fileName
        || actual.size !== target.byteCount) {
      throw protocolError(
        'browser_upload_not_confirmed',
        'File input did not report the expected file after upload',
        409,
      )
    }
  } finally {
    await session.client.Runtime.releaseObject({ objectId })
      .catch(() => undefined)
  }
  await delay(250)
}

async function pressKey(session, key, elementRef) {
  if (elementRef) {
    const locator = session.elementLocators.get(elementRef)
    const metadata = session.elements.get(elementRef)
    if (!locator || !metadata) {
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
    const focused = await session.client.Runtime.evaluate({
      expression: locatedElementExpression(locator, `
        element.scrollIntoView({ block: 'center', inline: 'center' })
        element.focus()
        return { applied: element.ownerDocument.activeElement === element
          || element.contains(element.ownerDocument.activeElement)
        }
      `),
      returnByValue: true,
      awaitPromise: true,
    })
    if (focused.result?.value?.applied !== true) {
      throw protocolError(
        'browser_element_not_focusable',
        'The selected element could not receive keyboard focus',
        409,
      )
    }
  }
  const descriptor = keyDescriptor(key)
  await session.client.Input.dispatchKeyEvent({
    type: 'rawKeyDown',
    ...descriptor,
  })
  await session.client.Input.dispatchKeyEvent({
    type: 'keyUp',
    ...descriptor,
  })
  await delay(300)
  await waitForDocument(session.client.Runtime, 5_000).catch(() => undefined)
}

function locatedElementExpression(locator, body) {
  return `(() => {
    const path = ${JSON.stringify(locator)}
    let root = document
    let element = null
    for (const segment of path) {
      element = root?.querySelector?.(segment.selector) || null
      if (!element) {
        return { applied: false, reason: 'element_not_found' }
      }
      if (segment.enter === 'shadow') {
        root = element.shadowRoot
        if (!root) {
          return { applied: false, reason: 'shadow_root_not_available' }
        }
      } else if (segment.enter === 'frame') {
        try {
          root = element.contentDocument
        } catch {
          root = null
        }
        if (!root) {
          return { applied: false, reason: 'frame_document_not_available' }
        }
      }
    }
    ${body}
  })()`
}

function locatedElementObjectExpression(locator) {
  return `(() => {
    const path = ${JSON.stringify(locator)}
    let root = document
    let element = null
    for (const segment of path) {
      element = root?.querySelector?.(segment.selector) || null
      if (!element) return null
      if (segment.enter === 'shadow') {
        root = element.shadowRoot
      } else if (segment.enter === 'frame') {
        try {
          root = element.contentDocument
        } catch {
          root = null
        }
      }
      if (segment.enter && !root) return null
    }
    return element
  })()`
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

async function waitForObservableContent(Runtime, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const result = await Runtime.evaluate({
        expression: `(() => {
          const text = String(document.body?.innerText || '').trim()
          const interactive = document.querySelector(
            'a[href],button,input,textarea,select,[role="button"],'
            + '[role="link"],[role="textbox"],[contenteditable="true"]'
          )
          return text.length >= 20 || Boolean(interactive)
        })()`,
        returnByValue: true,
      })
      if (result.result?.value === true) return
    } catch {
      // Navigation may replace the execution context while the SPA boots.
    }
    await delay(100)
  }
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
        pageId: session.pageId,
        openedNewPage: false,
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
  if (primitive === 'open_page') {
    return `New browser page opened at ${observation.url}`
  }
  if (primitive === 'history') {
    return `Browser history ${target} applied; page is now ${observation.url}`
  }
  if (primitive === 'fill') {
    return `Field ${target.elementRef} was filled and read back; page state ${
      changed ? 'changed' : 'did not otherwise change'
    }`
  }
  if (primitive === 'upload') {
    return `File ${target.fileName} (${target.byteCount} bytes) was set on ${
      target.elementRef
    }; page state ${changed ? 'changed' : 'did not otherwise change'}`
  }
  if (primitive === 'select') {
    return `Select ${target.elementRef} changed to the requested option; page state ${
      changed ? 'changed' : 'did not otherwise change'
    }`
  }
  if (primitive === 'scroll') {
    const beforeY = before?.viewport?.scrollY ?? 0
    const afterY = observation.viewport?.scrollY ?? beforeY
    return `Viewport scrolled from ${beforeY}px to ${afterY}px; page state ${
      changed ? 'changed' : 'did not otherwise change'
    }`
  }
  if (primitive === 'press') {
    return `Key ${target.key} was dispatched${
      target.elementRef ? ` to ${target.elementRef}` : ''
    }; page state ${changed ? 'changed' : 'did not visibly change'}`
  }
  return `Click dispatched to ${target}; page state ${
    changed ? 'changed' : 'did not visibly change'
  }`
}

function requireScrollDirection(value) {
  if (!['up', 'down', 'top', 'bottom'].includes(value)) {
    throw protocolError(
      'invalid_browser_scroll_direction',
      'Scroll direction must be up, down, top, or bottom',
      400,
    )
  }
  return value
}

function requireHistoryDirection(value) {
  if (!['back', 'forward', 'reload'].includes(value)) {
    throw protocolError(
      'invalid_browser_history_direction',
      'History direction must be back, forward, or reload',
      400,
    )
  }
  return value
}

function requireUploadTarget(args) {
  const elementRef = requiredText(args?.elementRef, 'elementRef')
  const filePath = requiredText(args?.filePath, 'filePath')
  const fileName = requiredText(args?.fileName, 'fileName')
  if (!path.isAbsolute(filePath)) {
    throw protocolError(
      'invalid_browser_upload_path',
      'Upload path must be an absolute path resolved by Backend',
      400,
    )
  }
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    throw protocolError(
      'browser_upload_file_not_found',
      'Upload file no longer exists',
      404,
    )
  }
  if (!stat.isFile() || stat.size !== args?.byteCount) {
    throw protocolError(
      'browser_upload_file_changed',
      'Upload file is not regular or changed after approval',
      409,
    )
  }
  return { elementRef, filePath, fileName, byteCount: stat.size }
}

function boundScrollAmount(value) {
  if (value === undefined || value === null) return 800
  if (!Number.isInteger(value) || value < 100 || value > 5_000) {
    throw protocolError(
      'invalid_browser_scroll_amount',
      'Scroll amount must be an integer between 100 and 5000',
      400,
    )
  }
  return value
}

const BROWSER_KEYS = new Map([
  ['Enter', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }],
  ['Escape', { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }],
  ['Tab', { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }],
  ['ArrowUp', { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 }],
  ['ArrowDown', { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }],
  ['ArrowLeft', { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }],
  ['ArrowRight', { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }],
  ['Home', { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }],
  ['End', { key: 'End', code: 'End', windowsVirtualKeyCode: 35 }],
  ['PageUp', { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 }],
  ['PageDown', { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }],
  ['Backspace', { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }],
  ['Delete', { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }],
  ['Space', { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }],
])

function requireBrowserKey(value) {
  const key = requiredText(value, 'key')
  if (!BROWSER_KEYS.has(key)) {
    throw protocolError(
      'invalid_browser_key',
      'Key must be Enter, Escape, Tab, an arrow/navigation key, Backspace, Delete, or Space',
      400,
    )
  }
  return key
}

function keyDescriptor(key) {
  return BROWSER_KEYS.get(key)
}

function optionalText(value) {
  if (value === undefined || value === null || value === '') return null
  return requiredText(value, 'elementRef')
}

const DEFINITELY_NOT_APPLIED_CODES = new Set([
  'browser_element_not_found',
  'browser_element_disabled',
  'browser_element_not_focusable',
  'browser_field_not_fillable',
  'browser_file_input_required',
  'browser_select_not_supported',
  'element_not_found',
  'element_not_visible',
  'element_obscured',
  'element_disabled',
  'browser_click_not_applied',
  'shadow_root_not_available',
  'frame_document_not_available',
  'option_not_available',
  'select_not_found',
  'value_setter_unavailable',
  'invalid_browser_scroll_direction',
  'invalid_browser_scroll_amount',
  'invalid_browser_history_direction',
  'browser_history_unavailable',
  'invalid_browser_upload_path',
  'browser_upload_file_not_found',
  'browser_upload_file_changed',
  'invalid_browser_key',
])

function knownNotApplied(error) {
  return DEFINITELY_NOT_APPLIED_CODES.has(error?.code)
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
  while (session.actionResults.size > MAX_ACTION_RESULTS_PER_SESSION) {
    const oldestKey = session.actionResults.keys().next().value
    session.actionResults.delete(oldestKey)
  }
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

import { createHash } from 'node:crypto'

const OBSERVATION_SCRIPT = `(limits => {
  const visible = element => {
    const view = element.ownerDocument?.defaultView || window
    const style = view.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.visibility !== 'hidden'
      && style.display !== 'none'
      && rect.width > 0
      && rect.height > 0
  }

  const inViewport = element => {
    const rect = topBounds(element)
    return rect.bottom > 0
      && rect.right > 0
      && rect.top < window.innerHeight
      && rect.left < window.innerWidth
  }

  const topBounds = element => {
    const local = element.getBoundingClientRect()
    let left = local.left
    let top = local.top
    let view = element.ownerDocument?.defaultView
    while (view && view !== window) {
      const frame = view.frameElement
      if (!frame) break
      const frameRect = frame.getBoundingClientRect()
      left += frameRect.left
      top += frameRect.top
      view = frame.ownerDocument?.defaultView
    }
    return {
      left,
      top,
      right: left + local.width,
      bottom: top + local.height,
      x: left,
      y: top,
      width: local.width,
      height: local.height,
    }
  }

  const cssEscape = value => {
    if (globalThis.CSS?.escape) return CSS.escape(value)
    return String(value).replace(/[^a-zA-Z0-9_-]/g, char => '\\\\' + char)
  }

  const selector = element => {
    if (element.id) return '#' + cssEscape(element.id)
    const parts = []
    let current = element
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let part = current.tagName.toLowerCase()
      const parent = current.parentElement
      if (parent) {
        const siblings = Array.from(parent.children)
          .filter(candidate => candidate.tagName === current.tagName)
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
        }
      }
      parts.unshift(part)
      if (parent?.id) {
        parts.unshift('#' + cssEscape(parent.id))
        break
      }
      current = parent
    }
    return parts.join(' > ')
  }

  const locator = element => {
    const path = [{ selector: selector(element) }]
    let current = element
    while (current) {
      const root = current.getRootNode()
      if (root?.nodeType === 11 && root.host) {
        current = root.host
        path.unshift({ selector: selector(current), enter: 'shadow' })
        continue
      }
      const view = current.ownerDocument?.defaultView
      if (view && view !== window && view.frameElement) {
        current = view.frameElement
        path.unshift({ selector: selector(current), enter: 'frame' })
        continue
      }
      break
    }
    return path
  }

  const label = element => {
    const aria = element.getAttribute('aria-label')
    if (aria) return aria.trim()
    if (element.labels?.length) {
      return Array.from(element.labels)
        .map(item => item.innerText || item.textContent || '')
        .join(' ')
        .trim()
    }
    const placeholder = element.getAttribute('placeholder')
    if (placeholder) return placeholder.trim()
    const text = element.innerText || element.textContent || ''
    return text.replace(/\\s+/g, ' ').trim().slice(0, 240)
  }

  const semanticContext = element => {
    const values = []
    const ownName = label(element)
    const add = value => {
      const normalized = String(value || '').replace(/\\s+/g, ' ').trim()
      if (normalized && normalized !== ownName && !values.includes(normalized)) {
        values.push(normalized.slice(0, 180))
      }
    }
    const container = element.closest(
      '[role="dialog"],dialog,form,fieldset,section,article,nav,main,li,tr'
    )
    if (container && container !== element) {
      add(container.getAttribute('aria-label'))
      add(container.querySelector(':scope > legend')?.textContent)
      add(container.querySelector('h1,h2,h3,h4,h5,h6')?.textContent)
    }
    let root = element.getRootNode()
    while (root?.nodeType === 11 && root.host) {
      add(root.host.getAttribute('aria-label'))
      add(root.host.getAttribute('title'))
      root = root.host.getRootNode()
    }
    let view = element.ownerDocument?.defaultView
    while (view && view !== window && view.frameElement) {
      add(view.frameElement.getAttribute('title'))
      add(view.frameElement.getAttribute('name'))
      view = view.frameElement.ownerDocument?.defaultView
    }
    return values.join(' / ').slice(0, 300) || undefined
  }

  const interactiveSelector = 'a[href],button,input,textarea,select,'
    + '[role="button"],[role="link"],[role="textbox"],[role="checkbox"],'
    + '[role="radio"],[role="combobox"],[role="menuitem"],[role="option"],'
    + '[role="switch"],[role="slider"],summary,[contenteditable="true"],'
    + '[tabindex],[onclick]'
  const collected = []
  const collectedFrames = []
  const collectedTextRoots = []
  const visitedRoots = new WeakSet()
  const collectRoot = (root, frameDepth = 0, shadowDepth = 0) => {
    if (!root || visitedRoots.has(root) || frameDepth > 5 || shadowDepth > 8) {
      return
    }
    visitedRoots.add(root)
    collectedTextRoots.push(root)
    for (const element of root.querySelectorAll(interactiveSelector)) {
      collected.push({ element, frameDepth, shadowDepth })
    }
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        collectRoot(element.shadowRoot, frameDepth, shadowDepth + 1)
      }
      if (element.tagName?.toLowerCase() === 'iframe') {
        let sameOrigin = false
        try {
          sameOrigin = Boolean(element.contentDocument)
          collectRoot(element.contentDocument, frameDepth + 1, shadowDepth)
        } catch {
          // Cross-origin frames remain visible as frame elements but are not inspected.
        }
        collectedFrames.push({
          src: String(element.src || '').slice(0, 2_000),
          title: String(element.getAttribute('title') || '').slice(0, 240),
          name: String(element.getAttribute('name') || '').slice(0, 240),
          sameOrigin,
          frameDepth: frameDepth + 1,
          bounds: topBounds(element),
        })
      }
    }
  }
  collectRoot(document)
  const allCandidates = collected
    .filter(candidate => visible(candidate.element))
    .map((candidate, index) => ({
      ...candidate,
      index,
      inViewport: inViewport(candidate.element),
    }))
    .sort((left, right) =>
      Number(right.inViewport) - Number(left.inViewport)
      || left.index - right.index
    )
  const normalizedQuery = String(limits.searchQuery || '')
    .toLocaleLowerCase()
  const candidates = limits.purpose === 'search'
    ? allCandidates.filter(candidate => {
        const element = candidate.element
        const type = String(element.getAttribute('type') || '').toLowerCase()
        const value = element.tagName.toLowerCase() === 'input'
          && type === 'password'
          ? ''
          : String(element.value || '')
        return [
          label(element),
          element.getAttribute('placeholder') || '',
          element.getAttribute('title') || '',
          element.getAttribute('href') || '',
          value,
        ].join(' ').toLocaleLowerCase().includes(normalizedQuery)
      })
    : allCandidates

  const elements = candidates.slice(0, limits.maxElements).map((candidate, index) => {
    const element = candidate.element
    const tag = element.tagName.toLowerCase()
    const type = String(element.getAttribute('type') || '').toLowerCase()
    const password = tag === 'input' && type === 'password'
    const rect = topBounds(element)
    const options = tag === 'select'
      ? Array.from(element.options).slice(0, 100).map(option => ({
          value: option.value,
          label: String(option.label || option.textContent || '').trim().slice(0, 240),
          selected: option.selected,
          disabled: option.disabled,
        }))
      : undefined
    const item = {
      ref: 'e' + (index + 1),
      tag,
      role: element.getAttribute('role') || undefined,
      name: label(element),
      context: semanticContext(element),
      type: type || undefined,
      placeholder: element.getAttribute('placeholder') || undefined,
      contentEditable: element.isContentEditable,
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
      required: Boolean(element.required) || element.getAttribute('aria-required') === 'true',
      readOnly: Boolean(element.readOnly) || element.getAttribute('aria-readonly') === 'true',
      checked: typeof element.checked === 'boolean' ? element.checked : undefined,
      expanded: element.hasAttribute('aria-expanded')
        ? element.getAttribute('aria-expanded') === 'true'
        : undefined,
      selected: element.hasAttribute('aria-selected')
        ? element.getAttribute('aria-selected') === 'true'
        : undefined,
      href: tag === 'a' ? element.href || undefined : undefined,
      inViewport: candidate.inViewport,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      frameDepth: candidate.frameDepth,
      shadowDepth: candidate.shadowDepth,
      options,
      locator: locator(element),
    }
    if ('value' in element) {
      item.value = password ? '[sensitive]' : String(element.value || '').slice(0, 500)
    }
    return item
  })

  const rawText = collectedTextRoots
    .map(root => root.nodeType === 9
      ? String(root.body?.innerText || '')
      : String(root.textContent || ''))
    .filter(Boolean)
    .join('\n')
    .replace(/\\u0000/g, '')
    .trim()
  const searchMatches = []
  let searchMatchCount = 0
  if (limits.purpose === 'search') {
    const normalizedText = rawText.toLocaleLowerCase()
    let offset = 0
    while (offset < normalizedText.length && searchMatchCount < 10_000) {
      const found = normalizedText.indexOf(normalizedQuery, offset)
      if (found < 0) break
      searchMatchCount += 1
      if (searchMatches.length < limits.maxMatches) {
        const from = Math.max(0, found - 120)
        const to = Math.min(
          rawText.length,
          found + normalizedQuery.length + 180,
        )
        searchMatches.push({
          start: found,
          text: rawText.slice(from, to)
            .replace(/\\s+/g, ' ')
            .trim(),
        })
      }
      offset = found + Math.max(1, normalizedQuery.length)
    }
  }
  const viewportTextSource = collectedTextRoots.flatMap(root =>
    Array.from(root.querySelectorAll(
      'h1,h2,h3,h4,p,li,dt,dd,td,th,label,button,a'
    ))
  )
    .filter(element => visible(element) && inViewport(element))
    .map(element => String(element.innerText || element.textContent || '')
      .replace(/\\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .join('\\n')
  const viewportText = viewportTextSource.slice(
    0,
    limits.maxViewportTextCharacters,
  )
  const pageFingerprintElements = allCandidates.slice(0, 500)
    .map(candidate => {
      const element = candidate.element
      const tag = element.tagName.toLowerCase()
      const type = String(element.getAttribute('type') || '').toLowerCase()
      const password = tag === 'input' && type === 'password'
      return {
        locator: locator(element),
        tag,
        role: element.getAttribute('role') || undefined,
        name: label(element),
        context: semanticContext(element),
        type: type || undefined,
        placeholder: element.getAttribute('placeholder') || undefined,
        disabled: Boolean(element.disabled)
          || element.getAttribute('aria-disabled') === 'true',
        checked: typeof element.checked === 'boolean'
          ? element.checked
          : undefined,
        expanded: element.hasAttribute('aria-expanded')
          ? element.getAttribute('aria-expanded') === 'true'
          : undefined,
        selected: element.hasAttribute('aria-selected')
          ? element.getAttribute('aria-selected') === 'true'
          : undefined,
        href: tag === 'a' ? element.href || undefined : undefined,
        inViewport: candidate.inViewport,
        value: 'value' in element
          ? password ? '[sensitive]' : String(element.value || '').slice(0, 500)
          : undefined,
      }
    })
  const pageHeight = Math.max(
    document.body?.scrollHeight || 0,
    document.documentElement?.scrollHeight || 0,
  )
  const pixelsAbove = Math.max(0, window.scrollY)
  const pixelsBelow = Math.max(
    0,
    pageHeight - window.scrollY - window.innerHeight,
  )
  return {
    purpose: limits.purpose,
    trust: 'untrusted_external_data',
    source: 'browser_page',
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      pageHeight,
      pixelsAbove,
      pixelsBelow,
      pagesAbove: window.innerHeight > 0
        ? Number((pixelsAbove / window.innerHeight).toFixed(1))
        : 0,
      pagesBelow: window.innerHeight > 0
        ? Number((pixelsBelow / window.innerHeight).toFixed(1))
        : 0,
    },
    viewportText,
    _pageFingerprintText: viewportTextSource.slice(0, 8_000),
    _pageFingerprintElements: pageFingerprintElements,
    text: limits.purpose === 'read'
      ? rawText.slice(0, limits.maxTextCharacters)
      : undefined,
    textTruncated: limits.purpose === 'read'
      ? rawText.length > limits.maxTextCharacters
      : undefined,
    search: limits.purpose === 'search'
      ? {
          query: limits.searchQuery,
          matchCount: searchMatchCount,
          matches: searchMatches,
          matchesTruncated: searchMatchCount > searchMatches.length,
        }
      : undefined,
    frames: collectedFrames.slice(0, 50).map(frame => ({
      ...frame,
      bounds: {
        x: Math.round(frame.bounds.x),
        y: Math.round(frame.bounds.y),
        width: Math.round(frame.bounds.width),
        height: Math.round(frame.bounds.height),
      },
    })),
    frameCount: collectedFrames.length,
    crossOriginFrameCount: collectedFrames
      .filter(frame => !frame.sameOrigin).length,
    elements,
    pageElementCount: allCandidates.length,
    elementCount: candidates.length,
    viewportElementCount: candidates.filter(candidate => candidate.inViewport).length,
    elementsTruncated: candidates.length > limits.maxElements,
  }
})`

export async function observePage(session, limits = {}) {
  const normalizedLimits = normalizeLimits(limits)
  const previousObservation = session.lastObservation
  const previousLimits = session.lastObservationLimits
  const previousSelectors = new Set(
    [...session.elementLocators.values()].map(value => JSON.stringify(value)),
  )
  const state = await capturePageState(session, normalizedLimits)
  const elementSetComparable = observationElementSetIsComparable(
    previousObservation,
    state,
    previousLimits,
    normalizedLimits,
  )
  const comparablePreviousSelectors = elementSetComparable
    ? previousSelectors
    : new Set()
  const currentSelectors = new Set(
    (state.elements || []).map(element => JSON.stringify(element.locator)),
  )
  for (const element of state.elements || []) {
    element.new = Boolean(previousObservation)
      && elementSetComparable
      && !comparablePreviousSelectors.has(JSON.stringify(element.locator))
  }

  session.revision += 1
  session.lastUsedAt = new Date()
  session.lastObservationLimits = normalizedLimits
  session.lastActionFingerprint = actionFingerprint(state)
  session.elementLocators = new Map(
    (state.elements || []).map(item => [item.ref, item.locator]),
  )
  session.elements = new Map(
    (state.elements || []).map(item => [
      item.ref,
      {
        ref: item.ref,
        tag: item.tag,
        role: item.role,
        name: item.name,
        context: item.context,
        type: item.type,
        placeholder: item.placeholder,
        contentEditable: item.contentEditable,
        disabled: item.disabled,
        required: item.required,
        readOnly: item.readOnly,
        checked: item.checked,
        expanded: item.expanded,
        selected: item.selected,
        href: item.href,
        inViewport: item.inViewport,
        bounds: item.bounds,
        frameDepth: item.frameDepth,
        shadowDepth: item.shadowDepth,
        new: item.new,
        options: item.options,
      },
    ]),
  )
  const fingerprint = pageFingerprint(state)
  for (const element of state.elements || []) {
    delete element.locator
  }
  delete state._pageFingerprintText
  delete state._pageFingerprintElements
  const observedAt = new Date().toISOString()
  const digest = createHash('sha256')
    .update(JSON.stringify({
      pageId: session.pageId,
      revision: session.revision,
      observedAt,
      state,
    }))
    .digest('hex')
  const observation = {
    ref: `obs_${digest.slice(0, 32)}`,
    fingerprint,
    revision: session.revision,
    observedAt,
    previousObservationRef: previousObservation?.ref,
    change: observationChange(
      previousObservation,
      state,
      fingerprint,
      comparablePreviousSelectors,
      currentSelectors,
      elementSetComparable,
    ),
    ...state,
  }
  session.lastObservation = observation
  return observation
}

/** Captures wait/recovery facts without advancing the delivered revision. */
export async function probePage(session, limits = {}) {
  const state = await capturePageState(session, normalizeLimits(limits))
  const fingerprint = pageFingerprint(state)
  delete state._pageFingerprintText
  delete state._pageFingerprintElements
  for (const element of state.elements || []) {
    delete element.locator
  }
  return {
    ...state,
    fingerprint,
  }
}

function normalizeLimits(limits = {}) {
  const purpose = ['read', 'search'].includes(limits.purpose)
    ? limits.purpose
    : 'interact'
  const searchQuery = purpose === 'search'
    ? String(limits.searchQuery || '').trim()
    : ''
  if (purpose === 'search'
      && (searchQuery.length < 1 || searchQuery.length > 500)) {
    const error = new Error(
      'searchQuery must contain 1 to 500 characters for search observations',
    )
    error.code = 'invalid_browser_search_query'
    error.statusCode = 400
    throw error
  }
  const maxTextCharacters = bound(
    limits.maxTextCharacters,
    purpose === 'read' ? 24_000 : 8_000,
    1_000,
    80_000,
  )
  const maxElements = bound(
    limits.maxElements,
    purpose === 'read' ? 40 : purpose === 'search' ? 80 : 160,
    1,
    500,
  )
  const maxMatches = bound(limits.maxMatches, 20, 1, 50)
  return {
    purpose,
    searchQuery,
    maxTextCharacters,
    maxElements,
    maxMatches,
    maxViewportTextCharacters: Math.min(8_000, maxTextCharacters),
  }
}

export async function observationIsCurrent(session) {
  if (!session.lastObservation || !session.lastActionFingerprint) {
    return false
  }
  const limits = normalizeLimits(session.lastObservationLimits || {
    maxTextCharacters: 24_000,
    maxElements: 160,
    maxViewportTextCharacters: 8_000,
  })
  const state = await capturePageState(session, limits)
  return actionFingerprint(state) === session.lastActionFingerprint
}

async function capturePageState(session, limits) {
  const expression = `${OBSERVATION_SCRIPT}(${JSON.stringify(limits)})`
  const evaluation = await session.client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (evaluation.exceptionDetails) {
    throw new Error('Page observation script failed')
  }
  const state = evaluation.result?.value
  if (!state || typeof state !== 'object') {
    throw new Error('Page observation returned no state')
  }
  return state
}

function actionFingerprint(state) {
  return createHash('sha256')
    .update(JSON.stringify({
      url: state.url,
      viewport: state.viewport,
      elements: (state.elements || []).map(element => ({
        locator: element.locator,
        tag: element.tag,
        role: element.role,
        name: element.name,
        context: element.context,
        type: element.type,
        placeholder: element.placeholder,
        contentEditable: element.contentEditable,
        disabled: element.disabled,
        required: element.required,
        readOnly: element.readOnly,
        checked: element.checked,
        expanded: element.expanded,
        selected: element.selected,
        href: element.href,
        inViewport: element.inViewport,
        value: element.value,
        options: element.options,
      })),
    }))
    .digest('hex')
}

function pageFingerprint(state) {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      url: state.url,
      title: state.title,
      readyState: state.readyState,
      viewport: state.viewport,
      viewportText: state._pageFingerprintText || state.viewportText,
      frames: state.frames,
      elements: (state._pageFingerprintElements || []).map(element => ({
        locator: element.locator,
        tag: element.tag,
        role: element.role,
        name: element.name,
        context: element.context,
        type: element.type,
        placeholder: element.placeholder,
        disabled: element.disabled,
        checked: element.checked,
        expanded: element.expanded,
        selected: element.selected,
        href: element.href,
        inViewport: element.inViewport,
        value: element.value,
      })),
    }))
    .digest('hex')
  return `pg_${digest.slice(0, 32)}`
}

function observationChange(
  previous,
  state,
  fingerprint,
  previousSelectors,
  currentSelectors,
  elementSetComparable,
) {
  if (!previous) {
    return {
      stateChanged: true,
      initial: true,
      urlChanged: false,
      viewportChanged: false,
      elementSetComparable: false,
      newElementCount: 0,
      disappearedElementCount: 0,
    }
  }
  const newElementCount = [...currentSelectors]
    .filter(selector => !previousSelectors.has(selector)).length
  const disappearedElementCount = [...previousSelectors]
    .filter(selector => !currentSelectors.has(selector)).length
  return {
    stateChanged: previous.fingerprint !== fingerprint,
    initial: false,
    urlChanged: previous.url !== state.url,
    viewportChanged: JSON.stringify(previous.viewport)
      !== JSON.stringify(state.viewport),
    elementSetComparable,
    newElementCount,
    disappearedElementCount,
  }
}

function observationElementSetIsComparable(
  previous,
  state,
  previousLimits,
  currentLimits,
) {
  if (!previous || previous.purpose !== state.purpose) return false
  const previousQuery = previous.search?.query || ''
  const currentQuery = state.search?.query || ''
  return previousQuery === currentQuery
    && previousLimits?.maxElements === currentLimits.maxElements
}

function bound(value, fallback, minimum, maximum) {
  return Number.isInteger(value)
    ? Math.max(minimum, Math.min(value, maximum))
    : fallback
}

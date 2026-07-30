import { createHash } from 'node:crypto'

const OBSERVATION_SCRIPT = `(limits => {
  const visible = element => {
    const style = window.getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.visibility !== 'hidden'
      && style.display !== 'none'
      && rect.width > 0
      && rect.height > 0
  }

  const inViewport = element => {
    const rect = element.getBoundingClientRect()
    return rect.bottom > 0
      && rect.right > 0
      && rect.top < window.innerHeight
      && rect.left < window.innerWidth
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

  const allCandidates = Array.from(document.querySelectorAll(
    'a[href],button,input,textarea,select,[role="button"],[role="link"],'
    + '[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],'
    + '[role="menuitem"],[role="option"],[role="switch"],[role="slider"],'
    + 'summary,[contenteditable="true"],[tabindex],[onclick]'
  ))
    .filter(visible)
    .map((element, index) => ({
      element,
      index,
      inViewport: inViewport(element),
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
    const rect = element.getBoundingClientRect()
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
      options,
      selector: selector(element),
    }
    if ('value' in element) {
      item.value = password ? '[sensitive]' : String(element.value || '').slice(0, 500)
    }
    return item
  })

  const rawText = String(document.body?.innerText || '')
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
  const viewportText = Array.from(document.querySelectorAll(
    'h1,h2,h3,h4,p,li,dt,dd,td,th,label,button,a'
  ))
    .filter(element => visible(element) && inViewport(element))
    .map(element => String(element.innerText || element.textContent || '')
      .replace(/\\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index)
    .join('\\n')
    .slice(0, limits.maxViewportTextCharacters)
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
    elements,
    pageElementCount: allCandidates.length,
    elementCount: candidates.length,
    viewportElementCount: candidates.filter(candidate => candidate.inViewport).length,
    elementsTruncated: candidates.length > limits.maxElements,
  }
})`

export async function observePage(session, limits = {}) {
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
  const normalizedLimits = {
    purpose,
    searchQuery,
    maxTextCharacters,
    maxElements,
    maxMatches,
    maxViewportTextCharacters: Math.min(8_000, maxTextCharacters),
  }
  const hadPreviousObservation = Boolean(session.lastObservation)
  const previousSelectors = new Set(session.elementSelectors.values())
  const state = await capturePageState(session, normalizedLimits)
  for (const element of state.elements || []) {
    element.new = hadPreviousObservation
      && !previousSelectors.has(element.selector)
  }

  session.revision += 1
  session.lastUsedAt = new Date()
  session.lastObservationLimits = normalizedLimits
  session.lastActionFingerprint = actionFingerprint(state)
  session.elementSelectors = new Map(
    (state.elements || []).map(item => [item.ref, item.selector]),
  )
  session.elements = new Map(
    (state.elements || []).map(item => [
      item.ref,
      {
        ref: item.ref,
        tag: item.tag,
        role: item.role,
        name: item.name,
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
        new: item.new,
        options: item.options,
      },
    ]),
  )
  for (const element of state.elements || []) {
    delete element.selector
  }
  const observedAt = new Date().toISOString()
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(state))
    .digest('hex')
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
    fingerprint: `pg_${fingerprint.slice(0, 32)}`,
    revision: session.revision,
    observedAt,
    ...state,
  }
  session.lastObservation = observation
  return observation
}

export async function observationIsCurrent(session) {
  if (!session.lastObservation || !session.lastActionFingerprint) {
    return false
  }
  const limits = session.lastObservationLimits || {
    maxTextCharacters: 24_000,
    maxElements: 160,
    maxViewportTextCharacters: 8_000,
  }
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
        selector: element.selector,
        tag: element.tag,
        role: element.role,
        name: element.name,
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

function bound(value, fallback, minimum, maximum) {
  return Number.isInteger(value)
    ? Math.max(minimum, Math.min(value, maximum))
    : fallback
}

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

  const candidates = Array.from(document.querySelectorAll(
    'a[href],button,input,textarea,select,[role="button"],[role="link"],'
    + '[role="textbox"],[role="checkbox"],[role="radio"],[contenteditable="true"],[tabindex]'
  )).filter(visible)

  const elements = candidates.slice(0, limits.maxElements).map((element, index) => {
    const tag = element.tagName.toLowerCase()
    const type = String(element.getAttribute('type') || '').toLowerCase()
    const password = tag === 'input' && type === 'password'
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
      checked: typeof element.checked === 'boolean' ? element.checked : undefined,
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
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    text: rawText.slice(0, limits.maxTextCharacters),
    textTruncated: rawText.length > limits.maxTextCharacters,
    elements,
    elementCount: candidates.length,
    elementsTruncated: candidates.length > limits.maxElements,
  }
})`

export async function observePage(session, limits = {}) {
  const maxTextCharacters = bound(
    limits.maxTextCharacters,
    24_000,
    1_000,
    80_000,
  )
  const maxElements = bound(limits.maxElements, 160, 1, 500)
  const expression = `${OBSERVATION_SCRIPT}(${JSON.stringify({
    maxTextCharacters,
    maxElements,
  })})`
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

  session.revision += 1
  session.lastUsedAt = new Date()
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
        checked: item.checked,
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

function bound(value, fallback, minimum, maximum) {
  return Number.isInteger(value)
    ? Math.max(minimum, Math.min(value, maximum))
    : fallback
}

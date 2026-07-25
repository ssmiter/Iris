import type { Client } from 'chrome-remote-interface'
import type { ElementSelector, SelectorType } from './types/webbridge'

function selectorFromElement(el: Element): ElementSelector {
  let selector_type: SelectorType = 'css'
  let value = el.tagName.toLowerCase()

  if (el.id) {
    selector_type = 'id'
    value = el.id
  } else {
    const testId = el.getAttribute('data-testid')
    if (testId) {
      selector_type = 'css'
      value = `[data-testid="${testId.replace(/"/g, '\\"')}"]`
    } else {
      const name = (el as HTMLInputElement).name
      if (name) {
        selector_type = 'name'
        value = name
      } else {
        const ariaLabel = el.getAttribute('aria-label')
        if (ariaLabel) {
          selector_type = 'aria_label'
          value = ariaLabel
        } else if (el.className) {
          const classes = el.className.toString().trim().split(/\s+/).filter(Boolean).slice(0, 2)
          if (classes.length > 0) {
            selector_type = 'css'
            value = `${el.tagName.toLowerCase()}.${classes.join('.')}`
          }
        }
      }
    }
  }

  const text = el.textContent?.trim().slice(0, 80)
  return { selector_type, value, timeout_ms: 5000 }
}

export async function resolveSelectorAtPoint(
  client: Client,
  x: number,
  y: number
): Promise<ElementSelector | null> {
  const { Runtime } = client
  const script = `
    (function() {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        id: el.id,
        className: el.className,
        dataTestId: el.getAttribute('data-testid'),
        name: el.name,
        ariaLabel: el.getAttribute('aria-label'),
        text: (el.textContent || '').trim().slice(0, 80),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };
    })()
  `
  const result = await Runtime.evaluate({ expression: script, returnByValue: true })
  const data = result.result.value as {
    tag: string
    id?: string
    className?: string
    dataTestId?: string
    name?: string
    ariaLabel?: string
    text?: string
    rect: { x: number; y: number; width: number; height: number }
  } | null

  if (!data) return null

  let selector_type: SelectorType = 'css'
  let value = data.tag.toLowerCase()

  if (data.id) {
    selector_type = 'id'
    value = data.id
  } else if (data.dataTestId) {
    selector_type = 'css'
    value = `[data-testid="${data.dataTestId.replace(/"/g, '\\"')}"]`
  } else if (data.name) {
    selector_type = 'name'
    value = data.name
  } else if (data.ariaLabel) {
    selector_type = 'aria_label'
    value = data.ariaLabel
  } else if (data.className) {
    const classes = data.className.toString().trim().split(/\s+/).filter(Boolean).slice(0, 2)
    if (classes.length > 0) {
      selector_type = 'css'
      value = `${data.tag.toLowerCase()}.${classes.join('.')}`
    }
  }

  return {
    selector_type,
    value,
    timeout_ms: 5000,
  }
}

import type { Client } from 'chrome-remote-interface'
import type { BrowserAction, RecordedEvent, ElementSelector, SelectorType } from './types/webbridge'

interface RecorderCallbacks {
  onAction: (action: BrowserAction) => void
}

let isRecording = false
let recordingClient: Client | null = null
let bindingName = '__webbridge_record_event__'
let navigationHandler: ((params: { frameId: string; url: string }) => void) | null = null

function generateSelector(el: Element): { selector_type: SelectorType; value: string } | null {
  if (el.id) return { selector_type: 'id', value: el.id }
  const dataTestId = el.getAttribute('data-testid')
  if (dataTestId) return { selector_type: 'css', value: `[data-testid="${dataTestId}"]` }
  const name = (el as HTMLInputElement).name
  if (name) return { selector_type: 'name', value: name }
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) return { selector_type: 'aria_label', value: ariaLabel }
  if (el.className) {
    const classes = el.className.toString().trim().split(/\s+/).slice(0, 2)
    if (classes.length > 0) {
      return { selector_type: 'css', value: `${el.tagName.toLowerCase()}.${classes.join('.')}` }
    }
  }
  const text = el.textContent?.trim().slice(0, 80)
  if (text) return { selector_type: 'text_exact', value: text }
  return { selector_type: 'css', value: el.tagName.toLowerCase() }
}

function selectorFromElement(el: Element): ElementSelector | undefined {
  const sel = generateSelector(el)
  if (!sel) return undefined
  return { selector_type: sel.selector_type, value: sel.value }
}

async function injectRecorderScript(client: Client): Promise<void> {
  const { Runtime } = client
  ;(Runtime as unknown as { addBinding: (params: { name: string }) => Promise<unknown> }).addBinding({ name: bindingName })

  const script = `
    (function() {
      if (window.__webbridge_recorder_installed__) return;
      window.__webbridge_recorder_installed__ = true;

      function getSelector(el) {
        if (!el) return null;
        if (el.id) return { selector_type: 'id', value: el.id };
        const testId = el.getAttribute('data-testid');
        if (testId) return { selector_type: 'css', value: '[data-testid="' + testId.replace(/"/g, '\\"') + '"]' };
        const name = el.name;
        if (name) return { selector_type: 'name', value: name };
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return { selector_type: 'aria_label', value: ariaLabel };
        if (el.className) {
          const classes = el.className.toString().trim().split(/\\s+/).slice(0, 2);
          if (classes.length > 0) {
            return { selector_type: 'css', value: el.tagName.toLowerCase() + '.' + classes.join('.') };
          }
        }
        const text = (el.textContent || '').trim().slice(0, 80);
        if (text) return { selector_type: 'text_exact', value: text };
        return { selector_type: 'css', value: el.tagName.toLowerCase() };
      }

      function sendEvent(action_type, payload) {
        window.${bindingName}(JSON.stringify({ action_type, ...payload, timestamp: Date.now(), url: window.location.href }));
      }

      document.addEventListener('click', function(e) {
        const sel = getSelector(e.target);
        if (!sel) return;
        sendEvent('click', { selector: sel, description: '点击 ' + (e.target.textContent || '').trim().slice(0, 30) });
      }, true);

      document.addEventListener('input', function(e) {
        const target = e.target;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
          const sel = getSelector(target);
          sendEvent('type', { selector: sel, value: target.value || target.textContent || '', description: '输入 ' + (target.placeholder || target.name || '') });
        }
      }, true);

      document.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          const sel = getSelector(e.target);
          sendEvent('type', { selector: sel, value: (e.target.value || '') + '\\n', description: '按回车提交' });
        }
      }, true);

      let lastUrl = window.location.href;
      new MutationObserver(function() {
        const currentUrl = window.location.href;
        if (currentUrl !== lastUrl) {
          lastUrl = currentUrl;
          sendEvent('navigate', { value: currentUrl, description: '导航到 ' + currentUrl });
        }
      }).observe(document, { subtree: true, childList: true });
    })();
  `

  await Runtime.evaluate({ expression: script })
}

export async function startRecording(client: Client, callbacks: RecorderCallbacks): Promise<void> {
  if (isRecording) return
  isRecording = true
  recordingClient = client

  await injectRecorderScript(client)

  const { Runtime, Page } = client
  const runtime = Runtime as unknown as {
    on: (event: string, handler: (params: { name: string; payload: string }) => void) => void
  }
  const page = Page as unknown as {
    on: (event: string, handler: (params: { frameId: string; url: string }) => void) => void
    off: (event: string, handler: (params: { frameId: string; url: string }) => void) => void
  }

  runtime.on('bindingCalled', (params) => {
    if (!isRecording || params.name !== bindingName) return
    try {
      const event = JSON.parse(params.payload) as RecordedEvent
      const action: BrowserAction = {
        action_type: event.action_type,
        selector: event.selector,
        value: event.value,
        coordinates: event.coordinates,
        description: event.description,
      }
      callbacks.onAction(action)
    } catch {
      // ignore malformed events
    }
  })

  navigationHandler = (params: { frameId: string; url: string }) => {
    if (!isRecording) return
    callbacks.onAction({
      action_type: 'navigate',
      value: params.url,
      description: `导航到 ${params.url}`,
    })
  }
  page.on('frameNavigated', navigationHandler)
}

export function stopRecording(): void {
  isRecording = false
  if (recordingClient && navigationHandler) {
    try {
      const page = recordingClient.Page as unknown as {
        off: (event: string, handler: (params: { frameId: string; url: string }) => void) => void
      }
      page.off('frameNavigated', navigationHandler)
    } catch {
      // ignore
    }
  }
  recordingClient = null
  navigationHandler = null
}

export function isCurrentlyRecording(): boolean {
  return isRecording
}

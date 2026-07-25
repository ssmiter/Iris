declare module 'chrome-remote-interface' {
  interface RuntimeEvaluateResult {
    result: {
      value?: unknown
      type?: string
      description?: string
    }
    exceptionDetails?: unknown
  }

  interface PageNavigateResult {
    frameId: string
    loaderId?: string
    errorText?: string
  }

  interface LayoutMetrics {
    visualViewport: {
      clientWidth: number
      clientHeight: number
      pageX: number
      pageY: number
    }
    contentSize: {
      height: number
      width: number
    }
  }

  interface BoxModel {
    content: number[]
  }

  interface DOMDomain {
    enable(): Promise<void>
    getDocument(): Promise<{ root: { nodeId: number } }>
    querySelector(params: { nodeId: number; selector: string }): Promise<{ nodeId: number }>
    focus(params: { nodeId: number }): Promise<void>
    getBoxModel(params: { nodeId: number }): Promise<{ model: BoxModel }>
  }

  interface RuntimeDomain {
    enable(): Promise<void>
    evaluate(params: { expression: string; returnByValue?: boolean }): Promise<RuntimeEvaluateResult>
  }

  interface PageDomain {
    enable(): Promise<void>
    navigate(params: { url: string }): Promise<PageNavigateResult>
    reload(params?: { ignoreCache?: boolean }): Promise<void>
    loadEventFired(): Promise<void>
    captureScreenshot(params?: { format?: 'png' | 'jpeg' }): Promise<{ data: string }>
    getLayoutMetrics(): Promise<LayoutMetrics>
  }

  interface InputDomain {
    dispatchMouseEvent(params: {
      type: string
      x: number
      y: number
      button?: string
      clickCount?: number
    }): Promise<void>
    dispatchKeyEvent(params: {
      type: string
      key: string
      modifiers?: number
    }): Promise<void>
    insertText(params: { text: string }): Promise<void>
  }

  export interface Client {
    DOM: DOMDomain
    Runtime: RuntimeDomain
    Page: PageDomain
    Input: InputDomain
    close(): Promise<void>
    on(event: string, handler: () => void): void
  }

  interface CDPOptions {
    port?: number
    host?: string
  }

  function CDP(options?: CDPOptions): Promise<Client>
  export default CDP
}

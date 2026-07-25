import type { StatusInfo } from './webbridgeClient'

export interface DaemonStatus {
  running: boolean
  info?: StatusInfo
  error?: string
}

export interface DaemonLauncherOptions {
  host?: string
  port?: number
  daemonPath?: string
  nodePath?: string
  cwd?: string
  env?: Record<string, string>
}

export interface NativeProcessAPI {
  spawn: (
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ) => Promise<{ success: boolean; pid?: number; error?: string }>
  kill?: (pid: number) => Promise<{ success: boolean; error?: string }>
}

export interface DaemonLauncher {
  checkStatus(host: string, port: number): Promise<DaemonStatus>
  start(options?: DaemonLauncherOptions): Promise<{ success: boolean; pid?: number; error?: string }>
  stop(options?: DaemonLauncherOptions): Promise<{ success: boolean; error?: string }>
  canAutoStart(): boolean
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class BrowserDaemonLauncher implements DaemonLauncher {
  async checkStatus(host: string, port: number): Promise<DaemonStatus> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      const response = await fetch(`http://${host}:${port}/status`, {
        method: 'GET',
        credentials: 'omit',
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (!response.ok) {
        return { running: false, error: `HTTP ${response.status}` }
      }
      const info = (await response.json()) as StatusInfo
      return { running: true, info }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (message.includes('aborted') || message.includes('AbortError')) {
        return { running: false, error: 'Connection timed out' }
      }
      return { running: false, error: message }
    }
  }

  canAutoStart(): boolean {
    return false
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    return {
      success: false,
      error:
        '当前环境不支持自动启动守护进程。请手动运行：cd daemon && npm run build && node dist/index.js，或执行 npm run build:webbridge:exe 后运行 dist/webbridge-daemon.exe。',
    }
  }

  async stop(): Promise<{ success: boolean; error?: string }> {
    return {
      success: false,
      error: '当前环境不支持自动停止守护进程。',
    }
  }
}

export class NativeDaemonLauncher implements DaemonLauncher {
  private api: NativeProcessAPI

  constructor(api: NativeProcessAPI) {
    this.api = api
  }

  async checkStatus(host: string, port: number): Promise<DaemonStatus> {
    return new BrowserDaemonLauncher().checkStatus(host, port)
  }

  canAutoStart(): boolean {
    return true
  }

  async start(options: DaemonLauncherOptions = {}): Promise<{ success: boolean; pid?: number; error?: string }> {
    const { host = 'localhost', port = 9223, daemonPath, nodePath = 'node', cwd, env = {} } = options
    const commandEnv = {
      WEBBRIDGE_PORT: String(port),
      WEBBRIDGE_HEADLESS: 'false',
      ...env,
    }

    const candidates: Array<{ command: string; args: string[] }> = []
    if (daemonPath) {
      if (daemonPath.endsWith('.js')) {
        candidates.push({ command: nodePath, args: [daemonPath] })
      } else {
        candidates.push({ command: daemonPath, args: [] })
      }
    }
    const base = cwd || '.'
    candidates.push(
      { command: `${base}/dist/webbridge-daemon.exe`, args: [] },
      { command: nodePath, args: [`${base}/dist/index.js`] }
    )

    let lastError = '未配置任何守护进程启动路径'
    for (const candidate of candidates) {
      try {
        const result = await this.api.spawn(candidate.command, candidate.args, {
          cwd,
          env: commandEnv,
        })
        if (result.success) {
          // Wait briefly for daemon HTTP endpoint to come up
          for (let i = 0; i < 10; i++) {
            await wait(300)
            const status = await this.checkStatus(host, port)
            if (status.running) {
              return { success: true, pid: result.pid }
            }
          }
          lastError = '进程已启动但守护进程状态检测未通过'
          continue
        }
        lastError = result.error || `启动失败: ${candidate.command}`
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }

    return { success: false, error: lastError }
  }

  async stop(options: DaemonLauncherOptions = {}): Promise<{ success: boolean; error?: string }> {
    if (!this.api.kill) {
      return { success: false, error: '当前原生 API 未提供进程终止能力' }
    }
    // Native launcher consumers should store the pid returned by start()
    // and call stop with it in options.env or a separate tracker.
    const pid = options.env?.WEBBRIDGE_PID
      ? parseInt(options.env.WEBBRIDGE_PID, 10)
      : undefined
    if (!pid || Number.isNaN(pid)) {
      return { success: false, error: '缺少进程 PID，无法停止守护进程' }
    }
    return this.api.kill(pid)
  }
}

let sharedLauncher: DaemonLauncher | null = null

export function getDaemonLauncher(): DaemonLauncher {
  if (!sharedLauncher) {
    sharedLauncher = new BrowserDaemonLauncher()
  }
  return sharedLauncher
}

export function setDaemonLauncher(launcher: DaemonLauncher): void {
  sharedLauncher = launcher
}

export function createNativeLauncher(api: NativeProcessAPI): DaemonLauncher {
  return new NativeDaemonLauncher(api)
}

/**
 * 尝试从全局环境自动注入原生启动器（如 Tauri/Electron 暴露的 API）。
 * 浏览器环境中无原生 API，保持默认 BrowserDaemonLauncher。
 */
export function detectAndInjectNativeLauncher(): void {
  if (typeof window === 'undefined') return
  const w = window as unknown as Record<string, unknown>
  if (w.__TAURI__ || w.electronAPI) {
    // Consumers can call setDaemonLauncher(createNativeLauncher(w.electronAPI as NativeProcessAPI))
    // once they have a concrete NativeProcessAPI implementation.
  }
}

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { getAuthHeaders, toolApi } from '@/api/client'
import { buildMcpAppSandbox, validateMcpAppResource, wrapMcpAppHtml, type McpAppResource } from './mcpAppPolicy'

interface McpAppMessage {
  jsonrpc: '2.0'
  id: string | number
  method: 'tools/call'
  params?: { name?: string; arguments?: Record<string, unknown> }
}

export function McpAppHost({
  serverName,
  resourceUri,
  allowedTools,
  fallback,
}: {
  serverName: string
  resourceUri: string
  allowedTools: string[]
  fallback?: ReactNode
}) {
  const [resource, setResource] = useState<McpAppResource>()
  const [error, setError] = useState<string>()
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const timer = setTimeout(() => controller.abort(), 15_000)
    setError(undefined)
    void fetch(`/api/mcp/apps/${encodeURIComponent(serverName)}/resource?uri=${encodeURIComponent(resourceUri)}`, {
      headers: getAuthHeaders(), credentials: 'include', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(`MCP App资源不可用（${response.status}）。`)
      const candidate = await response.json() as McpAppResource
      const validation = validateMcpAppResource(candidate)
      if (!validation.valid) throw new Error(validation.reasons.join('；'))
      if (active) setResource(candidate)
    }).catch(reason => {
      if (active && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    })
      .finally(() => clearTimeout(timer))
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [resourceUri, serverName])

  useEffect(() => {
    const onMessage = async (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow) return
      const message = event.data as Partial<McpAppMessage> | null
      if (!message || message.jsonrpc !== '2.0' || message.method !== 'tools/call' || message.id === undefined) return
      const requested = message.params?.name?.trim() ?? ''
      const normalized = requested.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()
      const wireName = allowedTools.find(name => name === requested || name.endsWith(`__${normalized}`))
      if (!wireName) {
        frameRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: '该页面无权调用此工具。' } }, '*')
        return
      }
      try {
        const result = await toolApi.execute({
          toolName: wireName,
          arguments: JSON.stringify(message.params?.arguments ?? {}),
          userMessage: `MCP App ${resourceUri} 请求只读加载`,
          toolUseId: `mcp-app-${Date.now()}`,
        })
        if (!result.success) throw new Error(result.error || '工具调用失败')
        frameRef.current?.contentWindow?.postMessage({
          jsonrpc: '2.0', id: message.id,
          result: { content: result.data ? [{ type: 'text', text: result.data }] : [], structuredContent: result.structuredData },
        }, '*')
      } catch (reason) {
        frameRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: reason instanceof Error ? reason.message : String(reason) } }, '*')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [allowedTools, resourceUri])

  if (error) return <div className="flex h-full flex-col"><div className="flex items-center gap-2 border-b p-3 text-sm text-amber-700"><AlertTriangle size={15} />应用加载失败：{error}</div>{fallback}</div>
  if (!resource) return <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--wf-mut)]"><Loader2 size={18} className="animate-spin" />正在安全加载应用…</div>
  const policy = buildMcpAppSandbox()
  return <iframe ref={frameRef} title="MCP 应用" className="h-full w-full border-0 bg-white" sandbox={policy.sandbox} referrerPolicy={policy.referrerPolicy} allow={policy.allow} srcDoc={wrapMcpAppHtml(resource)} />
}

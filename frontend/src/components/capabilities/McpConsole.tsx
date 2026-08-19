import { useEffect, useState, type ComponentProps, type FormEvent } from 'react'
import { ChevronDown, ChevronRight, Plus, RefreshCw } from 'lucide-react'
import {
  capabilityManagementApi,
  type McpServerDraft,
  type McpServerView,
  type McpToolView,
} from '@/api/irisApi'
import { Badge, Button, Input, notify } from '@/components/ui'
import { cn } from '@/lib/cn'
import { EditorHeading, EnableSwitch, QuietState } from './controls'

const emptyMcp: McpServerDraft = {
  slug: '',
  displayName: '',
  transport: 'streamable_http',
  endpoint: '',
  authorizationEnv: '',
  command: '',
  args: [],
  env: [],
  enabled: true,
}

/**
 * MCP 连接器控制台（DB 真相）：统一能力页的子视图，从 MCP 工具详情
 * 或页头入口进入（docs/32 §1——远端工具在树上，连接器在这里管）。
 */
export function McpConsole({
  focusServerId,
  onBack,
}: {
  focusServerId?: string | null
  onBack: () => void
}) {
  const [servers, setServers] = useState<McpServerView[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<McpServerView | undefined | null>(null)
  const [expandedServer, setExpandedServer] = useState<string | null>(null)
  const [serverTools, setServerTools] = useState<Record<string, McpToolView[]>>({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    capabilityManagementApi
      .listMcpServers()
      .then((next) => {
        if (cancelled) return
        setServers(next)
        if (focusServerId && next.some((s) => s.serverId === focusServerId)) {
          setExpandedServer(focusServerId)
        }
      })
      .catch((error: Error) =>
        notify.error('MCP 连接暂时不可用', { description: error.message }),
      )
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [focusServerId])

  useEffect(() => {
    if (!expandedServer || serverTools[expandedServer]) return
    const server = servers.find((item) => item.serverId === expandedServer)
    if (!server || server.toolCount === 0) return
    capabilityManagementApi
      .listMcpTools(expandedServer)
      .then((tools) =>
        setServerTools((current) => ({ ...current, [expandedServer]: tools })),
      )
      .catch((error: Error) =>
        notify.error('没有读到 MCP 工具清单', { description: error.message }),
      )
  }, [expandedServer, servers, serverTools])

  const toggleServer = async (server: McpServerView) => {
    setBusyId(server.serverId)
    setServers((items) =>
      items.map((item) =>
        item.serverId === server.serverId
          ? {
              ...item,
              enabled: !server.enabled,
              connectionState: server.enabled ? 'disabled' : 'connecting',
            }
          : item,
      ),
    )
    try {
      const updated = await capabilityManagementApi.setMcpServerEnabled(
        server,
        !server.enabled,
      )
      setServers((items) => replaceBy(items, updated))
      if (!updated.enabled) {
        setExpandedServer((id) => (id === server.serverId ? null : id))
      }
    } catch (error) {
      setServers((items) => replaceBy(items, server))
      notify.error('没有改变 MCP 状态', {
        description: (error as Error).message,
      })
    } finally {
      setBusyId(null)
    }
  }

  const refreshServer = async (server: McpServerView) => {
    setBusyId(server.serverId)
    try {
      const updated = await capabilityManagementApi.refreshMcpServer(
        server.serverId,
      )
      setServers((items) => replaceBy(items, updated))
      setServerTools((items) => {
        const next = { ...items }
        delete next[server.serverId]
        return next
      })
    } catch (error) {
      notify.error('MCP 重新连接失败', {
        description: (error as Error).message,
      })
    } finally {
      setBusyId(null)
    }
  }

  if (editing !== null) {
    return (
      <McpEditor
        current={editing}
        onCancel={() => setEditing(null)}
        onSaved={(server) => {
          setServers((items) =>
            items.some((item) => item.serverId === server.serverId)
              ? replaceBy(items, server)
              : [...items, server],
          )
          setEditing(null)
        }}
      />
    )
  }

  return (
    <section className="grid gap-3">
      <EditorHeading title="MCP 连接" onCancel={onBack} backLabel="返回能力树" />
      <div className="flex items-start justify-between gap-5 px-1">
        <p className="text-small leading-relaxed text-ink-muted">
          Iris 保存连接方式与凭据环境变量名；连通后远端工具进入同一审批和执行链路，并出现在能力树上。支持 Streamable HTTP 与 stdio 本地进程。
        </p>
        <Button variant="secondary" size="sm" onClick={() => setEditing(undefined)}>
          <Plus className="h-3.5 w-3.5" />
          添加 MCP
        </Button>
      </div>
      {loading ? (
        <QuietState>正在读取 MCP 连接…</QuietState>
      ) : servers.length === 0 ? (
        <QuietState>还没有 MCP 连接。支持 Streamable HTTP 与 stdio 本地进程。</QuietState>
      ) : (
        servers.map((server) => {
          const expanded = expandedServer === server.serverId
          return (
            <article key={server.serverId} className="rounded-md px-3 py-3 hover:bg-surface-muted">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4">
                <button
                  type="button"
                  className="min-w-0 text-left"
                  onClick={() => setExpandedServer(expanded ? null : server.serverId)}
                >
                  <div className="flex items-center gap-2">
                    {expanded ? (
                      <ChevronDown className="h-3.5 w-3.5 text-ink-muted" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-ink-muted" />
                    )}
                    <span className="truncate text-body font-semibold text-ink">
                      {server.displayName}
                    </span>
                    <ConnectionBadge state={server.connectionState} />
                  </div>
                  <p className="ml-[1.375rem] mt-1 truncate text-small text-ink-muted">
                    {server.toolCount} 个工具 · {server.transport === 'stdio' ? server.command ?? 'stdio' : server.endpoint}
                  </p>
                </button>
                <div className="flex items-center gap-1">
                  {server.enabled && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={`重新连接 ${server.displayName}`}
                      disabled={busyId === server.serverId}
                      onClick={() => void refreshServer(server)}
                    >
                      <RefreshCw className={cn('h-3.5 w-3.5', busyId === server.serverId && 'animate-spin')} />
                    </Button>
                  )}
                  <EnableSwitch
                    checked={server.enabled}
                    disabled={busyId === server.serverId}
                    label={`${server.enabled ? '停用' : '启用'} ${server.displayName}`}
                    onClick={() => void toggleServer(server)}
                  />
                </div>
              </div>
              {expanded && (
                <div className="ml-[1.375rem] mt-3 border-l border-border pl-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-small text-ink-subtle">
                      {server.lastError ?? server.instructions ?? '连接没有提供额外说明。'}
                    </p>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(server)}>
                      编辑连接
                    </Button>
                  </div>
                  <div className="grid gap-2">
                    {(serverTools[server.serverId] ?? []).map((tool) => (
                      <div key={tool.localName} className="grid gap-0.5">
                        <div className="flex items-center gap-2 text-small font-semibold text-ink">
                          {tool.remoteName}
                          <Badge appearance="outline">{tool.riskLevel}</Badge>
                        </div>
                        <p className="line-clamp-2 text-small text-ink-muted">
                          {tool.description}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </article>
          )
        })
      )}
    </section>
  )
}

function McpEditor({
  current,
  onCancel,
  onSaved,
}: {
  current?: McpServerView
  onCancel: () => void
  onSaved: (server: McpServerView) => void
}) {
  const [draft, setDraft] = useState<McpServerDraft>(
    current
      ? {
          slug: current.slug,
          displayName: current.displayName,
          transport: current.transport === 'stdio' ? 'stdio' : 'streamable_http',
          endpoint: current.endpoint,
          authorizationEnv: current.authorizationEnv ?? '',
          command: current.command ?? '',
          args: current.args ?? [],
          env: current.env ?? [],
          enabled: current.enabled,
        }
      : emptyMcp,
  )
  const [saving, setSaving] = useState(false)

  const setTransport = (transport: McpServerDraft['transport']) => {
    setDraft((prev) => ({ ...prev, transport }))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const saved = current
        ? await capabilityManagementApi.updateMcpServer(current, draft)
        : await capabilityManagementApi.createMcpServer(draft)
      onSaved(saved)
    } catch (error) {
      notify.error('MCP 连接没有保存', { description: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <EditorHeading title={current ? '编辑 MCP 连接' : '添加 MCP 连接'} onCancel={onCancel} backLabel="返回连接" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="连接标识" required value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} placeholder="office_tools" />
        <Input label="显示名称" required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} placeholder="Office 工具" />
      </div>
      <div className="grid gap-2">
        <label className="text-small font-semibold text-ink">传输方式</label>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-body text-ink">
            <input
              type="radio"
              name="transport"
              value="streamable_http"
              checked={draft.transport === 'streamable_http'}
              onChange={() => setTransport('streamable_http')}
              className="h-4 w-4 accent-focus"
            />
            Streamable HTTP
          </label>
          <label className="flex items-center gap-2 text-body text-ink">
            <input
              type="radio"
              name="transport"
              value="stdio"
              checked={draft.transport === 'stdio'}
              onChange={() => setTransport('stdio')}
              className="h-4 w-4 accent-focus"
            />
            stdio（本地进程）
          </label>
        </div>
      </div>
      {draft.transport === 'streamable_http' ? (
        <>
          <Input label="Streamable HTTP 地址" required type="url" value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} placeholder="http://127.0.0.1:3000/mcp" />
          <Input label="Bearer Token 环境变量" value={draft.authorizationEnv} onChange={(event) => setDraft({ ...draft, authorizationEnv: event.target.value })} placeholder="OFFICE_MCP_TOKEN" description="这里只保存环境变量名，Token 本身不会进入 Iris 数据库或前端。" />
        </>
      ) : (
        <>
          <Input label="命令（可执行文件）" required value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" />
          <TextLinesField
            label="参数（每行一个）"
            value={draft.args}
            onChange={(args) => setDraft({ ...draft, args })}
            placeholder={`-y\n@modelcontextprotocol/server-filesystem\nC:\\\\Users\\\\...`}
          />
          <TextLinesField
            label="环境变量名（每行一个，值从本机环境读取）"
            value={draft.env}
            onChange={(env) => setDraft({ ...draft, env })}
            placeholder="FILESYSTEM_MCP_API_KEY"
            description="只保存变量名，值不会进入 Iris 数据库或前端。"
          />
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>取消</Button>
        <Button type="submit" isLoading={saving} loadingLabel="正在连接">保存并检查连接</Button>
      </div>
    </form>
  )
}

function TextLinesField({
  label,
  value,
  onChange,
  placeholder,
  description,
}: {
  label: string
  value?: string[]
  onChange: (lines: string[]) => void
  placeholder?: string
  description?: string
}) {
  const text = (value ?? []).join('\n')
  return (
    <label className="grid gap-1.5">
      <span className="text-small font-semibold text-ink">{label}</span>
      <textarea
        value={text}
        onChange={(event) =>
          onChange(
            event.target.value
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0),
          )
        }
        placeholder={placeholder}
        rows={3}
        className={cn(
          'min-h-[5rem] w-full rounded-sm border border-border bg-surface-raised px-3.5 py-2',
          'text-body text-ink placeholder:text-ink-muted',
          'shadow-hairline outline-none',
          'transition-[border-color,background-color,box-shadow] duration-fast ease-standard',
          'hover:border-border-strong',
          'focus-visible:border-focus focus-visible:shadow-focus',
          'motion-reduce:transition-none',
        )}
      />
      {description && <p className="text-small text-ink-muted">{description}</p>}
    </label>
  )
}

function ConnectionBadge({ state }: { state: McpServerView['connectionState'] }) {
  const view = {
    connected: ['success', '已连接'],
    connecting: ['info', '连接中'],
    pending: ['info', '等待连接'],
    needs_auth: ['warning', '需要凭据'],
    failed: ['danger', '连接失败'],
    disabled: ['neutral', '已停用'],
  }[state] as [ComponentProps<typeof Badge>['tone'], string]
  return <Badge tone={view[0]} showDot>{view[1]}</Badge>
}

function replaceBy(items: McpServerView[], value: McpServerView) {
  return items.map((item) => (item.serverId === value.serverId ? value : item))
}

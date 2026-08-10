import {
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  BookOpen,
  Brain,
  ChevronDown,
  ChevronRight,
  Plug,
  Plus,
  RefreshCw,
  Settings2,
} from 'lucide-react'
import {
  capabilityManagementApi,
  type McpServerDraft,
  type McpServerView,
  type McpToolView,
  type MemoryDraft,
  type MemorySummary,
  type MemoryView,
  type SkillDraft,
  type SkillView,
} from '@/api/irisApi'
import { Badge, Button, Input, Modal, notify } from '@/components/ui'
import { cn } from '@/lib/cn'

type Section = 'skills' | 'mcp' | 'memory'
type Editor =
  | { kind: 'skill'; current?: SkillView }
  | { kind: 'mcp'; current?: McpServerView }
  | { kind: 'memory'; current?: MemoryView }
  | null

const emptySkill: SkillDraft = {
  name: '',
  title: '',
  capabilityPath: '',
  description: '',
  whenToUse: '',
  instructions: '',
  dependencies: [],
  enabled: true,
}

const emptyMcp: McpServerDraft = {
  slug: '',
  displayName: '',
  endpoint: '',
  authorizationEnv: '',
  enabled: true,
}

const emptyMemory: MemoryDraft = {
  title: '',
  content: '',
  scope: 'personal',
  sourceKind: 'user_stated',
  sourceRef: '',
  confidence: 1,
  enabled: true,
}

export function CapabilityCenter() {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<Section>('skills')
  const [skills, setSkills] = useState<SkillView[]>([])
  const [servers, setServers] = useState<McpServerView[]>([])
  const [memories, setMemories] = useState<MemorySummary[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor>(null)
  const [expandedServer, setExpandedServer] = useState<string | null>(null)
  const [serverTools, setServerTools] = useState<Record<string, McpToolView[]>>({})

  const reload = async () => {
    setLoading(true)
    try {
      const [nextSkills, nextServers, nextMemories] = await Promise.all([
        capabilityManagementApi.listSkills(),
        capabilityManagementApi.listMcpServers(),
        capabilityManagementApi.listMemories(),
      ])
      setSkills(nextSkills)
      setServers(nextServers)
      setMemories(nextMemories)
    } catch (error) {
      notify.error('能力管理暂时不可用', {
        description: (error as Error).message,
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void reload()
  }, [open])

  const enabledCount = useMemo(
    () => skills.filter((skill) => skill.enabled).length,
    [skills],
  )

  const toggleSkill = async (skill: SkillView) => {
    setBusyId(skill.skillId)
    setSkills((items) =>
      items.map((item) =>
        item.skillId === skill.skillId
          ? { ...item, enabled: !skill.enabled }
          : item,
      ),
    )
    try {
      const updated = await capabilityManagementApi.setSkillEnabled(
        skill,
        !skill.enabled,
      )
      setSkills((items) => replaceBy(items, updated, 'skillId'))
    } catch (error) {
      setSkills((items) => replaceBy(items, skill, 'skillId'))
      notify.error('没有改变 Skill 状态', {
        description: (error as Error).message,
      })
    } finally {
      setBusyId(null)
    }
  }

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
      setServers((items) => replaceBy(items, updated, 'serverId'))
      if (!updated.enabled) {
        setExpandedServer((id) => (id === server.serverId ? null : id))
      }
    } catch (error) {
      setServers((items) => replaceBy(items, server, 'serverId'))
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
      setServers((items) => replaceBy(items, updated, 'serverId'))
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

  const toggleMemory = async (memory: MemorySummary) => {
    setBusyId(memory.memoryId)
    setMemories((items) =>
      items.map((item) =>
        item.memoryId === memory.memoryId
          ? { ...item, enabled: !memory.enabled }
          : item,
      ),
    )
    try {
      const updated = await capabilityManagementApi.setMemoryEnabled(
        memory,
        !memory.enabled,
      )
      setMemories((items) =>
        replaceBy(items, memorySummary(updated), 'memoryId'),
      )
    } catch (error) {
      setMemories((items) => replaceBy(items, memory, 'memoryId'))
      notify.error('没有改变记忆状态', {
        description: (error as Error).message,
      })
    } finally {
      setBusyId(null)
    }
  }

  const editMemory = async (memory: MemorySummary) => {
    setBusyId(memory.memoryId)
    try {
      setEditor({
        kind: 'memory',
        current: await capabilityManagementApi.readMemory(memory.memoryId),
      })
    } catch (error) {
      notify.error('没有读到记忆正文', {
        description: (error as Error).message,
      })
    } finally {
      setBusyId(null)
    }
  }

  const toggleServerDetail = async (server: McpServerView) => {
    if (expandedServer === server.serverId) {
      setExpandedServer(null)
      return
    }
    setExpandedServer(server.serverId)
    if (!serverTools[server.serverId] && server.toolCount > 0) {
      try {
        const tools = await capabilityManagementApi.listMcpTools(server.serverId)
        setServerTools((current) => ({
          ...current,
          [server.serverId]: tools,
        }))
      } catch (error) {
        notify.error('没有读到 MCP 工具清单', {
          description: (error as Error).message,
        })
      }
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setEditor(null)
      }}
      size="lg"
      title="能力"
      description="管理 Agent 可以按需发现的工艺与外部连接；关闭后立即退出当前能力目录。"
      trigger={
        <Button variant="ghost" size="icon" aria-label="管理能力">
          <Settings2 aria-hidden="true" className="h-4 w-4" />
        </Button>
      }
    >
      {editor?.kind === 'skill' ? (
        <SkillEditor
          current={editor.current}
          onCancel={() => setEditor(null)}
          onSaved={(skill) => {
            setSkills((items) => replaceOrAdd(items, skill, 'skillId'))
            setEditor(null)
          }}
        />
      ) : editor?.kind === 'mcp' ? (
        <McpEditor
          current={editor.current}
          onCancel={() => setEditor(null)}
          onSaved={(server) => {
            setServers((items) => replaceOrAdd(items, server, 'serverId'))
            setEditor(null)
          }}
        />
      ) : editor?.kind === 'memory' ? (
        <MemoryEditor
          current={editor.current}
          onCancel={() => setEditor(null)}
          onSaved={(memory) => {
            setMemories((items) =>
              replaceOrAdd(items, memorySummary(memory), 'memoryId'),
            )
            setEditor(null)
          }}
        />
      ) : (
        <div className="grid gap-5">
          <nav className="flex items-center gap-1 border-b border-border">
            <Tab active={section === 'skills'} onClick={() => setSection('skills')}>
              <BookOpen aria-hidden="true" className="h-4 w-4" />
              Skill
              <span className="text-caption text-ink-muted">
                {enabledCount}/{skills.length}
              </span>
            </Tab>
            <Tab active={section === 'mcp'} onClick={() => setSection('mcp')}>
              <Plug aria-hidden="true" className="h-4 w-4" />
              MCP
              <span className="text-caption text-ink-muted">
                {servers.filter((server) => server.enabled).length}/{servers.length}
              </span>
            </Tab>
            <Tab active={section === 'memory'} onClick={() => setSection('memory')}>
              <Brain aria-hidden="true" className="h-4 w-4" />
              记忆
              <span className="text-caption text-ink-muted">
                {memories.filter((memory) => memory.enabled).length}/{memories.length}
              </span>
            </Tab>
          </nav>

          {section === 'skills' ? (
            <section className="grid gap-3">
              <SectionHeading
                title="任务工艺"
                description="模型先根据适用条件发现 Skill，再读取正文；未启用的 Skill 不参与召回。"
                actionLabel="新建 Skill"
                onAction={() => setEditor({ kind: 'skill' })}
              />
              {loading ? (
                <QuietState>正在读取 Skill…</QuietState>
              ) : skills.length === 0 ? (
                <QuietState>还没有 Skill。把稳定复用的做法沉淀在这里。</QuietState>
              ) : (
                skills.map((skill) => (
                  <article
                    key={skill.skillId}
                    className="group grid grid-cols-[minmax(0,1fr)_auto] gap-4 rounded-md px-3 py-3 transition-colors hover:bg-surface-muted"
                  >
                    <button
                      type="button"
                      className="min-w-0 text-left"
                      onClick={() => setEditor({ kind: 'skill', current: skill })}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-body font-semibold text-ink">
                          {skill.title}
                        </span>
                        <Badge appearance="outline">{skill.capabilityPath}</Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-small leading-relaxed text-ink-subtle">
                        {skill.whenToUse}
                      </p>
                    </button>
                    <EnableSwitch
                      checked={skill.enabled}
                      disabled={busyId === skill.skillId}
                      label={`${skill.enabled ? '停用' : '启用'} ${skill.title}`}
                      onClick={() => void toggleSkill(skill)}
                    />
                  </article>
                ))
              )}
            </section>
          ) : section === 'mcp' ? (
            <section className="grid gap-3">
              <SectionHeading
                title="外部能力连接"
                description="Iris 只保存连接地址与凭据环境变量名；连通后远端工具进入同一审批和执行链路。"
                actionLabel="添加 MCP"
                onAction={() => setEditor({ kind: 'mcp' })}
              />
              {loading ? (
                <QuietState>正在读取 MCP 连接…</QuietState>
              ) : servers.length === 0 ? (
                <QuietState>还没有 MCP 连接。首版支持 Streamable HTTP。</QuietState>
              ) : (
                servers.map((server) => {
                  const expanded = expandedServer === server.serverId
                  return (
                    <article key={server.serverId} className="rounded-md px-3 py-3 hover:bg-surface-muted">
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4">
                        <button
                          type="button"
                          className="min-w-0 text-left"
                          onClick={() => void toggleServerDetail(server)}
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
                            {server.toolCount} 个工具 · {server.endpoint}
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
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditor({ kind: 'mcp', current: server })}
                            >
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
          ) : (
            <section className="grid gap-3">
              <SectionHeading
                title="可追溯的个人事实"
                description="启用的记忆才参与语义召回；模型先看到候选摘要，确有需要时再读取精确正文。"
                actionLabel="添加记忆"
                onAction={() => setEditor({ kind: 'memory' })}
              />
              {loading ? (
                <QuietState>正在读取记忆…</QuietState>
              ) : memories.length === 0 ? (
                <QuietState>还没有长期记忆。普通对话不会自动沉淀为事实。</QuietState>
              ) : (
                memories.map((memory) => (
                  <article
                    key={memory.memoryId}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 rounded-md px-3 py-3 transition-colors hover:bg-surface-muted"
                  >
                    <button
                      type="button"
                      className="min-w-0 text-left"
                      disabled={busyId === memory.memoryId}
                      onClick={() => void editMemory(memory)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-body font-semibold text-ink">
                          {memory.title}
                        </span>
                        <Badge appearance="outline">{memory.scope}</Badge>
                        <span className="text-caption text-ink-muted">
                          {Math.round(memory.confidence * 100)}%
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-small leading-relaxed text-ink-subtle">
                        {memory.preview}
                      </p>
                      <p className="mt-1 text-caption text-ink-muted">
                        来源：{memory.sourceKind}
                      </p>
                    </button>
                    <EnableSwitch
                      checked={memory.enabled}
                      disabled={busyId === memory.memoryId}
                      label={`${memory.enabled ? '忘记' : '恢复'} ${memory.title}`}
                      onClick={() => void toggleMemory(memory)}
                    />
                  </article>
                ))
              )}
            </section>
          )}
        </div>
      )}
    </Modal>
  )
}

function MemoryEditor({
  current,
  onCancel,
  onSaved,
}: {
  current?: MemoryView
  onCancel: () => void
  onSaved: (memory: MemoryView) => void
}) {
  const [draft, setDraft] = useState<MemoryDraft>(
    current
      ? {
          title: current.title,
          content: current.content,
          scope: current.scope,
          sourceKind: current.sourceKind,
          sourceRef: current.sourceRef ?? '',
          confidence: current.confidence,
          enabled: current.enabled,
        }
      : emptyMemory,
  )
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const saved = current
        ? await capabilityManagementApi.updateMemory(
            memorySummary(current),
            draft,
          )
        : await capabilityManagementApi.createMemory(draft)
      onSaved(saved)
    } catch (error) {
      notify.error('记忆没有保存', { description: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <EditorHeading title={current ? '编辑记忆' : '添加记忆'} onCancel={onCancel} />
      <Input label="事实标题" required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="偏好的周报格式" />
      <TextArea label="事实正文" value={draft.content} onChange={(value) => setDraft({ ...draft, content: value })} rows={7} description="只写可在未来复用的稳定事实；不要把一次任务的中间状态写进来。" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="作用域" required value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value })} />
        <Input label="置信度" required type="number" min={0} max={1} step={0.05} value={draft.confidence} onChange={(event) => setDraft({ ...draft, confidence: Number(event.target.value) })} />
      </div>
      <Input label="来源引用" value={draft.sourceRef} onChange={(event) => setDraft({ ...draft, sourceRef: event.target.value })} description={`来源类型：${draft.sourceKind}。引用可留空，但不能伪造出处。`} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>取消</Button>
        <Button type="submit" isLoading={saving} loadingLabel="正在保存">保存记忆</Button>
      </div>
    </form>
  )
}

function SkillEditor({
  current,
  onCancel,
  onSaved,
}: {
  current?: SkillView
  onCancel: () => void
  onSaved: (skill: SkillView) => void
}) {
  const [draft, setDraft] = useState<SkillDraft>(
    current
      ? {
          name: current.name,
          title: current.title,
          capabilityPath: current.capabilityPath,
          description: current.description,
          whenToUse: current.whenToUse,
          instructions: current.instructions,
          dependencies: current.dependencies,
          enabled: current.enabled,
        }
      : emptySkill,
  )
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const saved = current
        ? await capabilityManagementApi.updateSkill(current, draft)
        : await capabilityManagementApi.createSkill(draft)
      onSaved(saved)
    } catch (error) {
      notify.error('Skill 没有保存', { description: (error as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <EditorHeading title={current ? '编辑 Skill' : '新建 Skill'} onCancel={onCancel} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="名称" required value={draft.name} disabled={Boolean(current)} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="weekly_report" />
        <Input label="标题" required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="整理周报" />
      </div>
      <Input label="能力路径" value={draft.capabilityPath} onChange={(event) => setDraft({ ...draft, capabilityPath: event.target.value })} description="留空时进入 /skills/personal；路径末段必须与名称一致。" placeholder="/skills/personal/weekly_report" />
      <TextArea label="一句话描述" value={draft.description} onChange={(value) => setDraft({ ...draft, description: value })} rows={2} />
      <TextArea label="何时使用" value={draft.whenToUse} onChange={(value) => setDraft({ ...draft, whenToUse: value })} rows={3} description="这是召回判断的主要依据，请写任务特征，不要写泛化口号。" />
      <TextArea label="工艺正文" value={draft.instructions} onChange={(value) => setDraft({ ...draft, instructions: value })} rows={10} />
      <Input label="依赖能力路径" value={draft.dependencies.join(', ')} onChange={(event) => setDraft({ ...draft, dependencies: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} description="可选；多个绝对能力路径用逗号分隔。" />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>取消</Button>
        <Button type="submit" isLoading={saving} loadingLabel="正在保存">保存 Skill</Button>
      </div>
    </form>
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
          endpoint: current.endpoint,
          authorizationEnv: current.authorizationEnv ?? '',
          enabled: current.enabled,
        }
      : emptyMcp,
  )
  const [saving, setSaving] = useState(false)

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
      <EditorHeading title={current ? '编辑 MCP 连接' : '添加 MCP 连接'} onCancel={onCancel} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="连接标识" required value={draft.slug} onChange={(event) => setDraft({ ...draft, slug: event.target.value })} placeholder="office_tools" />
        <Input label="显示名称" required value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} placeholder="Office 工具" />
      </div>
      <Input label="Streamable HTTP 地址" required type="url" value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} placeholder="http://127.0.0.1:3000/mcp" />
      <Input label="Bearer Token 环境变量" value={draft.authorizationEnv} onChange={(event) => setDraft({ ...draft, authorizationEnv: event.target.value })} placeholder="OFFICE_MCP_TOKEN" description="这里只保存环境变量名，Token 本身不会进入 Iris 数据库或前端。" />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>取消</Button>
        <Button type="submit" isLoading={saving} loadingLabel="正在连接">保存并检查连接</Button>
      </div>
    </form>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn('relative flex items-center gap-2 px-3 pb-3 text-small font-semibold transition-colors', active ? 'text-ink' : 'text-ink-muted hover:text-ink-subtle', active && 'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary')}>
      {children}
    </button>
  )
}

function SectionHeading({ title, description, actionLabel, onAction }: { title: string; description: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="flex items-start justify-between gap-5 px-1">
      <div>
        <h3 className="text-body font-semibold text-ink">{title}</h3>
        <p className="mt-1 text-small leading-relaxed text-ink-muted">{description}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={onAction}>
        <Plus className="h-3.5 w-3.5" />
        {actionLabel}
      </Button>
    </div>
  )
}

function EditorHeading({ title, onCancel }: { title: string; onCancel: () => void }) {
  return (
    <div className="flex items-center justify-between border-b border-border pb-3">
      <h3 className="text-title font-semibold text-ink">{title}</h3>
      <Button variant="ghost" size="sm" onClick={onCancel}>返回列表</Button>
    </div>
  )
}

function TextArea({ label, value, onChange, rows, description }: { label: string; value: string; onChange: (value: string) => void; rows: number; description?: string }) {
  return (
    <label className="grid gap-1.5 text-small font-semibold text-ink">
      {label}
      <textarea required value={value} rows={rows} onChange={(event) => onChange(event.target.value)} className="w-full resize-y rounded-sm border border-border bg-surface-raised px-3.5 py-2.5 text-body font-normal leading-relaxed text-ink shadow-hairline outline-none transition-[border-color,box-shadow] hover:border-border-strong focus:border-focus focus:shadow-focus" />
      {description && <span className="font-normal text-ink-muted">{description}</span>}
    </label>
  )
}

function EnableSwitch({ checked, disabled, label, onClick }: { checked: boolean; disabled?: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onClick} className={cn('relative mt-0.5 h-5 w-9 rounded-full transition-colors duration-fast disabled:opacity-50', checked ? 'bg-primary' : 'bg-border-strong')}>
      <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-hairline transition-transform duration-fast', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
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

function QuietState({ children }: { children: ReactNode }) {
  return <div className="rounded-md bg-surface-muted px-4 py-8 text-center text-small text-ink-muted">{children}</div>
}

function replaceBy<T, K extends keyof T>(items: T[], value: T, key: K) {
  return items.map((item) => item[key] === value[key] ? value : item)
}

function replaceOrAdd<T, K extends keyof T>(items: T[], value: T, key: K) {
  return items.some((item) => item[key] === value[key])
    ? replaceBy(items, value, key)
    : [...items, value]
}

function memorySummary(memory: MemoryView): MemorySummary {
  return {
    memoryId: memory.memoryId,
    definitionVersion: memory.definitionVersion,
    headVersion: memory.headVersion,
    title: memory.title,
    preview: memory.content.length > 320
      ? `${memory.content.slice(0, 320)}…`
      : memory.content,
    scope: memory.scope,
    sourceKind: memory.sourceKind,
    sourceRef: memory.sourceRef,
    confidence: memory.confidence,
    enabled: memory.enabled,
    lifecycleStatus: memory.lifecycleStatus,
    updatedAt: memory.updatedAt,
  }
}

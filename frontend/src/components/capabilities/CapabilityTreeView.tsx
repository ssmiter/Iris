import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Plug,
  Plus,
} from 'lucide-react'
import {
  capabilityAdminApi,
  capabilityManagementApi,
  type CapabilityAdminDetail,
  type CapabilityAdminItem,
  type CapabilityAdminListing,
  type CapabilityAdminProblem,
  type CapabilityTreeNode,
  type SkillView,
} from '@/api/irisApi'
import { Badge, Button, Input, notify } from '@/components/ui'
import { cn } from '@/lib/cn'
import { EnableSwitch, QuietState } from './controls'
import { SkillEditor } from './SkillEditor'

type BadgeTone = ComponentProps<typeof Badge>['tone']

type DetailState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; detail: CapabilityAdminDetail }

/** kind 徽标的语义色（docs/32 §5）；DB 技能库与文件技能以 origin 区分。 */
function kindMeta(item: CapabilityAdminItem): { label: string; tone: BadgeTone } {
  switch (item.kind) {
    case 'kernel_tool':
      return { label: '内核', tone: 'neutral' }
    case 'process':
      return { label: '进程', tone: 'info' }
    case 'template':
      return { label: '模板', tone: 'info' }
    case 'skill':
      return item.origin === 'skill_store'
        ? { label: '技能库', tone: 'teal' }
        : { label: '技能', tone: 'success' }
    case 'knowledge':
      return { label: '知识', tone: 'violet' }
    case 'mcp_tool':
    case 'mcp':
      return { label: 'MCP', tone: 'warning' }
    case 'pipeline':
      return { label: '流水线', tone: 'neutral' }
    case 'schedule':
      return { label: '定时', tone: 'info' }
    default:
      return { label: item.kind, tone: 'neutral' }
  }
}

const RISK_META: Record<string, { label: string; tone: BadgeTone }> = {
  read_only: { label: '只读', tone: 'neutral' },
  standard: { label: '标准', tone: 'info' },
  elevated: { label: '提权', tone: 'warning' },
  destructive: { label: '破坏', tone: 'danger' },
}

const ORIGIN_LABEL: Record<string, string> = {
  kernel: '内置',
  extension: '拓展',
  skill_store: '技能库',
  mcp: 'MCP',
  pipeline: '内置',
  schedule: '定时',
}

const STAT_LABELS: Record<string, string> = {
  tool_count: '工具数',
  success_rate_7d: '7 日成功率',
  p50_ms_7d: '7 日 p50',
}

/** Pipeline 最近运行的触发来源与阶段（docs/33 §5） */
const TRIGGER_LABEL: Record<string, string> = {
  agent_tool: '工具调用',
  ui_action: '界面动作',
  system_event: '系统事件',
  schedule: '定时任务',
}

const RUN_PHASE_META: Record<string, { label: string; tone: BadgeTone }> = {
  accepted: { label: '已接受', tone: 'info' },
  running: { label: '进行中', tone: 'info' },
  suspended: { label: '等待审批', tone: 'warning' },
  verifying: { label: '验证中', tone: 'info' },
  outcome_unknown: { label: '结果待核实', tone: 'warning' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已取消', tone: 'neutral' },
}

function formatRunTime(value: string) {
  const date = new Date(value)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
}

function formatStat(key: string, value: unknown): string {
  if (key === 'success_rate_7d') {
    const rate = Number(value)
    return Number.isFinite(rate)
      ? `${Math.round((rate > 1 ? rate : rate * 100) * 10) / 10}%`
      : String(value)
  }
  if (key === 'p50_ms_7d') return `${String(value)} ms`
  return String(value)
}

function findNode(
  node: CapabilityTreeNode,
  path: string,
): CapabilityTreeNode | null {
  if (node.path === path) return node
  for (const child of node.children) {
    const found = findNode(child, path)
    if (found) return found
  }
  return null
}

/** 选中路径的祖先链（含根），用于级联展开。 */
function ancestorsOf(path: string): string[] {
  const result = ['/']
  const segments = path.split('/').filter(Boolean)
  let current = ''
  for (const segment of segments.slice(0, -1)) {
    current += `/${segment}`
    result.push(current)
  }
  return result
}

/**
 * 统一能力页的主视图（docs/32 §5）：目录树为脊柱，kind 是切面，
 * 文件真相对象只读，DB 真相对象在此进入各自的编辑器/控制台。
 */
export function CapabilityTreeView({
  onOpenMcp,
  onOpenMemory,
  onOpenSchedule,
}: {
  onOpenMcp: (serverId?: string) => void
  onOpenMemory: () => void
  onOpenSchedule: () => void
}) {
  const [tree, setTree] = useState<CapabilityTreeNode | null>(null)
  const [treeFailed, setTreeFailed] = useState(false)
  const [selectedPath, setSelectedPath] = useState('/')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(['/']))
  const [listing, setListing] = useState<CapabilityAdminListing | null>(null)
  const [listingLoading, setListingLoading] = useState(false)
  const [skills, setSkills] = useState<SkillView[]>([])
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<string | null>(null)
  const [detailPath, setDetailPath] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, DetailState>>({})
  const [editingSkill, setEditingSkill] = useState<SkillView | undefined | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [problems, setProblems] = useState<CapabilityAdminProblem[]>([])

  const reloadTree = () => {
    capabilityAdminApi
      .tree()
      .then((next) => {
        setTree(next)
        setTreeFailed(false)
      })
      .catch((error: Error) => {
        setTreeFailed(true)
        notify.error('能力目录暂时不可用', { description: error.message })
      })
  }

  const reloadSkills = () => {
    capabilityManagementApi
      .listSkills()
      .then(setSkills)
      .catch(() => setSkills([]))
  }

  const reloadListing = (path: string) => {
    setListingLoading(true)
    capabilityAdminApi
      .items(path)
      .then((next) => setListing(next))
      .catch((error: Error) =>
        notify.error('没有读到该目录的能力', {
          description: (error as Error).message,
        }),
      )
      .finally(() => setListingLoading(false))
  }

  useEffect(() => {
    reloadTree()
    reloadSkills()
    capabilityAdminApi
      .problems()
      .then(setProblems)
      .catch(() => setProblems([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setKindFilter(null)
    setDetailPath(null)
    reloadListing(selectedPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath])

  const selectPath = (path: string) => {
    setSelectedPath(path)
    setExpanded((current) => {
      const next = new Set(current)
      for (const ancestor of ancestorsOf(path)) next.add(ancestor)
      next.add(path)
      return next
    })
  }

  const toggleExpanded = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const selectedNode = tree ? findNode(tree, selectedPath) : null

  const presentKinds = useMemo(() => {
    const kinds = new Set((listing?.items ?? []).map((item) => item.kind))
    return [...kinds].sort()
  }, [listing])

  const visibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (listing?.items ?? []).filter((item) => {
      if (kindFilter && item.kind !== kindFilter) return false
      if (!needle) return true
      return (
        item.name.toLowerCase().includes(needle) ||
        (item.description ?? '').toLowerCase().includes(needle)
      )
    })
  }, [listing, query, kindFilter])

  const toggleDetail = (item: CapabilityAdminItem) => {
    const path = item.path
    if (detailPath === path) {
      setDetailPath(null)
      return
    }
    setDetailPath(path)
    if (!details[path]) {
      setDetails((current) => ({ ...current, [path]: { status: 'loading' } }))
      capabilityAdminApi
        .detail(path)
        .then((detail) =>
          setDetails((current) => ({
            ...current,
            [path]: { status: 'ready', detail },
          })),
        )
        .catch(() =>
          setDetails((current) => ({ ...current, [path]: { status: 'error' } })),
        )
    }
  }

  const skillOf = (item: CapabilityAdminItem) =>
    item.origin === 'skill_store'
      ? skills.find(
          (skill) =>
            skill.skillId === item.id ||
            skill.capabilityPath === item.path,
        )
      : undefined

  const toggleSkillEnabled = async (
    item: CapabilityAdminItem,
    skill: SkillView,
  ) => {
    setBusyPath(item.path)
    const next = { ...skill, enabled: !skill.enabled }
    setSkills((items) =>
      items.map((entry) => (entry.skillId === skill.skillId ? next : entry)),
    )
    try {
      const updated = await capabilityManagementApi.setSkillEnabled(
        skill,
        !skill.enabled,
      )
      setSkills((items) =>
        items.map((entry) =>
          entry.skillId === skill.skillId ? updated : entry,
        ),
      )
      reloadListing(selectedPath)
    } catch (error) {
      setSkills((items) =>
        items.map((entry) => (entry.skillId === skill.skillId ? skill : entry)),
      )
      notify.error('没有改变 Skill 状态', {
        description: (error as Error).message,
      })
    } finally {
      setBusyPath(null)
    }
  }

  if (editingSkill !== null) {
    return (
      <SkillEditor
        current={editingSkill}
        onCancel={() => setEditingSkill(null)}
        onSaved={() => {
          setEditingSkill(null)
          reloadSkills()
          reloadTree()
          reloadListing(selectedPath)
        }}
      />
    )
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="按名称或描述过滤当前目录"
          containerClassName="min-w-52 flex-1"
          className="h-9"
          placeholder="过滤当前目录：名称 / 描述"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditingSkill(undefined)}
          >
            <Plus className="h-3.5 w-3.5" />
            新建 Skill
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onOpenMcp()}>
            <Plug className="h-3.5 w-3.5" />
            MCP 连接
          </Button>
          <Button variant="ghost" size="sm" onClick={onOpenSchedule}>
            <Clock3 className="h-3.5 w-3.5" />
            定时任务
          </Button>
          <Button variant="ghost" size="sm" onClick={onOpenMemory}>
            <Brain className="h-3.5 w-3.5" />
            记忆
          </Button>
        </div>
      </div>

      {problems.length > 0 && (
        <ProblemsBanner problems={problems} />
      )}

      <div className="grid gap-5 sm:grid-cols-[13.5rem_minmax(0,1fr)]">
        <nav
          aria-label="能力目录"
          className="scrollbar-subtle max-h-[54vh] overflow-y-auto rounded-md border border-border bg-surface px-2 py-2"
        >
          {tree ? (
            <ul>
              <TreeNode
                node={tree}
                depth={0}
                selectedPath={selectedPath}
                expanded={expanded}
                onToggle={toggleExpanded}
                onSelect={selectPath}
              />
            </ul>
          ) : (
            <p className="px-2 py-6 text-center text-small text-ink-muted">
              {treeFailed ? '目录读取失败。' : '正在读取目录…'}
            </p>
          )}
        </nav>

        <section className="grid content-start gap-3">
          <header className="grid gap-1 border-b border-border pb-3">
            <div className="flex items-baseline gap-2">
              <h3 className="text-body font-semibold text-ink">
                {selectedNode?.title || selectedNode?.name || selectedPath}
              </h3>
              <code className="text-caption text-ink-muted">{selectedPath}</code>
              <span className="text-caption text-ink-muted">
                {selectedNode ? `${selectedNode.count} 项` : ''}
              </span>
            </div>
            {selectedNode && Object.keys(selectedNode.stats).length > 0 && (
              <p className="text-caption text-ink-muted">
                {Object.entries(selectedNode.stats)
                  .map(
                    ([key, value]) =>
                      `${STAT_LABELS[key] ?? key} ${formatStat(key, value)}`,
                  )
                  .join(' · ')}
              </p>
            )}
            {presentKinds.length > 1 && (
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <KindChip
                  active={kindFilter === null}
                  label="全部"
                  onClick={() => setKindFilter(null)}
                />
                {presentKinds.map((kind) => (
                  <KindChip
                    key={kind}
                    active={kindFilter === kind}
                    label={kind}
                    onClick={() =>
                      setKindFilter(kindFilter === kind ? null : kind)
                    }
                  />
                ))}
              </div>
            )}
          </header>

          {listingLoading ? (
            <QuietState>正在读取能力…</QuietState>
          ) : visibleItems.length === 0 ? (
            <QuietState>
              {listing && listing.items.length > 0
                ? '当前过滤条件下没有匹配的能力。'
                : '这个目录下还没有可直接寻址的能力。'}
            </QuietState>
          ) : (
            visibleItems.map((item) => (
              <CapabilityCard
                key={item.path}
                item={item}
                expanded={detailPath === item.path}
                detailState={details[item.path]}
                skill={skillOf(item)}
                busy={busyPath === item.path}
                onToggle={() => toggleDetail(item)}
                onToggleSkill={(skill) => void toggleSkillEnabled(item, skill)}
                onEditSkill={(skill) => setEditingSkill(skill)}
                onOpenMcp={onOpenMcp}
              />
            ))
          )}
        </section>
      </div>
    </div>
  )
}

function ProblemsBanner({
  problems,
}: {
  problems: CapabilityAdminProblem[]
}) {
  return (
    <div
      role="alert"
      className="rounded-md border border-warning/40 bg-warning-soft px-3 py-3"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="grid flex-1 gap-2">
          <p className="text-small font-semibold text-warning-foreground">
            拓展扫描问题（{problems.length}）
          </p>
          <ul className="grid gap-1.5">
            {problems.map((problem, index) => (
              <li
                key={index}
                className="text-small leading-relaxed text-warning-foreground/90"
              >
                {problem.file ? (
                  <>
                    <code className="break-all text-caption">{problem.file}</code>
                    <span className="mx-1.5 text-ink-muted">·</span>
                  </>
                ) : null}
                {problem.description}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

function TreeNode({
  node,
  depth,
  selectedPath,
  expanded,
  onToggle,
  onSelect,
}: {
  node: CapabilityTreeNode
  depth: number
  selectedPath: string
  expanded: ReadonlySet<string>
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}) {
  const hasChildren = node.children.length > 0
  const isExpanded = expanded.has(node.path)
  const isSelected = selectedPath === node.path
  return (
    <li>
      <div
        className={cn(
          'flex items-center gap-0.5 rounded-sm text-small transition-colors duration-fast',
          isSelected
            ? 'bg-primary-soft font-semibold text-ink'
            : 'text-ink-subtle hover:bg-surface-muted',
        )}
        style={{ paddingLeft: `${depth * 0.875}rem` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={isExpanded ? `收起 ${node.name}` : `展开 ${node.name}`}
            className="grid h-6 w-5 place-items-center text-ink-muted"
            onClick={() => onToggle(node.path)}
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-5" aria-hidden="true" />
        )}
        <button
          type="button"
          aria-current={isSelected ? 'true' : undefined}
          className="flex min-w-0 flex-1 items-baseline gap-1.5 py-1 pr-1.5 text-left"
          onClick={() => onSelect(node.path)}
        >
          <span className="truncate">{node.title || node.name}</span>
          <span className="shrink-0 text-caption font-normal text-ink-muted">
            {node.count}
          </span>
        </button>
      </div>
      {isExpanded && hasChildren && (
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function KindChip({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2 py-0.5 text-caption transition-colors duration-fast',
        active
          ? 'border-primary/40 bg-primary-soft text-ink'
          : 'border-border text-ink-muted hover:text-ink-subtle',
      )}
    >
      {label}
    </button>
  )
}

function CapabilityCard({
  item,
  expanded,
  detailState,
  skill,
  busy,
  onToggle,
  onToggleSkill,
  onEditSkill,
  onOpenMcp,
}: {
  item: CapabilityAdminItem
  expanded: boolean
  detailState?: DetailState
  skill?: SkillView
  busy: boolean
  onToggle: () => void
  onToggleSkill: (skill: SkillView) => void
  onEditSkill: (skill: SkillView) => void
  onOpenMcp: (serverId?: string) => void
}) {
  const shadowed = item.shadowedBy !== null
  const kind = kindMeta(item)
  const risk = item.riskLevel ? RISK_META[item.riskLevel] : undefined
  return (
    <article
      className={cn(
        'rounded-md px-3 py-3 transition-colors hover:bg-surface-muted',
        shadowed && 'opacity-60',
      )}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
        <button type="button" className="min-w-0 text-left" onClick={onToggle}>
          <div className="flex flex-wrap items-center gap-2">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
            )}
            <span className="truncate text-body font-semibold text-ink">
              {item.name}
            </span>
            <Badge tone={kind.tone}>{kind.label}</Badge>
            {risk && (
              <Badge tone={risk.tone} appearance="outline">
                {risk.label}
              </Badge>
            )}
            <Badge appearance="outline">
              {ORIGIN_LABEL[item.origin] ?? item.origin}
            </Badge>
            {shadowed && (
              <Badge tone="warning" showDot>
                被遮蔽
              </Badge>
            )}
          </div>
          {item.description && (
            <p className="ml-[1.375rem] mt-1 line-clamp-2 text-small leading-relaxed text-ink-subtle">
              {item.description}
            </p>
          )}
          {!shadowed &&
            item.availability &&
            item.availability !== 'available' &&
            item.availabilityReason && (
              <p className="ml-[1.375rem] mt-1 text-caption text-ink-muted">
                {item.availabilityReason}
              </p>
            )}
        </button>
        {skill && (
          <EnableSwitch
            checked={skill.enabled}
            disabled={busy}
            label={`${skill.enabled ? '停用' : '启用'} ${skill.title}`}
            onClick={() => onToggleSkill(skill)}
          />
        )}
      </div>
      {expanded && (
        <DetailPanel
          item={item}
          state={detailState}
          skill={skill}
          onEditSkill={onEditSkill}
          onOpenMcp={onOpenMcp}
        />
      )}
    </article>
  )
}

function DetailPanel({
  item,
  state,
  skill,
  onEditSkill,
  onOpenMcp,
}: {
  item: CapabilityAdminItem
  state?: DetailState
  skill?: SkillView
  onEditSkill: (skill: SkillView) => void
  onOpenMcp: (serverId?: string) => void
}) {
  return (
    <div className="ml-[1.375rem] mt-3 grid gap-3 border-l border-border pl-4">
      <div className="flex flex-wrap items-center gap-2 text-caption text-ink-muted">
        <code className="break-all">{item.path}</code>
        {item.version && <span>v{item.version}</span>}
      </div>

      {item.shadowedBy !== null ? (
        <p className="text-small leading-relaxed text-ink-subtle">
          该能力未注册到运行表：同名能力已由「{item.shadowedBy}」提供。
          修改来源文件后，等待所属拓展根的下一次重扫或重启即可恢复裁决。
        </p>
      ) : (
        <>
          {state?.status === 'loading' && (
            <p className="text-small text-ink-muted">正在读取定义…</p>
          )}
          {state?.status === 'error' && (
            <p className="text-small text-ink-muted">定义读取失败。</p>
          )}
          {state?.status === 'ready' && state.detail.definition !== null && (
            <pre className="scrollbar-subtle max-h-64 overflow-auto rounded-md bg-surface-muted p-3 font-mono text-caption leading-relaxed text-ink-subtle">
              {JSON.stringify(state.detail.definition, null, 2)}
            </pre>
          )}
          {state?.status === 'ready' && state.detail.recentRuns != null && (
            <div className="grid gap-1.5">
              <p className="text-caption font-semibold text-ink-muted">
                最近运行
              </p>
              {state.detail.recentRuns.length === 0 ? (
                <p className="text-small text-ink-muted">还没有运行记录。</p>
              ) : (
                <ul className="grid gap-1">
                  {state.detail.recentRuns.map((run) => {
                    const phase = RUN_PHASE_META[run.phase]
                    return (
                      <li
                        key={run.runId}
                        className="flex flex-wrap items-center gap-2 text-caption text-ink-subtle"
                      >
                        <Badge tone={phase?.tone ?? 'neutral'}>
                          {phase?.label ?? run.phase}
                        </Badge>
                        <Badge appearance="outline">
                          {TRIGGER_LABEL[run.triggerKind ?? ''] ??
                            run.triggerKind ??
                            '未知来源'}
                        </Badge>
                        <span>{formatRunTime(run.startedAt)}</span>
                        {run.endedAt && (
                          <span className="text-ink-muted">
                            → {formatRunTime(run.endedAt)}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {item.sourceFile && <SourceFileRow path={item.sourceFile} />}
      {item.sourceRoot && item.origin === 'extension' && (
        <p className="text-caption text-ink-muted">
          拓展根：<code className="break-all">{item.sourceRoot}</code>
        </p>
      )}

      <div className="flex items-center gap-2">
        {skill && (
          <Button variant="secondary" size="sm" onClick={() => onEditSkill(skill)}>
            编辑 Skill
          </Button>
        )}
        {item.origin === 'mcp' && item.sourceRoot && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenMcp(item.sourceRoot ?? undefined)}
          >
            管理连接
          </Button>
        )}
      </div>
    </div>
  )
}

function SourceFileRow({ path }: { path: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path)
      notify.success('来源路径已复制')
    } catch {
      notify.error('复制失败', { description: path })
    }
  }
  return (
    <div className="flex items-center gap-2 text-caption text-ink-muted">
      <span className="shrink-0">来源文件：</span>
      <code className="min-w-0 flex-1 break-all">{path}</code>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        aria-label="复制来源文件路径"
        onClick={() => void copy()}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

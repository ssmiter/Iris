import { useState, type ReactNode } from 'react'
import { Copy } from 'lucide-react'
import type { CapabilityAdminDetail, CapabilityAdminItem, SkillView } from '@/api/irisApi'
import { Badge, Button, notify } from '@/components/ui'
import { kindMeta } from '@/domain/capability/kindMeta'
import { cn } from '@/lib/cn'
import { EnableSwitch } from '../controls'
import { StatusLine } from './StatusLine'

const TRIGGER_LABEL: Record<string, string> = {
  agent_tool: '工具调用',
  ui_action: '界面动作',
  system_event: '系统事件',
  schedule: '定时任务',
}

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

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

type DetailState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; detail: CapabilityAdminDetail }

export function CapabilityDetailPanel({
  item,
  state,
  skill,
  onEditSkill,
  onToggleSkill,
  onOpenMcp,
}: {
  item: CapabilityAdminItem
  state?: DetailState
  skill?: SkillView
  onEditSkill: (skill: SkillView) => void
  onToggleSkill?: (skill: SkillView) => void
  onOpenMcp: (serverId?: string) => void
}) {
  const kind = kindMeta(item)

  return (
    <div className="grid gap-5 text-small">
      <div className="flex items-start gap-4">
        <span
          className={cn(
            'grid h-16 w-16 shrink-0 place-items-center rounded-2xl',
            kind.tileClass,
          )}
        >
          <kind.Icon className="h-8 w-8" />
        </span>
        <div className="grid min-w-0 flex-1 gap-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid min-w-0 gap-1">
              <h3 className="text-heading font-semibold text-ink">{item.name}</h3>
              {item.description && (
                <p className="text-small text-ink-subtle">{item.description}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <StatusLine item={item} />
                {item.version && (
                  <Badge appearance="outline">v{item.version}</Badge>
                )}
                <Badge appearance="outline" tone={kind.tone}>
                  {kind.label}
                </Badge>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {skill && (
                <Button
                  variant="secondary"
                  size="sm"
                  data-focus-key={`skill-edit-${item.path}`}
                  onClick={() => onEditSkill(skill)}
                >
                  编辑 Skill
                </Button>
              )}
              {skill && (
                <EnableSwitch
                  checked={skill.enabled}
                  label={`${skill.enabled ? '停用' : '启用'} ${skill.title}`}
                  onClick={() => onToggleSkill?.(skill)}
                />
              )}
              {item.origin === 'mcp' && item.sourceRoot && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenMcp(item.sourceRoot ?? undefined)}
                >
                  MCP 管理
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <Section title="位置">
        <div className="grid gap-1.5">
          <KeyValue label="位置" value={item.path} />
          {item.sourceFile && (
            <KeyValue label="文件" value={item.sourceFile} copyable />
          )}
          {item.sourceRoot && item.origin === 'extension' && (
            <KeyValue label="拓展根" value={item.sourceRoot} />
          )}
        </div>
      </Section>

      <Section title="定义">
        {item.shadowedBy !== null ? (
          <p className="leading-relaxed text-ink-subtle">
            同名能力已由 {item.shadowedBy} 提供，当前能力未生效。
            修改来源文件后，等所属拓展根下一次重扫或重启即可恢复。
          </p>
        ) : (
          <>
            {state?.status === 'loading' && (
              <p className="text-ink-muted">正在读取定义…</p>
            )}
            {state?.status === 'error' && (
              <p className="text-ink-muted">定义读取失败。</p>
            )}
            {state?.status === 'ready' && state.detail.definition !== null && (
              <DefinitionBlock definition={state.detail.definition} />
            )}
          </>
        )}
      </Section>

      {state?.status === 'ready' && state.detail.recentRuns != null && (
        <Section title="最近运行">
          {state.detail.recentRuns.length === 0 ? (
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface-muted text-ink-subtle">
                <kind.Icon className="h-5 w-5 opacity-60" />
              </span>
              <div className="grid gap-0.5">
                <p className="text-small text-ink-subtle">暂无运行记录</p>
                <p className="text-caption text-ink-muted">
                  使用一次后这里会显示最近状态。
                </p>
              </div>
            </div>
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
                        {formatRunTime(run.endedAt)}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Section>
      )}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-2">
      <h4 className="text-caption font-medium text-ink-muted tracking-wider">
        {title}
      </h4>
      {children}
    </div>
  )
}

function KeyValue({
  label,
  value,
  copyable,
}: {
  label: string
  value: string
  copyable?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
      notify.success('已复制到剪贴板')
    } catch {
      notify.error('复制失败', { description: value })
    }
  }
  return (
    <div className="flex items-start gap-2">
      <span className="w-16 shrink-0 text-caption text-ink-muted">{label}</span>
      <code className="min-w-0 flex-1 break-all text-small text-ink-subtle">
        {value}
      </code>
      {copyable && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label={copied ? '已复制' : '复制'}
          onClick={() => void copy()}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}

function DefinitionBlock({ definition }: { definition: unknown }) {
  const [copied, setCopied] = useState(false)
  const text = JSON.stringify(definition, null, 2)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
      notify.success('定义已复制')
    } catch {
      notify.error('复制失败')
    }
  }
  return (
    <div className="group relative">
      <pre className="scrollbar-subtle max-h-80 overflow-auto rounded-lg bg-surface-muted p-3 font-mono text-caption leading-relaxed text-ink-subtle">
        {text}
      </pre>
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 h-7 w-7 opacity-0 transition-opacity duration-fast group-hover:opacity-100"
        aria-label={copied ? '已复制' : '复制定义'}
        onClick={() => void copy()}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}


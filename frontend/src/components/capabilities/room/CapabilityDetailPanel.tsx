import { Copy } from 'lucide-react'
import type { CapabilityAdminDetail, CapabilityAdminItem, SkillView } from '@/api/irisApi'
import { Badge, Button, notify } from '@/components/ui'
import { EnableSwitch } from '../controls'

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
  return (
    <div className="grid gap-3 text-small">
      <div className="flex flex-wrap items-center gap-2 text-caption text-ink-muted">
        <code className="break-all">{item.path}</code>
        {item.version && <span>v{item.version}</span>}
      </div>

      {item.shadowedBy !== null ? (
        <p className="leading-relaxed text-ink-subtle">
          该能力未注册到运行表：同名能力已由「{item.shadowedBy}」提供。
          修改来源文件后，等待所属拓展根的下一次重扫或重启即可恢复裁决。
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
            <pre className="scrollbar-subtle max-h-64 overflow-auto rounded-md bg-surface-muted p-3 font-mono text-small leading-relaxed text-ink-subtle">
              {JSON.stringify(state.detail.definition, null, 2)}
            </pre>
          )}
          {state?.status === 'ready' && state.detail.recentRuns != null && (
            <div className="grid gap-1.5">
              <p className="text-caption font-medium text-ink-muted">最近运行</p>
              {state.detail.recentRuns.length === 0 ? (
                <p className="text-ink-muted">还没有运行记录。</p>
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

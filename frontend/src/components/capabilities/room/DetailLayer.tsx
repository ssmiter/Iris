import { useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Copy, FolderInput, Pencil, Trash2, X } from 'lucide-react'
import type {
  CapabilityAdminDetail,
  CapabilityAdminItem,
  CapabilityAdminProblem,
  SkillView,
} from '@/api/irisApi'
import { Badge, Button, notify } from '@/components/ui'
import { kindMeta } from '@/domain/capability/kindMeta'
import { riskMeta } from '@/domain/capability/riskMeta'
import { ancestorsOf, isFileTruth, parentPathOf } from '@/domain/capability/treeUtils'
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

const ORIGIN_LABEL: Record<string, string> = {
  kernel: '内置',
  extension: '文件拓展',
  mcp: 'MCP',
  skill_store: '技能库',
  pipeline: '流水线',
  schedule: '定时任务',
}

type DetailState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; detail: CapabilityAdminDetail }

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

/**
 * 详情层（docs/39 §3）：房间内右侧 370px 推入浮层，替代行内详情。
 * 主开关诚实原则——只对 DB 真相且确有 enabled PATCH 的对象出现
 * （当前接线：技能库 Skill）；内核与文件真相不造假控件。
 * 退出三条等价路径：Esc（壳层层栈）、✕、点击舞台空白。
 */
export function DetailLayer({
  item,
  state,
  skill,
  problems,
  titleOf,
  onClose,
  onNavigate,
  onEditSkill,
  onToggleSkill,
  onOpenMcp,
  onMoveTo,
  onDelete,
}: {
  item: CapabilityAdminItem | null
  state?: DetailState
  skill?: SkillView
  problems: CapabilityAdminProblem[]
  titleOf: (path: string) => string
  onClose: () => void
  onNavigate: (path: string) => void
  onEditSkill: (skill: SkillView) => void
  onToggleSkill: (skill: SkillView) => void
  onOpenMcp: (serverId?: string) => void
  onMoveTo: (event: ReactMouseEvent) => void
  onDelete: () => void
}) {
  // 退出动画期间保留上一份内容，层滑出后再随父组件卸载清空。
  const lastItemRef = useRef<CapabilityAdminItem | null>(null)
  if (item) lastItemRef.current = item
  const display = item ?? lastItemRef.current
  if (!display) return null

  const open = item != null
  const kind = kindMeta(display)
  const risk = display.riskLevel ? riskMeta(display.riskLevel) : null
  const fileTruth = isFileTruth(display)
  const hasIssue =
    display.shadowedBy !== null ||
    (display.availability != null && display.availability !== 'available')
  const problem = problems.find(
    (p) =>
      p.file != null &&
      display.sourceFile != null &&
      (p.file === display.sourceFile ||
        p.file.endsWith(display.sourceFile) ||
        display.sourceFile.endsWith(p.file)),
  )
  const parentDir = parentPathOf(display.path)
  const chain =
    parentDir === '/' ? ['/'] : [...ancestorsOf(parentDir), parentDir]

  return (
    <aside
      aria-label={`能力详情：${display.name}`}
      aria-hidden={!open}
      // 关闭时整层退出 tab 序（aria-hidden 不拦焦点；toggleAttribute 规避 React 18 无 inert 类型）
      ref={(el) => el?.toggleAttribute('inert', !open)}
      className={cn(
        'absolute bottom-2 right-2 top-2 z-30 flex w-[370px] flex-col overflow-hidden',
        'rounded-xl border border-border bg-surface-raised shadow-floating',
        'transition-transform duration-fold ease-enter motion-reduce:transition-none',
        open ? 'translate-x-0' : 'pointer-events-none translate-x-[calc(100%+1rem)]',
      )}
    >
      {/* 头：图标砖 + 名称 + 路径面包屑（可点）+ ✕ */}
      <header className="shrink-0 border-b border-border/60 px-4 pb-3.5 pt-4">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'grid h-12 w-12 shrink-0 place-items-center rounded-xl',
              kind.tileClass,
            )}
          >
            <kind.Icon className="h-6 w-6" />
          </span>
          <div className="grid min-w-0 flex-1 gap-1">
            <h3 className="truncate text-[16px] font-bold leading-6 tracking-[-0.01em] text-ink">
              {display.name}
            </h3>
            <nav
              aria-label="所在目录"
              className="flex flex-wrap items-center gap-0.5 text-caption text-ink-muted"
            >
              {chain.map((path, index) => (
                <span key={path} className="flex items-center gap-0.5">
                  {index > 0 && (
                    <span aria-hidden="true" className="text-ink-muted/60">/</span>
                  )}
                  <button
                    type="button"
                    className="press rounded-xs px-0.5 transition-colors duration-fast hover:bg-surface-muted hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
                    onClick={() => onNavigate(path)}
                  >
                    {titleOf(path)}
                  </button>
                </span>
              ))}
            </nav>
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <Badge appearance="outline" tone={kind.tone}>
                {kind.label}
              </Badge>
              {display.version && (
                <Badge appearance="outline">v{display.version}</Badge>
              )}
              {risk && risk.tone !== 'neutral' && (
                <Badge appearance="outline" tone={risk.tone}>
                  {risk.label}
                </Badge>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="press -mr-1.5 -mt-1 h-8 w-8 shrink-0 rounded-md"
            aria-label="关闭详情"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="grid gap-4 text-small">
          {/* 状态行：正常即安静，异常出黄底原因 */}
          <div
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2.5 text-small font-medium',
              hasIssue
                ? 'border border-warning/30 bg-warning-soft text-ink-subtle'
                : 'bg-surface-muted text-ink-subtle',
            )}
          >
            {hasIssue ? <StatusLine item={display} /> : '正常'}
          </div>

          {/* 主开关：仅可启停的 DB 真相对象 */}
          {skill && (
            <div className="flex items-center gap-3 rounded-lg bg-surface-muted px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-small font-semibold text-ink">
                  {skill.enabled ? '已启用' : '已停用'}
                </p>
                <p className="mt-0.5 text-caption text-ink-muted">
                  {skill.enabled ? '它在需要时会被调用。' : '停用它随时可以再打开。'}
                </p>
              </div>
              <EnableSwitch
                checked={skill.enabled}
                label={`${skill.enabled ? '停用' : '启用'} ${skill.title}`}
                onClick={() => onToggleSkill(skill)}
              />
            </div>
          )}

          {/* 修复盒：该能力关联 problem 时 */}
          {problem && (
            <div className="rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-3">
              <p className="text-small font-semibold text-ink">需要处理</p>
              <p className="mt-1 text-small leading-relaxed text-ink-subtle">
                {problem.description}
              </p>
              {problem.file && (
                <code className="mt-1.5 block break-all text-caption text-ink-muted">
                  {problem.file}
                </code>
              )}
              <p className="mt-1.5 text-caption text-ink-muted">
                修改来源文件后，等所属拓展根下一次重扫或重启即可恢复。
              </p>
            </div>
          )}

          {/* 说明 */}
          {display.description && (
            <Section title="说明">
              <p className="leading-relaxed text-ink-subtle">
                {display.description}
              </p>
            </Section>
          )}

          {/* 档案 */}
          <Section title="档案">
            <div className="grid gap-1.5">
              <KeyValue label="来源" value={ORIGIN_LABEL[display.origin] ?? display.origin} />
              {display.version && <KeyValue label="版本" value={`v${display.version}`} />}
              {risk && <KeyValue label="风险" value={risk.label} />}
              <KeyValue label="位置" value={display.path} />
              {display.sourceFile && (
                <KeyValue label="文件" value={display.sourceFile} copyable />
              )}
              {display.sourceRoot && display.origin === 'extension' && (
                <KeyValue label="拓展根" value={display.sourceRoot} />
              )}
            </div>
          </Section>

          {/* 定义 */}
          <Section title="定义">
            {display.shadowedBy !== null ? (
              <p className="leading-relaxed text-ink-subtle">
                同名能力已由 {display.shadowedBy} 提供，当前能力未生效。
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
      </div>

      {/* 底部动作 */}
      {(skill || display.origin === 'mcp' || fileTruth) && (
        <footer className="flex shrink-0 flex-wrap gap-2 border-t border-border/60 px-4 py-3">
          {skill && (
            <Button
              variant="secondary"
              size="sm"
              className="press"
              onClick={() => onEditSkill(skill)}
            >
              <Pencil className="h-3.5 w-3.5" />
              编辑 Skill
            </Button>
          )}
          {display.origin === 'mcp' && (
            <Button
              variant="ghost"
              size="sm"
              className="press"
              onClick={() => onOpenMcp(display.sourceRoot ?? undefined)}
            >
              MCP 管理
            </Button>
          )}
          {fileTruth && (
            <>
              <Button
                variant="secondary"
                size="sm"
                className="press"
                onClick={onMoveTo}
              >
                <FolderInput className="h-3.5 w-3.5" />
                移动到…
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="press text-danger hover:bg-danger-soft hover:text-danger"
                onClick={onDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除
              </Button>
            </>
          )}
        </footer>
      )}
    </aside>
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
      <h4 className="text-caption font-medium tracking-wider text-ink-muted">
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
          className="press h-7 w-7 shrink-0"
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

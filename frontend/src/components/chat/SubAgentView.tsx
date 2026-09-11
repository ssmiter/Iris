import { memo, useEffect, useMemo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { ArrowUp, ChevronLeft } from 'lucide-react'
import { useSubAgentRunStore, type SubAgentRunRecord } from '@/stores/subAgentRunStore'
import { useSubAgentViewStore } from '@/stores/subAgentViewStore'
import { killSubAgent, sendToSubAgent } from '@/agent/subAgentManager'
import { normalizeMarkdown } from '@/utils/markdownNormalizer'
import { SubAgentNodeList, ReportChip, toolEventsToNodes } from './SubAgentFlow'
import type { TurnPhase } from './FlowNode'

/**
 * 子 Agent 房间（2026-08-01 异步子 Agent 视觉；2026-08-13 改为左侧圆角浮层，蓝图 v16 形态）。
 *
 * 形态：左侧贴缘浮层卡——左边从未利用，作产品记忆点；无论左侧边栏开合都从最左边起排，
 * 遮挡对话记录无妨。头部（返回+身份+状态+终止）/消息体（任务书 → 你的补充 → 工具瀑布 →
 * 报告答案块 → 落盘 chip）/底部补充输入框（主子通信）。veil 无视觉遮罩，只做点外关闭（Esc 亦可）。
 *
 * 与主对话的视觉区分：任务书块用中性灰底（非用户气泡的白色）——它是主 Agent 派发的，
 * 不是用户说的话；整体仍是同一套瀑布/排版语言。
 *
 * 数据全部来自 subAgentRunStore（只读）+ manager 两个动作（kill/send）。
 * trace.json 完整轨迹查看 = defer（原料在 runStore.tracePath，需要时再懒加载）。
 */

const remarkPlugins = [remarkGfm, remarkBreaks]

/** 已发送补充的本地留痕（runStore 不存用户补充，会话内模块级 Map：关视图再开不丢） */
const sentLog = new Map<string, Array<{ text: string; at: number; state: 'delivered' | 'queued' }>>()

/** 终止按钮：两键确认（终止不可逆，部分成果会随通知保留） */
function KillButton({ runId }: { runId: string }) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const timer = window.setTimeout(() => setConfirming(false), 3000)
    return () => window.clearTimeout(timer)
  }, [confirming])
  return (
    <button
      className={`wf-subveil-kill${confirming ? ' confirm' : ''}`}
      onClick={() => {
        if (!confirming) {
          setConfirming(true)
          return
        }
        killSubAgent(runId)
        setConfirming(false)
      }}
    >
      {confirming ? t('chat.subAgentView.confirmKill') : t('chat.subAgentView.kill')}
    </button>
  )
}

const SubConversation = memo(function SubConversation({ run }: { run: SubAgentRunRecord }) {
  const { t } = useTranslation()
  const active = run.status === 'queued' || run.status === 'running'
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  // sentLog 是模块级 Map，发送后 bump 版本触发重渲染
  const [, setSentVersion] = useState(0)
  const sent = sentLog.get(run.runId) ?? []

  const childNodes = useMemo(() => toolEventsToNodes(run), [run])
  const turnPhase: TurnPhase = active ? 'active' : 'settled'

  const durationMs =
    run.endedAt != null && run.startedAt != null
      ? run.endedAt - run.startedAt
      : run.startedAt != null
        ? Date.now() - run.startedAt
        : null

  const send = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    const result = sendToSubAgent(run.runId, text)
    if (result === 'not-running') {
      setHint(t('chat.subAgentView.cannotDeliver'))
      return
    }
    const list = sentLog.get(run.runId) ?? []
    list.push({ text, at: Date.now(), state: result })
    sentLog.set(run.runId, list)
    setDraft('')
    setSentVersion((v) => v + 1)
    setHint(result === 'delivered' ? t('chat.subAgentView.deliveredInject') : t('chat.subAgentView.queuedInject'))
    window.setTimeout(() => setHint(null), 2500)
  }, [draft, run.runId])

  const statusLabel =
    run.status === 'queued'
      ? t('chat.subAgentView.statusQueued')
      : run.status === 'running'
        ? t('chat.subAgentView.statusRunning')
        : run.status === 'done'
          ? t('chat.subAgentView.statusDone')
          : run.status === 'error'
            ? t('chat.subAgentView.statusError')
            : t('chat.subAgentView.statusCancelled')

  return (
    <>
      <div className="wf-subveil-head">
        <span className="wf-subveil-title">
          {t('chat.subAgentView.title', {
            kind: run.kind === 'general' ? t('chat.subAgentView.kindGeneral') : t('chat.subAgentView.kindExplore'),
          })}
        </span>
        <span className={`wf-subveil-status ${run.status}`}>{statusLabel}</span>
        <span className="wf-subveil-spacer" />
        {active && <KillButton runId={run.runId} />}
      </div>

      <div className="wf-subveil-body">
        {/* 任务书：主 Agent 派发的（中性灰底气泡，区别于用户气泡的白色） */}
        <div className="wf-subdispatch-wrap">
          <div className="wf-subdispatch">
            <b>{t('chat.subAgentView.dispatchedTask')}</b>
            {run.task}
          </div>
        </div>

        {/* 你的补充（会话内留痕，按发送顺序） */}
        {sent.map((s, i) => (
          <div className="wf-subdispatch-wrap" key={i}>
            <div className="wf-subdispatch mine">
              <b>{s.state === 'delivered' ? t('chat.subAgentView.supplementDelivered') : t('chat.subAgentView.supplementQueued')}</b>
              {s.text}
            </div>
          </div>
        ))}

        {run.status === 'queued' && <div className="wf-subflow-live">▸ {t('chat.subAgentView.queued')}</div>}
        {run.status === 'running' && run.liveLine && (
          <div className="wf-subflow-live">▸ {run.liveLine}</div>
        )}

        {/* 工具瀑布（与主瀑布同一 FlowNode 语言） */}
        <SubAgentNodeList nodes={childNodes} turnPhase={turnPhase} />

        {/* 报告答案块 */}
        {!active && run.report && (
          <div className="wf-subreport wf-md">
            <ReactMarkdown remarkPlugins={remarkPlugins}>{normalizeMarkdown(run.report)}</ReactMarkdown>
          </div>
        )}
        {(run.status === 'error' || run.status === 'cancelled') && run.error && (
          <div className="wf-subflow-errline">{run.error}</div>
        )}

        {/* 写入/修改的文件（general 执行者产出清单，chip 点击复制路径） */}
        {run.touchedFiles.length > 0 && (
          <div className="wf-subfiles">
            <b>{t('chat.subAgentView.touchedFiles', { count: run.touchedFiles.length })}</b>
            <div className="wf-subfiles-row">
              {run.touchedFiles.map((p) => (
                <ReportChip key={p} path={p} />
              ))}
            </div>
          </div>
        )}
        {/* 并行冲突提示：与同会话其他子 Agent 触碰面有交集时如实留痕 */}
        {run.conflictNote && <div className="wf-subconflict">⚠ {run.conflictNote}</div>}

        {/* 页脚：统计 + 落盘路径 */}
        <div className="wf-subflow-foot">
          <span>
            {[
              t('chat.subAgentView.callCount', { count: run.toolEvents.length }),
              durationMs != null ? `${(durationMs / 1000).toFixed(durationMs < 1000 ? 1 : 0)}s` : null,
              run.discoveredNames.length > 0 ? t('chat.subAgentView.discovered', { count: run.discoveredNames.length }) : null,
              run.touchedFiles.length > 0 ? t('chat.subAgentView.wroteFiles', { count: run.touchedFiles.length }) : null,
            ].filter(Boolean).join(' · ')}
          </span>
          {run.reportPath && <ReportChip path={run.reportPath} />}
          {run.tracePath && <ReportChip path={run.tracePath} />}
        </div>
      </div>

      {/* 补充输入框：主子通信（delivered/queued/not-running 三态如实反馈） */}
      <div className="wf-subveil-composer">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
          placeholder={active ? t('chat.subAgentView.supplementPlaceholder') : t('chat.subAgentView.supplementDisabledPlaceholder')}
          disabled={!active}
        />
        <button
          className={`wf-subveil-send${draft.trim() ? ' ready' : ''}`}
          onClick={send}
          disabled={!active || !draft.trim()}
          aria-label={t('chat.subAgentView.send')}
        >
          <ArrowUp size={14} />
        </button>
        {hint && <span className="wf-subveil-hint">{hint}</span>}
      </div>
    </>
  )
})

export const SubAgentView = memo(function SubAgentView() {
  const { t } = useTranslation()
  const openRunId = useSubAgentViewStore((s) => s.openRunId)
  const close = useSubAgentViewStore((s) => s.close)
  const run = useSubAgentRunStore((s) => (openRunId ? s.runs[openRunId] : undefined))

  useEffect(() => {
    if (!openRunId) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [openRunId, close])

  if (!openRunId) return null
  // portal 到 body：跳出 .wf-stage 的 isolation 堆叠上下文，
  // 否则对话底部渐隐遮罩（z-10）会反压浮层（z-70 被关在 stage 内失效）
  return createPortal(
    <div className="wf-subveil open" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="wf-subveil-col">
        <button className="wf-subveil-close" onClick={close} aria-label={t('chat.subAgentView.backToChat')} title={t('chat.subAgentView.backToChat')}>
          <ChevronLeft size={16} />
        </button>
        {run ? (
          <SubConversation run={run} />
        ) : (
          <div className="wf-subveil-missing">
            {t('chat.subAgentView.recordMissing')}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
})

import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSubAgentRunStore, type SubAgentRunRecord } from '@/stores/subAgentRunStore'
import { useSubAgentViewStore } from '@/stores/subAgentViewStore'
import { useConversationStore } from '@/stores/conversationStore'

/**
 * 子 Agent 胶囊条（2026-08-01 异步子 Agent 视觉，挂在输入框内层顶部、排队托盘之上）。
 *
 * 有后台子 Agent 时，每个子 Agent 一个小胶囊：
 * - 类型词：调研（explore，只读）/ 执行（general，可写）——纯文字 + 分隔点（2026-08-04 无边界化）
 * - 状态点：排队/运行中深色脉冲，出错红，其余中性灰
 * - 文案直白：任务短名 + 「调研中 · 已调用 N 次工具」/已完成/出错/已中断
 * - 生命周期：运行中常驻不可 ×（它是唯一入口）；终态可 × 关闭（完成通知气泡已留痕）
 * - 点击打开子对话页（SubAgentView）
 * 不打扰：不自动弹、不 toast，完成提醒由主流里的系统事件气泡承担。
 */

function shortTask(task: string): string {
  const one = task.replace(/\s+/g, ' ').trim()
  return one.length > 14 ? one.slice(0, 14) + '…' : one
}

function statusText(run: SubAgentRunRecord, t: (key: string, options?: Record<string, unknown>) => string): string {
  const kind = run.kind === 'general' ? t('chat.subAgentCapsules.kindGeneral') : t('chat.subAgentCapsules.kindExplore')
  switch (run.status) {
    case 'queued':
      return t('chat.subAgentCapsules.queued')
    case 'running':
      return run.liveLine || t('chat.subAgentCapsules.running', { kind, count: run.toolEvents.length })
    case 'done':
      return t('chat.subAgentCapsules.done', { count: run.toolEvents.length })
    case 'error':
      return t('chat.subAgentCapsules.error')
    case 'cancelled':
      return t('chat.subAgentCapsules.cancelled')
  }
}

const Capsule = memo(function Capsule({ run }: { run: SubAgentRunRecord }) {
  const { t } = useTranslation()
  const open = useSubAgentViewStore((s) => s.open)
  const dismiss = useSubAgentViewStore((s) => s.dismiss)
  const active = run.status === 'queued' || run.status === 'running'
  return (
    <button
      className={`wf-subpill ${run.status}`}
      title={`${run.task}\n${statusText(run, t)}`}
      onClick={() => open(run.runId)}
    >
      <span className="wf-subpill-dot" />
      <span className={`wf-subpill-kind ${run.kind === 'general' ? 'general' : 'explore'}`}>
        {run.kind === 'general' ? t('chat.subAgentCapsules.kindGeneral') : t('chat.subAgentCapsules.kindExplore')}
      </span>
      <span className="wf-subpill-task">{shortTask(run.task)}</span>
      <span className="wf-subpill-status">{statusText(run, t)}</span>
      {!active && (
        <span
          className="wf-subpill-x"
          title={t('common.close')}
          onClick={(e) => {
            e.stopPropagation()
            dismiss(run.runId)
          }}
        >
          ×
        </span>
      )}
    </button>
  )
})

export const SubAgentCapsules = memo(function SubAgentCapsules() {
  const runs = useSubAgentRunStore((s) => s.runs)
  const order = useSubAgentRunStore((s) => s.order)
  const dismissedIds = useSubAgentViewStore((s) => s.dismissedIds)
  const currentConversationId = useConversationStore((s) => s.currentConversationId)

  const visible = useMemo(
    () =>
      order
        .map((id) => runs[id])
        .filter(
          (r): r is SubAgentRunRecord =>
            r != null &&
            !dismissedIds.has(r.runId) &&
            // as_task 任务会话运行不进胶囊条（2026-09-02 拍板）：它的入口=父会话正文区任务卡+
            // 任务会话内实况渲染，胶囊这条临时后台通道只留给普通子 Agent
            r.taskConversationId == null &&
            (r.conversationId == null || r.conversationId === currentConversationId)
        ),
    [runs, order, dismissedIds, currentConversationId]
  )

  if (visible.length === 0) return null
  return (
    <div className="wf-subpills">
      {visible.map((r) => (
        <Capsule key={r.runId} run={r} />
      ))}
    </div>
  )
})

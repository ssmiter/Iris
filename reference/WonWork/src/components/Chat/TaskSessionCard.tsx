import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Check, Clock, Loader2, Square, X } from 'lucide-react'
import type { ToolResultRendererProps } from '@/agent/tools/toolRenderRegistry'
import { useSubAgentRunStore } from '@/stores/subAgentRunStore'
import { useConversationStore } from '@/stores/conversationStore'
import { useChatStore } from '@/stores/chatStore'

/**
 * 任务会话卡（2026-09-01 二阶段切片1）：agent 工具 as_task 派遣回执的专属渲染。
 *
 * 定位：任务会话的唯一入口——任务会话不进侧栏主列表，父会话里这张卡就是门。
 * 数据源双轨（拍板：运行态归属管理器，历史态回退会话记录）：
 * - 进行中：subAgentRunStore 运行记录（liveLine=当前在做什么，秒级新鲜）；
 * - 回看（重启后/记录被 LRU 淘汰）：conversation.taskState 列兜底。
 * 点击进入=纯导航（复用会话切换序列），任务照常后台跑不打断。
 *
 * 2026-09-02 拍板：plan 闭环（待批准态+批准按钮）已退役——二次确认默认批准、
 * 学习成本高收益不明显；任务卡片机制保留。
 */

interface TaskCardPayload {
  taskConversationId?: number
  runId?: string
  content?: string
}

type CardStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

function resolveStatus(runStatus: string | undefined, taskState: string | null | undefined): CardStatus {
  if (runStatus === 'queued' || runStatus === 'running') return runStatus
  if (taskState === 'done' || taskState === 'error' || taskState === 'cancelled') return taskState
  if (runStatus === 'done' || runStatus === 'error' || runStatus === 'cancelled') return runStatus
  return 'running'
}

/** 进入任务会话：与 MainLayout.handleOpenConversation 同序列（卡只在对话视图渲染，无需收走廊/切视图）。
 *  2026-09-04 会话后台化：detach/attach 取代 stopStreaming——切走不杀正在跑的 loop。
 *  导出复用：SystemEventBubble（通知气泡"打开任务会话"入口）、ChatView（任务会话顶栏返回主对话）。 */
export function openTaskConversation(id: number): void {
  const chat = useChatStore.getState()
  if (id !== useConversationStore.getState().currentConversationId) {
    chat.detachConversationView()
  }
  chat.attachConversationView(id)
}

export const TaskSessionResultRenderer = memo(function TaskSessionResultRenderer({
  message,
}: ToolResultRendererProps) {
  const { t } = useTranslation()
  const payload = (message.structuredData ?? undefined) as TaskCardPayload | undefined
  const taskConversationId = payload?.taskConversationId

  // 运行态：本进程内的鲜活记录（liveLine 进度行）——按 taskConversationId 反查（运行记录带归属）
  const run = useSubAgentRunStore((s) => {
    if (taskConversationId == null) return undefined
    for (let i = s.order.length - 1; i >= 0; i--) {
      const r = s.runs[s.order[i]]
      if (r?.taskConversationId === taskConversationId) return r
    }
    return undefined
  })
  // 历史态：会话记录的 TaskState 列（重启/LRU 淘汰后兜底）
  const conv = useConversationStore((s) =>
    taskConversationId != null ? s.conversations.find((c) => c.id === taskConversationId) : undefined
  )

  // 非任务会话派遣（普通后台/同步 agent 结果）：不渲染，交回默认摘要行
  if (taskConversationId == null) return null

  const status = resolveStatus(run?.status, conv?.taskState)
  const active = status === 'queued' || status === 'running'
  const statusIcon =
    status === 'queued' ? (
      <Clock size={13} />
    ) : status === 'running' ? (
      <Loader2 size={13} className="animate-spin" />
    ) : status === 'done' ? (
      <Check size={13} />
    ) : status === 'cancelled' ? (
      <Square size={13} />
    ) : (
      <X size={13} />
    )
  const statusColor =
    status === 'done'
      ? 'var(--wf-ok-ink, #3d8a5a)'
      : status === 'error'
        ? 'var(--wf-err-ink, #b0443c)'
        : status === 'cancelled'
          ? 'var(--wf-mut)'
          : 'var(--wf-accent)'
  const title = conv?.title || payload?.content?.split('\n')[0] || `#${taskConversationId}`

  return (
    <div
      onClick={() => openTaskConversation(taskConversationId)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 12px',
        borderRadius: 10,
        border: '1px solid var(--wf-line)',
        background: 'var(--wf-card-bg)',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 12,
          color: statusColor,
          flexShrink: 0,
        }}
      >
        {statusIcon}
        {t(`chat.taskSession.${status}`)}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
        <span
          style={{
            fontSize: 13,
            color: 'var(--wf-ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {t('chat.taskSession.title')} · {title}
        </span>
        {active && run?.liveLine && (
          <span
            style={{
              fontSize: 12,
              color: 'var(--wf-mut)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {run.liveLine}
          </span>
        )}
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 12,
          color: 'var(--wf-mut)',
          flexShrink: 0,
        }}
      >
        {t('chat.taskSession.openHint')}
        <ArrowRight size={12} />
      </span>
    </div>
  )
})

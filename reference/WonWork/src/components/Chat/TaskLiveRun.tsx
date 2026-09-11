import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSubAgentRunStore } from '@/stores/subAgentRunStore'
import { useConversationStore } from '@/stores/conversationStore'
import { SubAgentNodeList, toolEventsToNodes } from './SubAgentFlow'
import type { TurnPhase } from './FlowNode'

/**
 * 任务会话进行中实况（2026-09-02 实测修复：点进任务会话不再空白）。
 *
 * 拍板形态：as_task 运行有两个事实源——落库消息（终态结论，完成后才写）与
 * subAgentRunStore 运行记录（过程实况，秒级新鲜）。任务会话正文 = 历史消息 +
 * 本组件内联渲染的实况段（挂在 MessageList Footer，参与钉底引擎）；
 * 完成瞬间由落库结论消息无缝接管（taskSession 完成编排里"正在查看则即时上屏"）。
 *
 * 与左侧子 Agent 浮层（SubAgentView）的关系：同源不同入口——非 as_task 的普通
 * 子 Agent 仍走胶囊→浮层（临时后台工具形态）；as_task 任务走任务卡→任务会话
 * （正式承载形态），实况直接内联，不再要求进会话后再点一次胶囊。
 */
export const TaskLiveRun = memo(function TaskLiveRun() {
  const { t } = useTranslation()
  const currentConversationId = useConversationStore((s) => s.currentConversationId)
  // 当前会话若是任务会话，取其运行记录（完成/出错后记录可能仍残留——只展示活跃态，
  // 终态由落库结论消息承接，避免与刚上屏的结论重复）
  const run = useSubAgentRunStore((s) => {
    if (currentConversationId == null) return undefined
    for (let i = s.order.length - 1; i >= 0; i--) {
      const r = s.runs[s.order[i]]
      if (r?.taskConversationId === currentConversationId) return r
    }
    return undefined
  })
  const active = run != null && (run.status === 'queued' || run.status === 'running')
  const nodes = useMemo(() => (run && active ? toolEventsToNodes(run) : []), [run, active])

  if (!run || !active) return null
  const turnPhase: TurnPhase = 'active'

  return (
    <div className="wf-turn-wrapper">
      {/* liveLine=当前在做什么（运行体直写 store，秒级新鲜）；瀑布与主对话同一 FlowNode 语言 */}
      <div className="wf-subflow-live">
        ▸ {run.status === 'queued' ? t('chat.subAgentView.queued') : (run.liveLine ?? t('chat.taskSession.running'))}
      </div>
      <SubAgentNodeList nodes={nodes} turnPhase={turnPhase} />
    </div>
  )
})

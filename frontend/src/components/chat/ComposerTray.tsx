/**
 * 排队 / 待注入 chips 托盘（v9.3）
 *
 * - 排队消息（运行中输入的斜杠命令等）：虚线 chip，turn 结束后自动发送；✕ 取消
 * - 待送入补充（运行中 Enter）：脉冲 chip，下一个 loop 边界作为普通用户消息进入上下文；
 *   进入前 ✕ 撤回无痕，进入后 chip 直接消失（模型接续回应就是反馈，不再停留"已注入"态）
 * - 运行中 /compact：排队 chip（本轮结束后自动压缩）
 *
 * 见 learn/04/workshop/压缩体验与追加注入重构-设计-2026-07-23.md
 */
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@/stores/chatStore'

export function ComposerTray() {
  const { t } = useTranslation()
  const queuedMessages = useChatStore((s) => s.queuedMessages)
  const pendingSupplements = useChatStore((s) => s.pendingSupplements)
  const pendingCompactAfterTurn = useChatStore((s) => s.pendingCompactAfterTurn)
  const dequeueMessage = useChatStore((s) => s.dequeueMessage)
  const cancelSupplement = useChatStore((s) => s.cancelSupplement)

  // kind='system'（子 Agent 通知登记项）不是用户输入——气泡已在瀑布流留痕，托盘不重复占位
  const visibleSupplements = pendingSupplements.filter((p) => p.kind !== 'system')

  if (queuedMessages.length === 0 && visibleSupplements.length === 0 && pendingCompactAfterTurn === null) return null

  return (
    <div className="wf-tray">
      {pendingCompactAfterTurn !== null && (
        <div className="wf-chiprow q">
          <span className="cr-tag">{t('chat.tray.compactQueued')}</span>
          <span className="cr-text">{t('chat.tray.compactQueuedText')}</span>
        </div>
      )}
      {queuedMessages.map((q) => (
        <div key={q.id} className="wf-chiprow q">
          <span className="cr-tag">{t('chat.tray.queued')}</span>
          <span className="cr-text" title={q.text}>{q.text}</span>
          <button
            type="button"
            className="cr-x"
            title={t('chat.tray.cancel')}
            onClick={() => dequeueMessage(q.id)}
          >
            ✕
          </button>
        </div>
      ))}
      {visibleSupplements.map((p) => (
        <div key={p.id} className="wf-chiprow s">
          <span className="cr-tag">
            <span className="pulse" />
            {t('chat.tray.pending')}
          </span>
          <span className="cr-text" title={p.text}>{p.text}</span>
          <button
            type="button"
            className="cr-x"
            title={t('chat.tray.withdraw')}
            onClick={() => cancelSupplement(p.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

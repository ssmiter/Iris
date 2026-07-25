/**
 * 状态缎带（v9.5）：模型运行状态一眼可读
 *
 * 运行中显示：● 正在执行 · 已耗时 Xs · N 条排队 · M 条待注入
 *
 * 设计收敛：中性墨色（对齐压缩条/瀑布正文语言），不再用蓝色大字；
 * 停止动作只保留 composer 内的 ■ 按钮一处（功能去重，避免两处同义按钮）。
 *
 * 注：审批有独立的浮动审批栏（MessageList .wf-approval-bar），ribbon 不承担审批。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '@/stores/chatStore'

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

export function ComposerRibbon() {
  const { t } = useTranslation()
  const isStreaming = useChatStore((s) => s.isStreaming)
  const queuedCount = useChatStore((s) => s.queuedMessages.length)
  const pendingCount = useChatStore((s) => s.pendingSupplements.filter((p) => !p.injected).length)

  const startRef = useRef(0)
  const [, forceTick] = useState(0)

  // 运行起止计时（500ms 刷新）
  useEffect(() => {
    if (!isStreaming) return
    startRef.current = Date.now()
    const timer = setInterval(() => forceTick((n) => n + 1), 500)
    return () => clearInterval(timer)
  }, [isStreaming])

  if (!isStreaming) return null

  const elapsed = startRef.current ? formatElapsed(Date.now() - startRef.current) : '0s'

  return (
    <div className="wf-ribbon run show">
      <span className="rb-dot" />
      <span>
        {t('chat.ribbon.running', { defaultValue: '正在执行' })} · {elapsed}
        {queuedCount > 0 && ` · ${t('chat.ribbon.queued', { count: queuedCount, defaultValue: '{{count}} 条排队' })}`}
        {pendingCount > 0 && ` · ${t('chat.ribbon.pending', { count: pendingCount, defaultValue: '{{count}} 条待注入' })}`}
      </span>
    </div>
  )
}

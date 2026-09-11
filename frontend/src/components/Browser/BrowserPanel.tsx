import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Hand, MousePointer2, PanelRightClose, Power } from 'lucide-react'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { useChatStore } from '@/stores/chatStore'

export function BrowserPanel() {
  const { t } = useTranslation()
  const {
    browserPanelMode,
    status,
    pageState,
    pauseRequested,
    openBrowserPanel,
    hideBrowserPanel,
    endBrowserSession,
    pauseAI,
    resumeAI,
  } = useWebBridgeStore()
  // 2026-07-31 订阅风暴修复：对象选择器无 shallow → 每次 set 都重渲染；拆开订阅
  const pendingApprovals = useChatStore((s) => s.pendingApprovals)
  const approveToolCall = useChatStore((s) => s.approveToolCall)
  const rejectToolCall = useChatStore((s) => s.rejectToolCall)
  const [showSessionMenu, setShowSessionMenu] = useState(false)
  const browserApproval = useMemo(
    () => pendingApprovals.find((item) => item.status === 'pending' && item.toolName.startsWith('webbridge')),
    [pendingApprovals],
  )

  useEffect(() => {
    if (browserApproval && browserPanelMode === 'hidden') openBrowserPanel()
  }, [browserApproval, browserPanelMode, openBrowserPanel])

  if (browserPanelMode === 'hidden') {
    if (!pageState) return null
    return (
      <button
        className="ww-browser-restore"
        data-testid="browser-panel-restore"
        onClick={openBrowserPanel}
        title={t('browser.restoreTitle')}
      >
        <MousePointer2 size={16} />
        <span>{t('browser.restoreButton')}</span>
        <span className={`ww-browser-live ${status === 'connected' ? 'online' : ''}`} />
      </button>
    )
  }

  return (
    <>
      <aside
        className="ww-browser-window-control"
        aria-label={t('browser.windowControlAria')}
        data-testid="browser-panel"
      >
        <div className="ww-browser-window-status">
          <span className={`ww-browser-live ${status === 'connected' ? 'online' : ''}`} />
          <div>
            <strong>{t('browser.running')}</strong>
            <span title={pageState?.url || ''}>{pageState?.title || t('browser.preparing')}</span>
          </div>
        </div>
        <div className="ww-browser-window-actions">
          <button onClick={openBrowserPanel} title={t('browser.openTooltip')}>
            <ExternalLink size={15} />
            {t('browser.open')}
          </button>
          <button
            className={pauseRequested ? 'active' : ''}
            onClick={pauseRequested ? resumeAI : pauseAI}
            title={pauseRequested ? t('browser.resumeTooltip') : t('browser.pauseTooltip')}
          >
            <Hand size={15} />
            {pauseRequested ? t('browser.resumeAi') : t('browser.pauseAi')}
          </button>
          <button onClick={hideBrowserPanel} title={t('browser.minimizeTooltip')}>
            <PanelRightClose size={15} />
            {t('browser.hide')}
          </button>
          <button
            className="ww-browser-session-trigger"
            onClick={() => setShowSessionMenu((value) => !value)}
            title={t('browser.sessionTooltip')}
          >
            <Power size={15} />
          </button>
          {showSessionMenu && (
            <div className="ww-browser-session-menu">
              <button data-testid="browser-session-end" onClick={() => void endBrowserSession()}>
                {t('browser.endSession')}
              </button>
            </div>
          )}
        </div>
      </aside>

      {browserApproval && (
        <div className="ww-browser-approval ww-browser-native-approval">
          <div>
            <strong>{t('browser.approvalTitle')}</strong>
            <p>{browserApproval.impactStatement || browserApproval.reason || t('browser.approvalFallback')}</p>
          </div>
          <button onClick={() => approveToolCall(browserApproval.toolCallId)}>{t('browser.approve')}</button>
          <button className="secondary" onClick={() => rejectToolCall(browserApproval.toolCallId)}>{t('browser.reject')}</button>
        </div>
      )}
    </>
  )
}

import { useTranslation } from 'react-i18next'
import { useState, useEffect } from 'react'
import { cn } from '@/utils'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { ConnectionPanel } from './ConnectionPanel'
import { SecurityPanel } from './SecurityPanel'
import { ActionPanel } from './ActionPanel'
import { WorkflowPanel } from './WorkflowPanel'
import { LogPanel } from './LogPanel'
import { WorkspaceBrowser } from './WorkspaceBrowser'

type TabId = 'connection' | 'security' | 'action' | 'workflow' | 'workspace' | 'log'

interface WebBridgeViewProps {
  onNavigate?: (view: string) => void
}

export function WebBridgeView({ onNavigate }: WebBridgeViewProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<TabId>('connection')
  const { autoStartEnabled, ensureDaemon } = useWebBridgeStore()

  useEffect(() => {
    if (autoStartEnabled) {
      ensureDaemon()
    }
  }, [autoStartEnabled, ensureDaemon])

  const tabs: { id: TabId; labelKey: string }[] = [
    { id: 'connection', labelKey: 'webbridge.webBridgeView.connectionTab' },
    { id: 'security', labelKey: 'webbridge.webBridgeView.securityTab' },
    { id: 'action', labelKey: 'webbridge.webBridgeView.actionTab' },
    { id: 'workflow', labelKey: 'webbridge.webBridgeView.workflowTab' },
    { id: 'workspace', labelKey: 'webbridge.webBridgeView.workspaceTab' },
    { id: 'log', labelKey: 'webbridge.webBridgeView.logTab' },
  ]

  return (
    <div className="flex flex-col h-full bg-surface-50">
      <header className="flex-none px-6 py-4 border-b border-surface-200 bg-white">
        <h1 className="text-xl font-semibold text-surface-900">{t('webbridge.webBridgeView.title')}</h1>
        <p className="text-sm text-surface-500 mt-1">{t('webbridge.webBridgeView.subtitle')}</p>
      </header>

      <div className="flex-none px-6 pt-4 border-b border-surface-200 bg-white">
        <nav className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                activeTab === tab.id
                  ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-surface-500 hover:text-surface-700 hover:border-surface-300'
              )}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-6">
        {activeTab === 'connection' && <ConnectionPanel />}
        {activeTab === 'security' && <SecurityPanel />}
        {activeTab === 'action' && <ActionPanel />}
        {activeTab === 'workflow' && <WorkflowPanel onNavigate={onNavigate} />}
        {activeTab === 'workspace' && <WorkspaceBrowser />}
        {activeTab === 'log' && <LogPanel />}
      </div>
    </div>
  )
}

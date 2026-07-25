import { useState, useCallback } from 'react'
import { cn } from '@/utils'
import { Sidebar } from './Sidebar'
import { LoginModal } from './LoginModal'
import { ChatView } from '@/components/Chat'
import { WorkflowView } from '@/components/Workflow'
import { MemoryManagerView } from '@/components/Memory'
import { AgentSwarmView } from '@/components/AgentSwarm'
import { CronSchedulerView } from '@/components/CronScheduler'
import { SettingsView } from '@/components/Settings'
import { SkillManagerView } from '@/components/Skill'
import { WebBridgeView } from '@/components/WebBridge'
import { DagWorkflowView } from '@/components/DagWorkflow'
import { PluginManagerView } from '@/components/Plugin'
import { ArtifactDock } from '@/components/Chat/ArtifactDock'
import { useWorkflowStore } from '@/stores/workflowStore'
import { useLicenseStore } from '@/stores/licenseStore'
import { useQuotaStore } from '@/stores/quotaStore'
import { useCommercialNoticeStore } from '@/stores/commercialNoticeStore'
import { usePermissionStore } from '@/stores/permissionStore'
import { useRuntimeConfigStore } from '@/stores/runtimeConfigStore'
import { supportsLicenseActivation, isPreview, FEATURE_FLAGS } from '@/config/product'
import { Lock, AlertTriangle } from 'lucide-react'

const VIEW_FEATURES: Record<string, string | undefined> = {
  chat: FEATURE_FLAGS.chat,
  workflow: FEATURE_FLAGS.workflow,
  'dag-workflow': FEATURE_FLAGS.dagWorkflow,
  memory: FEATURE_FLAGS.memory,
  'agent-swarm': FEATURE_FLAGS.agentSwarm,
  webbridge: FEATURE_FLAGS.webbridge,
  cron: FEATURE_FLAGS.cronScheduler,
  skill: FEATURE_FLAGS.skill,
  plugin: FEATURE_FLAGS.plugin,
  settings: undefined,
}

export function MainLayout() {
  const [activeView, setActiveView] = useState('chat')
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [guardMessage, setGuardMessage] = useState<string | null>(null)
  const startWorkflow = useWorkflowStore((s) => s.startWorkflow)
  const license = useLicenseStore((s) => s.license)
  const usage = useQuotaStore((s) => s.usage)
  const permissions = usePermissionStore((s) => s.permissions)
  const commercialNotice = useCommercialNoticeStore((s) => s.notice)
  const dismissCommercialNotice = useCommercialNoticeStore((s) => s.dismiss)

  const byokEnabled = useRuntimeConfigStore((s) => s.config.byokEnabled)

  const canNavigateTo = useCallback((view: string): { allowed: boolean; reason?: string } => {
    const feature = VIEW_FEATURES[view]
    if (!feature) return { allowed: true }
    // MESCLI / Standalone 模式下按后端返回的权限过滤
    if (!isPreview && !supportsLicenseActivation) {
      if (permissions && !permissions.features.includes(feature)) {
        return { allowed: false, reason: '当前账号无此功能权限' }
      }
      return { allowed: true }
    }
    // BYOK 测试构建跳过 License 校验，与 preview 模式对齐
    if (isPreview || !supportsLicenseActivation || byokEnabled) return { allowed: true }
    if (!license) return { allowed: false, reason: '请先激活 License' }
    if (license.status === 'expired') return { allowed: false, reason: 'License 已过期' }
    if (license.status === 'revoked') return { allowed: false, reason: 'License 已被吊销' }
    if (license.status !== 'active' && license.status !== 'trial') {
      return { allowed: false, reason: 'License 未激活' }
    }
    if (!(license.features || []).includes(feature)) {
      return { allowed: false, reason: '当前套餐不包含此功能' }
    }
    if (usage && usage.remainingTokens === 0) {
      return { allowed: false, reason: 'Token 额度已用完' }
    }
    return { allowed: true }
  }, [license, usage, permissions, byokEnabled])

  const handleNavigate = useCallback(
    (view: string) => {
      const { allowed, reason } = canNavigateTo(view)
      if (allowed) {
        setGuardMessage(null)
        setActiveView(view)
      } else {
        setGuardMessage(reason || '无权限访问此功能')
        setTimeout(() => setGuardMessage(null), 3000)
      }
    },
    [canNavigateTo]
  )

  const handleStartWorkflow = useCallback(
    async (code: string) => {
      const success = await startWorkflow(code)
      if (success) {
        handleNavigate('workflow')
      }
    },
    [startWorkflow, handleNavigate]
  )

  const renderView = () => {
    switch (activeView) {
      case 'chat':
        return <ChatView onNavigate={handleNavigate} />
      case 'workflow':
        return <WorkflowView onNavigate={handleNavigate} />
      case 'dag-workflow':
        return <DagWorkflowView onNavigate={handleNavigate} />
      case 'memory':
        return <MemoryManagerView />
      case 'agent-swarm':
        return <AgentSwarmView />
      case 'webbridge':
        return <WebBridgeView onNavigate={handleNavigate} />
      case 'cron':
        return <CronSchedulerView />
      case 'skill':
        return <SkillManagerView />
      case 'plugin':
        return <PluginManagerView />
      case 'settings':
        return <SettingsView />
      default:
        return <ChatView />
    }
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-50" style={{ '--wf-sidebar-width': isCollapsed ? '56px' : '248px' } as React.CSSProperties}>
      <Sidebar
        activeView={activeView}
        onNavigate={handleNavigate}
        isCollapsed={isCollapsed}
        onToggleCollapse={() => setIsCollapsed(!isCollapsed)}
        onOpenLogin={() => setShowLoginModal(true)}
      />
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {guardMessage && (
          <div className="absolute top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-700 text-xs">
            <Lock size={14} />
            {guardMessage}
          </div>
        )}
        {commercialNotice && (
          <div className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between gap-2 px-4 py-2 bg-red-50 border-b border-red-200 text-red-700 text-xs">
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} />
              {commercialNotice.message}
            </div>
            <button
              onClick={dismissCommercialNotice}
              className="text-red-600 hover:text-red-800 font-medium"
            >
              知道了
            </button>
          </div>
        )}
        {renderView()}
      </main>
      <LoginModal isOpen={showLoginModal} onClose={() => setShowLoginModal(false)} />
      <ArtifactDock />
    </div>
  )
}

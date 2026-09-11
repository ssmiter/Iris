import { useTranslation } from 'react-i18next'
import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { cn } from '@/utils'
import { useAgentSwarmStore } from '@/stores/agentSwarmStore'
import { useChatStore } from '@/stores/chatStore'
import type { Agent, AgentMessage } from '@/stores/agentSwarmStore'
import {
  PARALLEL_MODES,
  CONTEXT_STRATEGIES,
  SWARM_PRESETS,
  AGENT_ROLES,
  type ParallelMode,
  type ContextStrategy,
  type AgentRole,
} from '@/types/agentSwarm'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Users,
  Play,
  Square,
  Plus,
  Trash2,
  MessageSquare,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Bot,
  Sparkles,
  Settings,
  Copy,
  Check,
  SlidersHorizontal,
} from 'lucide-react'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-surface-200 text-surface-400 hover:text-surface-600 transition-all"
      title={useTranslation().t('agentSwarm.agentSwarmView.copy')}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

function getAgentDisplayName(agent: Agent, t: (key: string) => string): string {
  if (agent.nameKey) return t(agent.nameKey)
  return agent.name
}

function getAgentRoleName(agent: Agent, t: (key: string) => string): string {
  if (agent.roleKey) return t(agent.roleKey)
  return agent.role
}

const PRESET_KEYS = ['large-scale-research', 'long-form-writing', 'software-development', 'multi-perspective-analysis', 'document-processing', 'data-pipeline']

export function AgentSwarmView() {
  const { t, i18n } = useTranslation()
  const {
    agents,
    messages,
    tasks,
    isRunning,
    currentTaskId,
    swarmConfig,
    selectedPreset,
    lastExecutionResult,
    runSwarm,
    stopSwarm,
    addAgent,
    removeAgent,
    toggleAgent,
    clearMessages,
    clearTasks,
    loadPreset,
    setOrchestratorConfig,
    estimateCriticalSteps,
  } = useAgentSwarmStore()

  const [taskInput, setTaskInput] = useState('')
  const [sendToChat, setSendToChat] = useState(false)
  const [messageFilter, setMessageFilter] = useState<'all' | AgentMessage['type']>('all')
  const [showAgentConfig, setShowAgentConfig] = useState(false)
  const [showOrchestratorConfig, setShowOrchestratorConfig] = useState(false)
  const [newAgentName, setNewAgentName] = useState('')
  const [newAgentRole, setNewAgentRole] = useState('')
  const [newAgentPrompt, setNewAgentPrompt] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const activeProvider = useChatStore((s) => s.activeProvider)
  const activeAgents = useMemo(() => agents.filter((a) => a.isActive), [agents])
  const currentTask = useMemo(() => tasks.find((t) => t.id === currentTaskId), [tasks, currentTaskId])

  const filteredMessages = useMemo(() => {
    if (messageFilter === 'all') return messages
    return messages.filter((m) => m.type === messageFilter)
  }, [messages, messageFilter])

  const estimatedCriticalSteps = useMemo(() => {
    return estimateCriticalSteps(
      activeAgents.length || 1,
      10,
      swarmConfig.orchestrator.maxSupervisionSteps,
      swarmConfig.orchestrator.parallelMode
    )
  }, [activeAgents.length, swarmConfig.orchestrator.maxSupervisionSteps, swarmConfig.orchestrator.parallelMode, estimateCriticalSteps])

  const handleRun = useCallback(async () => {
    if (!taskInput.trim() || isRunning) return
    await runSwarm(taskInput.trim())
    setTaskInput('')
    if (sendToChat) {
      const result = useAgentSwarmStore.getState().lastExecutionResult
      if (result?.finalOutput) {
        await useChatStore.getState().appendAssistantMessage(result.finalOutput)
      }
    }
  }, [taskInput, isRunning, runSwarm, sendToChat])

  const handleStop = useCallback(() => {
    stopSwarm()
  }, [stopSwarm])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isRunning])

  const handleAddAgent = useCallback(() => {
    if (!newAgentName.trim() || !newAgentRole.trim()) return
    addAgent({
      name: newAgentName.trim(),
      role: newAgentRole.trim(),
      systemPrompt:
        newAgentPrompt.trim() ||
        t('agentSwarm.agentSwarmView.defaultSystemPrompt', {
          name: newAgentName.trim(),
          role: newAgentRole.trim(),
        }),
      model: 'gpt-4o',
      provider: 'OpenAI',
      color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
      icon: '🤖',
      isActive: true,
    })
    setNewAgentName('')
    setNewAgentRole('')
    setNewAgentPrompt('')
  }, [newAgentName, newAgentRole, newAgentPrompt, addAgent, t])

  const handlePresetChange = useCallback(
    (value: string) => {
      if (value === 'custom') {
        loadPreset('custom')
      } else if (SWARM_PRESETS[value]) {
        loadPreset(value)
      }
    },
    [loadPreset]
  )

  const handleParallelModeChange = useCallback(
    (mode: ParallelMode) => {
      setOrchestratorConfig({ parallelMode: mode })
    },
    [setOrchestratorConfig]
  )

  const handleContextStrategyChange = useCallback(
    (strategy: ContextStrategy) => {
      setOrchestratorConfig({ contextStrategy: strategy })
    },
    [setOrchestratorConfig]
  )

  const taskStatusClass = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-700'
      case 'running':
      case 'planning':
      case 'assigned':
        return 'bg-primary-100 text-primary-700'
      case 'verifying':
        return 'bg-amber-100 text-amber-700'
      case 'merging':
        return 'bg-purple-100 text-purple-700'
      case 'failed':
      case 'retrying':
        return 'bg-red-100 text-red-700'
      case 'cancelled':
        return 'bg-slate-100 text-slate-600'
      default:
        return 'bg-surface-200 text-surface-600'
    }
  }

  const messageTypeClass = (type: string) => {
    switch (type) {
      case 'thought':
        return 'bg-blue-100 text-blue-700'
      case 'action':
        return 'bg-amber-100 text-amber-700'
      case 'result':
        return 'bg-green-100 text-green-700'
      case 'delegate':
        return 'bg-purple-100 text-purple-700'
      case 'final':
        return 'bg-primary-100 text-primary-700'
      case 'system':
        return 'bg-surface-100 text-surface-600'
      default:
        return 'bg-surface-100 text-surface-600'
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-white border-b border-surface-200 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary-100 flex items-center justify-center">
            <Users size={20} className="text-primary-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-surface-800">{t('agentSwarm.agentSwarmView.title')}</h2>
            <p className="text-sm text-surface-400">
              {t('agentSwarm.agentSwarmView.subtitle')}
              {activeProvider && (
                <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-surface-100 text-surface-500">
                  {activeProvider.provider} · {activeProvider.model}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowOrchestratorConfig(!showOrchestratorConfig)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg transition-colors',
              showOrchestratorConfig
                ? 'text-primary-700 bg-primary-50'
                : 'text-surface-500 hover:text-surface-700 hover:bg-surface-100'
            )}
          >
            <SlidersHorizontal size={14} />
            {t('agentSwarm.agentSwarmView.config')}
          </button>
          <button
            onClick={() => setShowAgentConfig(!showAgentConfig)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-surface-500 hover:text-surface-700 hover:bg-surface-100 rounded-lg transition-colors"
          >
            <Settings size={14} />
            {t('agentSwarm.agentSwarmView.agentConfig')}
          </button>
          <button
            onClick={() => {
              clearMessages()
              clearTasks()
            }}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-surface-500 hover:text-surface-700 hover:bg-surface-100 rounded-lg transition-colors"
          >
            <Trash2 size={14} />
            {t('agentSwarm.agentSwarmView.clear')}
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: Agent List + Task Input + Config */}
        <div className="w-80 flex-shrink-0 bg-surface-50 border-r border-surface-200 flex flex-col overflow-y-auto">
          {/* Active Agents */}
          <div className="p-4 border-b border-surface-200">
            <h3 className="text-sm font-semibold text-surface-700 mb-3 flex items-center gap-2">
              <Bot size={14} />
              {t('agentSwarm.agentSwarmView.activeAgents', { count: agents.length })}
            </h3>
            <div className="space-y-2">
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className={cn(
                    'flex items-center gap-2 p-2 rounded-lg border transition-all',
                    agent.isActive
                      ? 'bg-white border-surface-200'
                      : 'bg-surface-100 border-transparent opacity-50'
                  )}
                >
                  <span className="text-lg">{agent.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-surface-700 truncate">
                      {getAgentDisplayName(agent, t)}
                    </p>
                    <p className="text-xs text-surface-400">{getAgentRoleName(agent, t)}</p>
                  </div>
                  <button
                    onClick={() => toggleAgent(agent.id)}
                    className={cn(
                      'w-6 h-6 rounded-full flex items-center justify-center transition-colors',
                      agent.isActive
                        ? 'bg-primary-100 text-primary-600'
                        : 'bg-surface-200 text-surface-400'
                    )}
                  >
                    {agent.isActive ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Preset + Parallel Mode + Config */}
          <div className="p-4 border-b border-surface-200 space-y-4">
            {/* Preset */}
            <div>
              <label className="block text-xs font-semibold text-surface-500 mb-1.5">
                {t('agentSwarm.agentSwarmView.preset')}
              </label>
              <select
                value={selectedPreset || 'custom'}
                onChange={(e) => handlePresetChange(e.target.value)}
                className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:border-primary-400"
              >
                {PRESET_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {t(`agentSwarm.agentSwarmView.preset.${key.replace(/-/g, '')}` as const)}
                  </option>
                ))}
                <option value="custom">{t('agentSwarm.agentSwarmView.preset.custom')}</option>
              </select>
              {swarmConfig.description && (
                <p className="mt-1 text-[10px] text-surface-400">{swarmConfig.description}</p>
              )}
            </div>

            {/* Parallel Mode */}
            <div>
              <label className="block text-xs font-semibold text-surface-500 mb-1.5">
                {t('agentSwarm.agentSwarmView.parallelMode')}
              </label>
              <select
                value={swarmConfig.orchestrator.parallelMode}
                onChange={(e) => handleParallelModeChange(e.target.value as ParallelMode)}
                className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white focus:outline-none focus:border-primary-400"
              >
                {PARALLEL_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`agentSwarm.agentSwarmView.parallelMode.${mode.replace(/_/g, '')}` as const)}
                  </option>
                ))}
              </select>
            </div>

            {/* Critical Steps */}
            <div className="flex items-center justify-between px-3 py-2 bg-white border border-surface-200 rounded-lg">
              <span className="text-xs text-surface-500">{t('agentSwarm.agentSwarmView.criticalSteps')}</span>
              <span className="text-xs font-semibold text-primary-600">
                {t('agentSwarm.agentSwarmView.criticalStepsValue', { count: estimatedCriticalSteps })}
              </span>
            </div>

            {/* Collapsible Orchestrator Config */}
            {showOrchestratorConfig && (
              <div className="space-y-3 pt-2 border-t border-surface-200">
                <div>
                  <label className="block text-[10px] font-semibold text-surface-500 mb-1">
                    {t('agentSwarm.agentSwarmView.maxSubAgents')}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={300}
                    value={swarmConfig.orchestrator.maxSubAgents}
                    onChange={(e) =>
                      setOrchestratorConfig({ maxSubAgents: Math.max(1, parseInt(e.target.value) || 1) })
                    }
                    className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-surface-500 mb-1">
                    {t('agentSwarm.agentSwarmView.maxRetries')}
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={swarmConfig.orchestrator.maxRetries}
                    onChange={(e) =>
                      setOrchestratorConfig({ maxRetries: Math.max(0, parseInt(e.target.value) || 0) })
                    }
                    className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-surface-500 mb-1">
                    {t('agentSwarm.agentSwarmView.contextStrategy')}
                  </label>
                  <select
                    value={swarmConfig.orchestrator.contextStrategy}
                    onChange={(e) => handleContextStrategyChange(e.target.value as ContextStrategy)}
                    className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
                  >
                    {CONTEXT_STRATEGIES.map((s) => (
                      <option key={s} value={s}>
                        {t(`agentSwarm.contextStrategy.${s}` as const)}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-xs text-surface-600 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={swarmConfig.orchestrator.enableCrossVerification}
                    onChange={(e) => setOrchestratorConfig({ enableCrossVerification: e.target.checked })}
                    className="rounded border-surface-300 text-primary-500 focus:ring-primary-400"
                  />
                  {t('agentSwarm.agentSwarmView.enableCrossVerification')}
                </label>
              </div>
            )}
          </div>

          {/* Task Input */}
          <div className="p-4 flex-1 flex flex-col">
            <h3 className="text-sm font-semibold text-surface-700 mb-3 flex items-center gap-2">
              <Sparkles size={14} />
              {t('agentSwarm.agentSwarmView.taskInput')}
            </h3>
            <textarea
              value={taskInput}
              onChange={(e) => setTaskInput(e.target.value)}
              placeholder={t('agentSwarm.agentSwarmView.taskPlaceholder')}
              rows={6}
              className="w-full flex-1 px-3 py-2 border border-surface-200 rounded-lg text-sm resize-none focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
            />
            <label className="flex items-center gap-2 mt-2 text-xs text-surface-600 cursor-pointer">
              <input
                type="checkbox"
                checked={sendToChat}
                onChange={(e) => setSendToChat(e.target.checked)}
                className="rounded border-surface-300 text-primary-500 focus:ring-primary-400"
              />
              {t('agentSwarm.agentSwarmView.sendToChat')}
            </label>
            <button
              onClick={isRunning ? handleStop : handleRun}
              disabled={!isRunning && !taskInput.trim()}
              className={cn(
                'mt-3 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isRunning
                  ? 'bg-red-500 text-white hover:bg-red-600'
                  : taskInput.trim()
                    ? 'bg-primary-500 text-white hover:bg-primary-600'
                    : 'bg-surface-200 text-surface-400 cursor-not-allowed'
              )}
            >
              {isRunning ? (
                <>
                  <Square size={14} />
                  {t('agentSwarm.agentSwarmView.stopExecution')}
                </>
              ) : (
                <>
                  <Play size={14} />
                  {t('agentSwarm.agentSwarmView.startSwarm')}
                </>
              )}
            </button>
          </div>

          {/* Agent Config Panel */}
          {showAgentConfig && (
            <div className="p-4 border-t border-surface-200 bg-amber-50">
              <h3 className="text-sm font-semibold text-surface-700 mb-3">
                {t('agentSwarm.agentSwarmView.addAgent')}
              </h3>
              <div className="space-y-2">
                <input
                  type="text"
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  placeholder={t('agentSwarm.agentSwarmView.agentName')}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm"
                />
                <select
                  value={newAgentRole}
                  onChange={(e) => setNewAgentRole(e.target.value)}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm bg-white"
                >
                  <option value="">{t('agentSwarm.agentSwarmView.selectRole')}</option>
                  {AGENT_ROLES.filter((r) => r !== 'orchestrator').map((role) => (
                    <option key={role} value={role}>
                      {t(`agentSwarm.defaultRoles.${role}`)}
                    </option>
                  ))}
                </select>
                <textarea
                  value={newAgentPrompt}
                  onChange={(e) => setNewAgentPrompt(e.target.value)}
                  placeholder={t('agentSwarm.agentSwarmView.systemPrompt')}
                  rows={3}
                  className="w-full px-3 py-2 border border-surface-200 rounded-lg text-sm resize-none"
                />
                <button
                  onClick={handleAddAgent}
                  className="w-full flex items-center justify-center gap-1 px-3 py-2 bg-primary-500 text-white text-sm rounded-lg hover:bg-primary-600"
                >
                  <Plus size={14} />
                  {t('agentSwarm.agentSwarmView.add')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right: Messages + Tasks */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Task Status */}
          {tasks.length > 0 && (
            <div className="px-4 py-3 bg-surface-50 border-b border-surface-200">
              <div className="flex items-center gap-3 overflow-x-auto">
                {tasks.slice(-5).map((task) => {
                  const duration = task.completedAt
                    ? `(${Math.round((task.completedAt - task.createdAt) / 1000)}s)`
                    : ''
                  return (
                    <div
                      key={task.id}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium flex-shrink-0',
                        taskStatusClass(task.status)
                      )}
                    >
                      {(task.status === 'running' || task.status === 'planning' || task.status === 'assigned') && (
                        <Clock size={12} className="animate-pulse" />
                      )}
                      {task.status === 'completed' && <CheckCircle2 size={12} />}
                      {(task.status === 'failed' || task.status === 'retrying') && <XCircle size={12} />}
                      <span className="truncate max-w-[120px]" title={task.description}>
                        {t(`agentSwarm.taskStatus.${task.status}`)}
                      </span>
                      {task.id === currentTaskId && (
                        <span className="opacity-60">· {task.title.slice(0, 20)}</span>
                      )}
                      {duration && <span className="opacity-60">{duration}</span>}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Execution Result */}
          {lastExecutionResult && (
            <div className="px-4 py-3 bg-white border-b border-surface-200 group">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold text-surface-700">
                  {t('agentSwarm.agentSwarmView.executionResult')}
                </h4>
                <div className="flex items-center gap-2">
                  <CopyButton text={lastExecutionResult.finalOutput || ''} />
                  <span
                    className={cn(
                      'text-xs px-2 py-0.5 rounded-full font-medium',
                      taskStatusClass(lastExecutionResult.status)
                    )}
                  >
                    {t(`agentSwarm.taskStatus.${lastExecutionResult.status}`)}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2 text-xs">
                <div className="bg-surface-50 rounded px-2 py-1.5">
                  <p className="text-surface-400">{t('agentSwarm.agentSwarmView.totalTime')}</p>
                  <p className="font-medium text-surface-700">
                    {((lastExecutionResult.totalExecutionTimeMs || 0) / 1000).toFixed(1)}s
                  </p>
                </div>
                <div className="bg-surface-50 rounded px-2 py-1.5">
                  <p className="text-surface-400">{t('agentSwarm.agentSwarmView.totalSteps')}</p>
                  <p className="font-medium text-surface-700">{lastExecutionResult.totalSteps || 0}</p>
                </div>
                <div className="bg-surface-50 rounded px-2 py-1.5">
                  <p className="text-surface-400">{t('agentSwarm.agentSwarmView.parallelismDegree')}</p>
                  <p className="font-medium text-surface-700">
                    {lastExecutionResult.parallelismDegree || 0}
                  </p>
                </div>
                <div className="bg-surface-50 rounded px-2 py-1.5">
                  <p className="text-surface-400">{t('agentSwarm.agentSwarmView.criticalSteps')}</p>
                  <p className="font-medium text-surface-700">
                    {lastExecutionResult.criticalSteps || 0}
                  </p>
                </div>
              </div>
              {lastExecutionResult.verificationIssues && lastExecutionResult.verificationIssues.length > 0 && (
                <div className="mt-2 p-2 bg-red-50 border border-red-100 rounded-lg text-xs text-red-700">
                  <p className="font-medium mb-1">
                    {t('agentSwarm.agentSwarmView.verificationIssues')}
                  </p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {lastExecutionResult.verificationIssues.map((issue, idx) => (
                      <li key={idx}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Messages */}
          <div className="px-4 py-2 bg-surface-50 border-b border-surface-200 flex items-center gap-2">
            <span className="text-xs text-surface-500">
              {t('agentSwarm.agentSwarmView.messageFilter')}
            </span>
            <select
              value={messageFilter}
              onChange={(e) => setMessageFilter(e.target.value as 'all' | AgentMessage['type'])}
              className="text-xs border border-surface-200 rounded px-2 py-1 bg-white focus:outline-none focus:border-primary-400"
            >
              <option value="all">{t('agentSwarm.agentSwarmView.messageFilterAll')}</option>
              {(['thought', 'action', 'result', 'delegate', 'final', 'system'] as AgentMessage['type'][]).map(
                (type) => (
                  <option key={type} value={type}>
                    {t(`agentSwarm.messageType.${type}`)}
                  </option>
                )
              )}
            </select>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {filteredMessages.length === 0 && !isRunning && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Users size={48} className="text-surface-300 mb-3" />
                <p className="text-surface-500 font-medium">{t('agentSwarm.agentSwarmView.ready')}</p>
                <p className="text-sm text-surface-400 mt-1 max-w-sm">
                  {t('agentSwarm.agentSwarmView.readyDescription')}
                </p>
              </div>
            )}

            {filteredMessages.map((msg) => {
              const agent = agents.find((a) => a.id === msg.agentId)
              return (
                <div
                  key={msg.id}
                  className={cn(
                    'group flex gap-3',
                    msg.type === 'delegate' && 'bg-amber-50 border border-amber-100 rounded-xl p-3'
                  )}
                >
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-sm"
                    style={{ backgroundColor: agent?.color || '#6366f1' }}
                  >
                    {agent?.icon || '🤖'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-surface-700">
                        {agent ? getAgentDisplayName(agent, t) : msg.agentName}
                      </span>
                      <span className={cn('text-xs px-1.5 py-0.5 rounded-full', messageTypeClass(msg.type))}>
                        {t(`agentSwarm.messageType.${msg.type}`)}
                      </span>
                      <span className="text-xs text-surface-400">
                        {new Date(msg.timestamp).toLocaleTimeString(i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US')}
                      </span>
                      <CopyButton text={msg.content} />
                    </div>
                    <div className="text-sm text-surface-700 bg-white border border-surface-200 rounded-lg p-3 prose prose-sm max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              )
            })}

            {isRunning && (
              <div className="flex items-center gap-2 text-sm text-surface-500">
                <div className="w-4 h-4 border-2 border-primary-300 border-t-primary-500 rounded-full animate-spin" />
                {t('agentSwarm.agentSwarmView.executing')}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>
    </div>
  )
}

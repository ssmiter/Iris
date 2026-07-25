import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { chatApi } from '@/api/client'
import { useMemoryStore } from '@/stores/memoryStore'
import { useChatStore } from '@/stores/chatStore'
import { useSkillStore } from '@/stores/skillStore'
import { executeSwarm } from '@/stores/agentSwarmEngine'
import type { Message, ProviderConfig } from '@/types/mescli'
import type { SkillManifest } from '@/types/skill'
import type {
  AgentSwarmConfig,
  AgentRole,
  ExecutionResult,
  ParallelMode,
  SubAgentConfig,
  SwarmTaskStatus,
} from '@/types/agentSwarm'
import {
  createDefaultSwarmConfig,
  estimateCriticalSteps as estimateCriticalStepsBase,
  loadPreset as loadPresetBase,
} from '@/types/agentSwarm'

export interface Agent {
  id: string
  name: string
  nameKey?: string
  role: string
  roleKey?: string
  systemPrompt: string
  model: string
  provider: string
  color: string
  icon: string
  isActive: boolean
}

export interface AgentMessage {
  id: string
  agentId: string
  agentName: string
  role: string
  content: string
  timestamp: number
  type: 'thought' | 'action' | 'result' | 'delegate' | 'final' | 'system'
}

export interface SwarmTask {
  id: string
  title: string
  description: string
  status: SwarmTaskStatus
  assignedAgent?: string
  result?: string
  createdAt: number
  completedAt?: number
}

export interface SubTask {
  id: string
  title: string
  description: string
  role?: AgentRole
  agentId?: string
  status: SwarmTaskStatus
  output?: string
  createdAt: number
  completedAt?: number
}

interface AgentSwarmState {
  // Agent registry
  agents: Agent[]

  // Runtime configuration
  swarmConfig: AgentSwarmConfig
  selectedPreset: string | null

  // Execution state
  isRunning: boolean
  currentTaskId: string | null
  abortController: AbortController | null

  // Execution trace
  messages: AgentMessage[]
  tasks: SwarmTask[]
  lastExecutionResult: ExecutionResult | null

  // Provider override
  activeProvider: ProviderConfig | null

  // Actions
  addAgent: (agent: Omit<Agent, 'id'>) => void
  removeAgent: (id: string) => void
  updateAgent: (id: string, updates: Partial<Agent>) => void
  toggleAgent: (id: string) => void

  loadPreset: (name: string) => void
  setSwarmConfig: (partial: Partial<AgentSwarmConfig>) => void
  setOrchestratorConfig: (partial: Partial<AgentSwarmConfig['orchestrator']>) => void
  resetSwarmConfig: () => void
  estimateCriticalSteps: (numSubAgents: number, avgSteps: number, orchestratorSteps: number, mode: ParallelMode) => number

  runSwarm: (task: string) => Promise<void>
  stopSwarm: () => void
  runAgent: (agentId: string, task: string, context?: string, signal?: AbortSignal) => Promise<string>
  delegate: (fromAgentId: string, toAgentId: string, task: string, signal?: AbortSignal) => Promise<string | undefined>

  addMessage: (msg: Omit<AgentMessage, 'id' | 'timestamp'>) => void
  addTask: (task: Omit<SwarmTask, 'id' | 'createdAt'>) => string
  updateTask: (id: string, updates: Partial<SwarmTask>) => void

  clearMessages: () => void
  clearTasks: () => void
  setActiveProvider: (provider: ProviderConfig | null) => void
}

const DEFAULT_AGENTS: Agent[] = [
  {
    id: 'planner',
    name: '规划师',
    nameKey: 'agentSwarm.defaultAgents.planner',
    role: 'planner',
    roleKey: 'agentSwarm.defaultRoles.planner',
    systemPrompt:
      '你是任务规划专家。分析用户需求，制定执行计划，将复杂任务分解为可执行的子任务，并分派给其他专业 Agent。只输出计划，不执行具体业务操作。',
    model: 'gpt-4o',
    provider: 'OpenAI',
    color: '#6366f1',
    icon: '📋',
    isActive: true,
  },
  {
    id: 'analyst',
    name: '数据分析师',
    nameKey: 'agentSwarm.defaultAgents.analyst',
    role: 'analyst',
    roleKey: 'agentSwarm.defaultRoles.analyst',
    systemPrompt:
      '你是工业数据分析专家。擅长分析 MES 数据、生产报表、质量统计。使用工具查询数据库，进行数据分析和趋势预测。输出结构化分析结果。',
    model: 'gpt-4o',
    provider: 'OpenAI',
    color: '#10b981',
    icon: '📊',
    isActive: true,
  },
  {
    id: 'coder',
    name: '程序员',
    nameKey: 'agentSwarm.defaultAgents.coder',
    role: 'coder',
    roleKey: 'agentSwarm.defaultRoles.coder',
    systemPrompt:
      '你是编程专家。编写、调试、优化代码，处理数据、生成图表、自动化任务。输出可运行的代码和详细结果说明。',
    model: 'gpt-4o',
    provider: 'OpenAI',
    color: '#f59e0b',
    icon: '💻',
    isActive: true,
  },
  {
    id: 'researcher',
    name: '研究员',
    nameKey: 'agentSwarm.defaultAgents.researcher',
    role: 'researcher',
    roleKey: 'agentSwarm.defaultRoles.researcher',
    systemPrompt:
      '你是信息检索与知识整合专家。基于已有知识和资料进行分析推理，整理成结构化报告。输出清晰、有据可查的研究结论。',
    model: 'gpt-4o',
    provider: 'OpenAI',
    color: '#8b5cf6',
    icon: '🔍',
    isActive: true,
  },
  {
    id: 'writer',
    name: '文档撰写员',
    nameKey: 'agentSwarm.defaultAgents.writer',
    role: 'writer',
    roleKey: 'agentSwarm.defaultRoles.writer',
    systemPrompt:
      '你是技术文档撰写专家。将分析结果、代码输出、研究资料整合成清晰、专业的文档和报告。使用 Markdown 格式，结构清晰。',
    model: 'gpt-4o',
    provider: 'OpenAI',
    color: '#ec4899',
    icon: '✍️',
    isActive: true,
  },
  {
    id: 'reviewer',
    name: '审查员',
    nameKey: 'agentSwarm.defaultAgents.reviewer',
    role: 'reviewer',
    roleKey: 'agentSwarm.defaultRoles.reviewer',
    systemPrompt:
      '你是质量审查与校验专家。检查其他 Agent 的输出是否准确、完整、一致，发现错误、遗漏和潜在风险，并给出改进建议。',
    model: 'gpt-4o',
    provider: 'OpenAI',
    color: '#ef4444',
    icon: '🔎',
    isActive: true,
  },
  {
    id: 'explorer',
    name: '探索者',
    nameKey: 'agentSwarm.defaultAgents.explorer',
    role: 'explorer',
    roleKey: 'agentSwarm.defaultRoles.explorer',
    systemPrompt:
      '你是探索与发现专家。在信息不完整或路径不明时，通过试探、搜索、总结来摸清问题边界，为后续 Agent 提供清晰的方向和上下文。',
    model: 'gpt-4o',
    provider: 'OpenAI',
    color: '#06b6d4',
    icon: '🧭',
    isActive: true,
  },
  {
    id: 'designer',
    name: '设计师',
    nameKey: 'agentSwarm.defaultAgents.designer',
    role: 'designer',
    roleKey: 'agentSwarm.defaultRoles.designer',
    systemPrompt:
      '你是交互与视觉设计专家。负责产出界面原型、设计规范、可视化方案和设计建议。注重可用性、一致性与用户体验。',
    model: 'gpt-4o',
    provider: 'OpenAI',
    color: '#d946ef',
    icon: '🎨',
    isActive: true,
  },
  {
    id: 'product_manager',
    name: '产品经理',
    nameKey: 'agentSwarm.defaultAgents.product_manager',
    role: 'product_manager',
    roleKey: 'agentSwarm.defaultRoles.product_manager',
    systemPrompt:
      '你是产品管理专家。从用户需求、业务价值、可行性等角度评估方案，梳理产品功能优先级，输出清晰的产品建议和需求文档。',
    model: 'gpt-4o',
    provider: 'OpenAI',
    color: '#f97316',
    icon: '📦',
    isActive: true,
  },
]

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function agentToSubAgentConfig(agent: Agent): SubAgentConfig {
  return {
    name: agent.name,
    role: agent.role as AgentRole,
    systemPrompt: agent.systemPrompt,
  }
}

export const useAgentSwarmStore = create<AgentSwarmState>()(
  persist(
    (set, get) => ({
      agents: DEFAULT_AGENTS,
      swarmConfig: createDefaultSwarmConfig(),
      selectedPreset: null,
      messages: [],
      tasks: [],
      isRunning: false,
      currentTaskId: null,
      abortController: null,
      lastExecutionResult: null,
      activeProvider: null,

      addAgent: (agent) => {
        set((state) => ({
          agents: [...state.agents, { ...agent, id: generateId() }],
        }))
      },

      removeAgent: (id) => {
        set((state) => ({
          agents: state.agents.filter((a) => a.id !== id),
        }))
      },

      updateAgent: (id, updates) => {
        set((state) => ({
          agents: state.agents.map((a) => (a.id === id ? { ...a, ...updates } : a)),
        }))
      },

      toggleAgent: (id) => {
        set((state) => ({
          agents: state.agents.map((a) => (a.id === id ? { ...a, isActive: !a.isActive } : a)),
        }))
      },

      loadPreset: (name) => {
        const config = loadPresetBase(name)
        set({
          swarmConfig: config,
          selectedPreset: name,
        })
      },

      setSwarmConfig: (partial) => {
        set((state) => ({
          swarmConfig: { ...state.swarmConfig, ...partial },
          selectedPreset: null,
        }))
      },

      setOrchestratorConfig: (partial) => {
        set((state) => ({
          swarmConfig: {
            ...state.swarmConfig,
            orchestrator: { ...state.swarmConfig.orchestrator, ...partial },
          },
          selectedPreset: null,
        }))
      },

      resetSwarmConfig: () => {
        set({
          swarmConfig: createDefaultSwarmConfig(),
          selectedPreset: null,
        })
      },

      estimateCriticalSteps: (numSubAgents, avgSteps, orchestratorSteps, mode) => {
        return estimateCriticalStepsBase(numSubAgents, avgSteps, orchestratorSteps, mode)
      },

      addMessage: (msg) => {
        const fullMsg: AgentMessage = {
          ...msg,
          id: generateId(),
          timestamp: Date.now(),
        }
        set((state) => {
          const nextMessages = [...state.messages, fullMsg]
          if (nextMessages.length > 200) {
            nextMessages.splice(0, nextMessages.length - 200)
          }
          return { messages: nextMessages }
        })
      },

      addTask: (task) => {
        const fullTask: SwarmTask = {
          ...task,
          id: generateId(),
          createdAt: Date.now(),
        }
        set((state) => ({
          tasks: [...state.tasks, fullTask],
        }))
        return fullTask.id
      },

      updateTask: (id, updates) => {
        set((state) => ({
          tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        }))
      },

      runAgent: async (agentId, task, context = '', signal) => {
        const { agents, activeProvider, addMessage } = get()
        const agent = agents.find((a) => a.id === agentId)
        if (!agent || !agent.isActive) return ''
        if (signal?.aborted) return ''

        let provider = activeProvider
        if (!provider) {
          try {
            const { useChatStore } = await import('@/stores/chatStore')
            provider = useChatStore.getState().activeProvider
          } catch {
            // ignore import error
          }
        }
        if (!provider) {
          addMessage({
            agentId: agent.id,
            agentName: agent.name,
            role: agent.role,
            content: '未配置 AI 提供商，请先选择模型',
            type: 'result',
          })
          return ''
        }

        if (signal?.aborted) return ''

        addMessage({
          agentId: agent.id,
          agentName: agent.name,
          role: agent.role,
          content: `开始执行任务: ${task}`,
          type: 'action',
        })

        try {
          const messages: Message[] = [
            { role: 'system' as const, content: agent.systemPrompt },
            ...(context ? [{ role: 'user' as const, content: `上下文信息:\n${context}` }] : []),
            { role: 'user' as const, content: task },
          ]

          let result = ''
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error('已取消'))
              return
            }
            const abort = chatApi.streamChat(
              {
                provider: provider!.provider.toLowerCase(),
                model: provider!.model,
                baseUrl: provider!.baseUrl,
                messages,
              },
              (chunk) => {
                if (signal?.aborted) return
                if (chunk.type === 'content' && chunk.content) {
                  result += chunk.content
                }
              },
              (error) => {
                if (signal?.aborted) return
                addMessage({
                  agentId: agent.id,
                  agentName: agent.name,
                  role: agent.role,
                  content: `执行出错: ${error.message}`,
                  type: 'result',
                })
                reject(error)
              },
              () => {
                if (signal?.aborted) return
                addMessage({
                  agentId: agent.id,
                  agentName: agent.name,
                  role: agent.role,
                  content: result || '完成',
                  type: 'result',
                })
                resolve()
              }
            )
            if (signal) {
              signal.addEventListener(
                'abort',
                () => {
                  abort()
                  reject(new Error('已取消'))
                },
                { once: true }
              )
            }
          })

          return result
        } catch (err) {
          if ((err as Error).message === '已取消') return ''
          const errorMsg = err instanceof Error ? err.message : '未知错误'
          addMessage({
            agentId: agent.id,
            agentName: agent.name,
            role: agent.role,
            content: `执行失败: ${errorMsg}`,
            type: 'result',
          })
          return ''
        }
      },

      delegate: async (fromAgentId, toAgentId, task, signal) => {
        const { agents, addMessage, runAgent } = get()
        const fromAgent = agents.find((a) => a.id === fromAgentId)
        const toAgent = agents.find((a) => a.id === toAgentId)

        if (!fromAgent || !toAgent || signal?.aborted) return undefined

        addMessage({
          agentId: fromAgent.id,
          agentName: fromAgent.name,
          role: fromAgent.role,
          content: `委派任务给 ${toAgent.name}: ${task}`,
          type: 'delegate',
        })

        const result = await runAgent(toAgentId, task, '', signal)

        if (!signal?.aborted) {
          addMessage({
            agentId: toAgent.id,
            agentName: toAgent.name,
            role: toAgent.role,
            content: `任务完成，返回结果给 ${fromAgent.name}`,
            type: 'result',
          })
        }

        return result
      },

      runSwarm: async (taskDescription) => {
        const activeAgents = get().agents.filter((a) => a.isActive)
        if (activeAgents.length === 0) return

        const controller = new AbortController()
        set({ isRunning: true, currentTaskId: null, abortController: controller })

        try {
          const result = await executeSwarm(
            get().swarmConfig,
            get().agents,
            taskDescription,
            controller.signal,
            {
              addMessage: get().addMessage,
              addTask: get().addTask,
              updateTask: get().updateTask,
              getProvider: () => get().activeProvider || useChatStore.getState().activeProvider,
              getSkillPrompts: (taskDescription) => {
                const skillStore = useSkillStore.getState()
                const activeSkills = skillStore.getActiveSkillsForMessage(taskDescription)
                const manualSkills = skillStore.activeSkillIds
                  .map((id) => skillStore.skills.find((s) => s.id === id))
                  .filter(Boolean) as SkillManifest[]
                const merged = [...new Map([...activeSkills, ...manualSkills].map((s) => [s.id, s])).values()]
                return merged.map((s) => `## [Skill: ${s.name}]\n${s.prompt}`)
              },
              getMemories: (task) =>
                useMemoryStore.getState().searchMemories(task, 3).map((m) => m.content),
            }
          )
          set({ lastExecutionResult: result })
        } finally {
          set({ isRunning: false, currentTaskId: null, abortController: null })
        }
      },

      stopSwarm: () => {
        const { abortController } = get()
        abortController?.abort()
        set({ isRunning: false, currentTaskId: null, abortController: null })
      },

      clearMessages: () => set({ messages: [] }),
      clearTasks: () => set({ tasks: [] }),
      setActiveProvider: (provider) => set({ activeProvider: provider }),
    }),
    {
      name: 'wonclaw-agent-swarm',
      partialize: (state) => ({
        agents: state.agents,
        swarmConfig: state.swarmConfig,
        selectedPreset: state.selectedPreset,
      }),
    }
  )
)

// Re-export types for convenience
export type { AgentSwarmConfig, SubAgentConfig }
export { agentToSubAgentConfig }

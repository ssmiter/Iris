import { chatApi } from '@/api/client'
import { useUsageStore, buildTodayUsageRecord } from '@/stores/usageStore'
import type { Message, ProviderConfig } from '@/types/mescli'
import type {
  AgentRole,
  AgentSwarmConfig,
  ContextStrategy,
  ExecutionResult,
  ParallelMode,
  SubTaskDefinition,
  SubTaskResult,
  SwarmTaskStatus,
  TokenBudget,
} from '@/types/agentSwarm'
import { estimateCriticalSteps } from '@/types/agentSwarm'
import type { Agent, AgentMessage, SwarmTask } from '@/stores/agentSwarmStore'
import { buildTopologicalWaves } from '@/utils/dagTopology'

export interface SwarmCallbacks {
  addMessage: (msg: Omit<AgentMessage, 'id' | 'timestamp'>) => void
  addTask: (task: Omit<SwarmTask, 'id' | 'createdAt'>) => string
  updateTask: (id: string, updates: Partial<SwarmTask>) => void
  getProvider: () => ProviderConfig | null
  getSkillPrompts?: (taskDescription: string) => string[]
  getMemories?: (taskDescription: string) => string[]
}

interface ParsedPlan {
  subTasks: SubTaskDefinition[]
  summaryContext?: string
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function pickAgentForSubTask(subTask: SubTaskDefinition, agents: Agent[]): Agent | undefined {
  const activeAgents = agents.filter((a) => a.isActive)
  if (subTask.assignedAgentName) {
    const byName = activeAgents.find(
      (a) => a.name.toLowerCase() === subTask.assignedAgentName!.toLowerCase()
    )
    if (byName) return byName
  }
  if (subTask.assignedRole) {
    const byRole = activeAgents.find((a) => a.role.toLowerCase() === subTask.assignedRole!.toLowerCase())
    if (byRole) return byRole
  }
  return undefined
}

function getAgentSystemPrompt(agent: Agent, skillPrompts: string[]): string {
  if (skillPrompts.length === 0) return agent.systemPrompt
  return `${agent.systemPrompt}\n\n${skillPrompts.join('\n\n')}`
}

function parsePlanJson(text: string): ParsedPlan | null {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = codeBlock ? codeBlock[1].trim() : text.trim()
  try {
    const parsed = JSON.parse(jsonText)
    if (Array.isArray(parsed.subTasks)) {
      return {
        subTasks: parsed.subTasks.map((st: Record<string, unknown>) => ({
          subTaskId: String(st.subTaskId || generateId()),
          title: String(st.title || st.description || 'sub-task').slice(0, 80),
          description: String(st.description || ''),
          assignedRole: st.assignedRole ? String(st.assignedRole) : undefined,
          assignedAgentName: st.assignedAgentName ? String(st.assignedAgentName) : undefined,
          dependencies: Array.isArray(st.dependencies)
            ? st.dependencies.map(String)
            : undefined,
          stage: st.stage ? String(st.stage) : undefined,
          contextShard: st.contextShard ? String(st.contextShard) : undefined,
          expectedOutputFormat: st.expectedOutputFormat ? String(st.expectedOutputFormat) : undefined,
        })),
        summaryContext: parsed.summaryContext ? String(parsed.summaryContext) : undefined,
      }
    }
  } catch {
    // ignore parse error
  }
  return null
}

function parseVerificationJson(text: string): { passed: boolean; issues: string[] } | null {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = codeBlock ? codeBlock[1].trim() : text.trim()
  try {
    const parsed = JSON.parse(jsonText)
    if (typeof parsed.passed === 'boolean') {
      return {
        passed: parsed.passed,
        issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
      }
    }
  } catch {
    // ignore parse error
  }
  return null
}

function buildFallbackPlan(taskDescription: string, agents: Agent[]): ParsedPlan {
  const activeAgents = agents.filter((a) => a.isActive && a.role !== 'planner')
  return {
    subTasks: activeAgents.map((agent) => ({
      subTaskId: generateId(),
      title: `${agent.role} task`,
      description: `作为 ${agent.role}，请完成以下任务：\n\n${taskDescription}`,
      assignedRole: agent.role as AgentRole,
      assignedAgentName: agent.name,
      stage: '1',
    })),
  }
}

async function callOrchestrator(
  config: AgentSwarmConfig,
  taskDescription: string,
  agents: Agent[],
  provider: ProviderConfig,
  signal: AbortSignal,
  addMessage: SwarmCallbacks['addMessage']
): Promise<ParsedPlan> {
  const planner = agents.find((a) => a.role === 'planner' && a.isActive)
  const systemPrompt = planner
    ? getAgentSystemPrompt(planner, [])
    : 'You are an orchestrator for an Agent Swarm. Your job is to decompose a user task into sub-tasks and produce a JSON execution plan.'

  const agentCatalog = agents
    .filter((a) => a.isActive)
    .map((a) => `- ${a.role}: ${a.name}`)
    .join('\n')

  const parallelMode = config.orchestrator.parallelMode

  const userPrompt = `请为以下任务制定执行计划。

任务描述：
${taskDescription}

可用 Agent 角色：
${agentCatalog || '- custom'}

并行模式：${parallelMode}
最大子 Agent 数：${config.orchestrator.maxSubAgents}

请只输出一个 JSON 对象（可包裹在 markdown code block 中），格式如下：
{
  "subTasks": [
    {
      "subTaskId": "唯一 ID",
      "title": "简短标题",
      "description": "详细任务描述",
      "assignedRole": "从可用角色中选择一个，例如 researcher",
      "stage": "pipeline 模式时使用阶段编号，例如 1",
      "dependencies": [],
      "contextShard": "该子任务需要的上下文片段"
    }
  ],
  "summaryContext": "所有子任务共享的摘要上下文"
}

如果不需要复杂拆分，可以只输出 1-3 个子任务。务必确保 JSON 合法。`

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]

  let planText = ''
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('已取消'))
      return
    }
    const abort = chatApi.streamChat(
      {
        provider: provider.provider.toLowerCase(),
        model: provider.model,
        baseUrl: provider.baseUrl,
        messages,
      },
      (chunk) => {
        if (signal.aborted) return
        if (chunk.type === 'content' && chunk.content) {
          planText += chunk.content
        }
      },
      (error) => {
        if (signal.aborted) return
        reject(error)
      },
      () => {
        if (signal.aborted) return
        resolve()
      }
    )
    signal.addEventListener(
      'abort',
      () => {
        abort()
        reject(new Error('已取消'))
      },
      { once: true }
    )
  })

  const parsed = parsePlanJson(planText)
  if (parsed) {
    addMessage({
      agentId: planner?.id || 'orchestrator',
      agentName: planner?.name || 'Orchestrator',
      role: 'orchestrator',
      content: `已制定执行计划，共 ${parsed.subTasks.length} 个子任务。`,
      type: 'system',
    })
    return parsed
  }

  addMessage({
    agentId: planner?.id || 'orchestrator',
    agentName: planner?.name || 'Orchestrator',
    role: 'orchestrator',
    content: 'Orchestrator 输出格式不符合预期，使用降级方案。',
    type: 'system',
  })
  return buildFallbackPlan(taskDescription, agents)
}

function estimateContextTokens(text: string): number {
  // 简单字符估算：1 token ≈ 4 个英文字符/字节，对中文更宽松
  return Math.ceil(text.length / 4)
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateContextTokens(text) <= maxTokens) return text
  const targetChars = Math.max(0, maxTokens * 4)
  const marker = '\n\n[...truncated]'
  return text.slice(0, Math.max(0, targetChars - marker.length)) + marker
}

function buildSubAgentMessages(
  subTask: SubTaskDefinition,
  plan: ParsedPlan,
  taskDescription: string,
  contextStrategy: ContextStrategy,
  tokenBudget: TokenBudget,
  systemPrompt: string
): Message[] {
  const messages: Message[] = [{ role: 'system', content: systemPrompt }]

  switch (contextStrategy) {
    case 'sharding': {
      const shard = subTask.contextShard || plan.summaryContext || taskDescription
      messages.push({
        role: 'user',
        content: `任务背景（仅与本子任务相关）：\n${truncateToTokens(shard, tokenBudget.shardSize)}`,
      })
      break
    }
    case 'summary': {
      const summary = plan.summaryContext || taskDescription
      messages.push({
        role: 'user',
        content: `任务摘要：\n${truncateToTokens(summary, tokenBudget.reservedForSummary)}`,
      })
      break
    }
    case 'full_context':
    case 'hide_tools': {
      const full = `任务描述：\n${taskDescription}\n\n执行计划摘要：\n${plan.summaryContext || ''}`
      messages.push({
        role: 'user',
        content: truncateToTokens(full, Math.floor(tokenBudget.maxContextLength / 2)),
      })
      break
    }
    case 'discard_all':
      // 不注入任何全局上下文，仅保留子任务描述
      break
    default:
      break
  }

  messages.push({ role: 'user', content: `你的子任务：\n${subTask.description}` })
  return messages
}

async function runSingleSubAgent(
  subTask: SubTaskDefinition,
  agent: Agent,
  config: AgentSwarmConfig,
  provider: ProviderConfig,
  plan: ParsedPlan,
  taskDescription: string,
  signal: AbortSignal,
  callbacks: SwarmCallbacks,
  attempt = 0
): Promise<SubTaskResult> {
  const { addMessage, updateTask, getSkillPrompts } = callbacks
  const skillPrompts = getSkillPrompts ? getSkillPrompts(taskDescription) : []
  const systemPrompt = getAgentSystemPrompt(agent, skillPrompts)

  const subTaskTaskId = callbacks.addTask({
    title: subTask.title,
    description: subTask.description,
    status: 'running',
    assignedAgent: agent.name,
  })

  const startTime = Date.now()
  let output = ''

  addMessage({
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    content: `开始执行子任务 [${subTask.title}]`,
    type: 'action',
  })

  const messages = buildSubAgentMessages(
    subTask,
    plan,
    taskDescription,
    config.orchestrator.contextStrategy,
    config.orchestrator.tokenBudget,
    systemPrompt
  )

  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('已取消'))
        return
      }
      const abort = chatApi.streamChat(
        {
          provider: provider.provider.toLowerCase(),
          model: provider.model,
          baseUrl: provider.baseUrl,
          messages,
        },
        (chunk) => {
          if (signal.aborted) return
          if (chunk.type === 'content' && chunk.content) {
            output += chunk.content
          }
        },
        (error) => {
          if (signal.aborted) return
          reject(error)
        },
        () => {
          if (signal.aborted) return
          resolve()
        }
      )
      signal.addEventListener(
        'abort',
        () => {
          abort()
          reject(new Error('已取消'))
        },
        { once: true }
      )
    })

    addMessage({
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      content: `子任务 [${subTask.title}] 完成。`,
      type: 'result',
    })

    callbacks.updateTask(subTaskTaskId, { status: 'completed', completedAt: Date.now() })

    return {
      subTaskId: subTask.subTaskId,
      agentName: agent.name,
      agentRole: agent.role as AgentRole,
      status: 'completed',
      output,
      executionTimeMs: Date.now() - startTime,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : '未知错误'

    if (errorMsg === '已取消') {
      callbacks.updateTask(subTaskTaskId, { status: 'cancelled' })
      return {
        subTaskId: subTask.subTaskId,
        agentName: agent.name,
        agentRole: agent.role as AgentRole,
        status: 'cancelled',
        errors: ['cancelled'],
      }
    }

    const maxRetries = config.orchestrator.maxRetries
    if (attempt < maxRetries && config.orchestrator.failoverStrategy !== 'skip') {
      addMessage({
        agentId: agent.id,
        agentName: agent.name,
        role: agent.role,
        content: `子任务 [${subTask.title}] 失败（${errorMsg}），正在进行第 ${attempt + 1} 次重试...`,
        type: 'system',
      })
      callbacks.updateTask(subTaskTaskId, { status: 'retrying' })
      return runSingleSubAgent(
        subTask,
        agent,
        config,
        provider,
        plan,
        taskDescription,
        signal,
        callbacks,
        attempt + 1
      )
    }

    addMessage({
      agentId: agent.id,
      agentName: agent.name,
      role: agent.role,
      content: `子任务 [${subTask.title}] 最终失败：${errorMsg}`,
      type: 'result',
    })

    callbacks.updateTask(subTaskTaskId, { status: 'failed' })

    return {
      subTaskId: subTask.subTaskId,
      agentName: agent.name,
      agentRole: agent.role as AgentRole,
      status: 'failed',
      errors: [errorMsg],
      executionTimeMs: Date.now() - startTime,
    }
  }
}

async function runWithConcurrencyLimit<T>(
  items: SubTaskDefinition[],
  limit: number,
  fn: (item: SubTaskDefinition) => Promise<T>
): Promise<T[]> {
  const results: T[] = []
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit)
    const batchResults = await Promise.all(batch.map(fn))
    results.push(...batchResults)
  }
  return results
}

async function executeFullParallel(
  plan: ParsedPlan,
  config: AgentSwarmConfig,
  agents: Agent[],
  taskDescription: string,
  signal: AbortSignal,
  callbacks: SwarmCallbacks
): Promise<SubTaskResult[]> {
  const maxConcurrent = config.maxConcurrentTasks || 6
  return runWithConcurrencyLimit(plan.subTasks, maxConcurrent, (subTask) => {
    if (signal.aborted) {
      return Promise.resolve({
        subTaskId: subTask.subTaskId,
        agentName: 'none',
        agentRole: subTask.assignedRole || 'custom',
        status: 'cancelled' as SwarmTaskStatus,
        errors: ['cancelled'],
      })
    }
    const agent = pickAgentForSubTask(subTask, agents)
    if (!agent) {
      callbacks.addMessage({
        agentId: 'orchestrator',
        agentName: 'Orchestrator',
        role: 'orchestrator',
        content: `未找到匹配 Agent 执行子任务 [${subTask.title}]，已跳过。`,
        type: 'system',
      })
      return Promise.resolve({
        subTaskId: subTask.subTaskId,
        agentName: 'none',
        agentRole: subTask.assignedRole || 'custom',
        status: 'failed' as SwarmTaskStatus,
        errors: ['no matching agent'],
      })
    }
    return runSingleSubAgent(subTask, agent, config, callbacks.getProvider()!, plan, taskDescription, signal, callbacks)
  })
}

async function executePipeline(
  plan: ParsedPlan,
  config: AgentSwarmConfig,
  agents: Agent[],
  taskDescription: string,
  signal: AbortSignal,
  callbacks: SwarmCallbacks
): Promise<SubTaskResult[]> {
  const groups = new Map<string, SubTaskDefinition[]>()
  for (const st of plan.subTasks) {
    const stage = st.stage || '1'
    if (!groups.has(stage)) groups.set(stage, [])
    groups.get(stage)!.push(st)
  }
  const sortedStages = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b))

  const allResults: SubTaskResult[] = []
  for (const stage of sortedStages) {
    if (signal.aborted) break
    callbacks.addMessage({
      agentId: 'orchestrator',
      agentName: 'Orchestrator',
      role: 'orchestrator',
      content: `进入流水线阶段 ${stage}`,
      type: 'system',
    })
    const stageTasks = groups.get(stage)!
    const stageResults = await executeFullParallel(
      { subTasks: stageTasks, summaryContext: plan.summaryContext },
      config,
      agents,
      taskDescription,
      signal,
      callbacks
    )
    allResults.push(...stageResults)
  }
  return allResults
}

async function executeMapReduce(
  plan: ParsedPlan,
  config: AgentSwarmConfig,
  agents: Agent[],
  taskDescription: string,
  signal: AbortSignal,
  callbacks: SwarmCallbacks
): Promise<SubTaskResult[]> {
  const mapTasks = plan.subTasks.filter((st) => (st.assignedRole || '').toLowerCase() !== 'reducer')
  const reduceTasks = plan.subTasks.filter((st) => (st.assignedRole || '').toLowerCase() === 'reducer')

  const mapResults = await executeFullParallel(
    { subTasks: mapTasks, summaryContext: plan.summaryContext },
    config,
    agents,
    taskDescription,
    signal,
    callbacks
  )

  if (signal.aborted) return mapResults

  const mapOutputs = mapResults
    .filter((r) => r.status === 'completed' && r.output)
    .map((r) => `## ${r.agentName}\n${r.output}`)
    .join('\n\n---\n\n')

  if (reduceTasks.length === 0) {
    // 自动生成一个 reduce 子任务
    reduceTasks.push({
      subTaskId: generateId(),
      title: 'Reduce results',
      description: `请将以下各 Map 子任务的结果汇总、去重并生成最终结论：\n\n${mapOutputs}`,
      assignedRole: 'analyst',
    })
  }

  const reducePlan: ParsedPlan = {
    subTasks: reduceTasks.map((st) => ({
      ...st,
      description: `${st.description}\n\n${mapOutputs}`,
    })),
    summaryContext: plan.summaryContext,
  }

  const reduceResults = await executeFullParallel(
    reducePlan,
    config,
    agents,
    taskDescription,
    signal,
    callbacks
  )

  return [...mapResults, ...reduceResults]
}

async function executeDag(
  plan: ParsedPlan,
  config: AgentSwarmConfig,
  agents: Agent[],
  taskDescription: string,
  signal: AbortSignal,
  callbacks: SwarmCallbacks
): Promise<SubTaskResult[]> {
  const waves = buildTopologicalWaves(plan.subTasks, (st) => st.subTaskId, (st) => st.dependencies || [])

  const allResults: SubTaskResult[] = []
  for (let i = 0; i < waves.length; i++) {
    if (signal.aborted) break
    callbacks.addMessage({
      agentId: 'orchestrator',
      agentName: 'Orchestrator',
      role: 'orchestrator',
      content: `执行 DAG 第 ${i + 1} 层，共 ${waves[i].length} 个子任务`,
      type: 'system',
    })
    const waveResults = await executeFullParallel(
      { subTasks: waves[i], summaryContext: plan.summaryContext },
      config,
      agents,
      taskDescription,
      signal,
      callbacks
    )
    allResults.push(...waveResults)
  }
  return allResults
}

async function executeAdaptive(
  plan: ParsedPlan,
  config: AgentSwarmConfig,
  agents: Agent[],
  taskDescription: string,
  signal: AbortSignal,
  callbacks: SwarmCallbacks
): Promise<SubTaskResult[]> {
  const initialResults = await executeFullParallel(plan, config, agents, taskDescription, signal, callbacks)
  if (signal.aborted) return initialResults

  const failedResults = initialResults.filter((r) => r.status === 'failed')
  const failureRate = initialResults.length > 0 ? failedResults.length / initialResults.length : 0
  const threshold = 0.3

  if (failedResults.length > 0 && failureRate >= threshold) {
    callbacks.addMessage({
      agentId: 'orchestrator',
      agentName: 'Orchestrator',
      role: 'orchestrator',
      content: `检测到失败率 ${Math.round(failureRate * 100)}%，切换到 Pipeline 模式重试失败的子任务。`,
      type: 'system',
    })

    const failedSubTaskIds = new Set(failedResults.map((r) => r.subTaskId))
    const retryPlan: ParsedPlan = {
      subTasks: plan.subTasks.filter((st) => failedSubTaskIds.has(st.subTaskId)),
      summaryContext: plan.summaryContext,
    }
    const retryConfig = { ...config, maxConcurrentTasks: 1 }
    const retryResults = await executeFullParallel(retryPlan, retryConfig, agents, taskDescription, signal, callbacks)

    const retryMap = new Map(retryResults.map((r) => [r.subTaskId, r]))
    return initialResults.map((r) => retryMap.get(r.subTaskId) || r)
  }

  return initialResults
}

async function verifyResults(
  results: SubTaskResult[],
  config: AgentSwarmConfig,
  agents: Agent[],
  taskDescription: string,
  signal: AbortSignal,
  callbacks: SwarmCallbacks
): Promise<{ passed: boolean; issues: string[] }> {
  const completed = results.filter((r) => r.status === 'completed' && r.output)
  if (completed.length < 2) {
    return { passed: true, issues: [] }
  }

  const reviewer = agents.find((a) => a.role === 'reviewer' && a.isActive)
  const systemPrompt = reviewer
    ? getAgentSystemPrompt(reviewer, [])
    : 'You are a cross-verification agent. Review multiple sub-agent outputs and identify contradictions, inconsistencies, missing information, or quality issues. Output a JSON object with fields passed (boolean) and issues (array of strings).'

  const provider = callbacks.getProvider()
  if (!provider) {
    return { passed: false, issues: ['未配置 AI 提供商，无法执行交叉验证'] }
  }

  const combined = completed
    .map((r) => `## ${r.agentName} (${r.agentRole})\n${r.output}`)
    .join('\n\n---\n\n')

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `原始任务：\n${taskDescription}\n\n各子任务结果如下：\n\n${combined}\n\n请检查上述结果是否存在矛盾、不一致、遗漏或质量问题。只输出 JSON（可包裹在 markdown code block 中）：\n{\n  "passed": true,\n  "issues": []\n}`,
    },
  ]

  let verifyText = ''
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('已取消'))
        return
      }
      const abort = chatApi.streamChat(
        {
          provider: provider.provider.toLowerCase(),
          model: provider.model,
          baseUrl: provider.baseUrl,
          messages,
        },
        (chunk) => {
          if (signal.aborted) return
          if (chunk.type === 'content' && chunk.content) {
            verifyText += chunk.content
          }
        },
        (error) => {
          if (signal.aborted) return
          reject(error)
        },
        () => {
          if (signal.aborted) return
          resolve()
        }
      )
      signal.addEventListener(
        'abort',
        () => {
          abort()
          reject(new Error('已取消'))
        },
        { once: true }
      )
    })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : '验证失败'
    if (errorMsg === '已取消') {
      return { passed: false, issues: ['cross verification cancelled'] }
    }
    callbacks.addMessage({
      agentId: reviewer?.id || 'reviewer',
      agentName: reviewer?.name || 'Verifier',
      role: reviewer?.role || 'reviewer',
      content: `交叉验证调用失败：${errorMsg}`,
      type: 'system',
    })
    return { passed: false, issues: [errorMsg] }
  }

  const parsed = parseVerificationJson(verifyText)
  if (parsed) {
    callbacks.addMessage({
      agentId: reviewer?.id || 'reviewer',
      agentName: reviewer?.name || 'Verifier',
      role: reviewer?.role || 'reviewer',
      content: parsed.passed
        ? '交叉验证通过，未发现明显问题。'
        : `交叉验证发现问题：\n${parsed.issues.map((issue) => `- ${issue}`).join('\n')}`,
      type: 'system',
    })
    return parsed
  }

  // 解析失败时默认通过，避免阻塞聚合
  return { passed: true, issues: [] }
}

async function mergeResults(
  results: SubTaskResult[],
  config: AgentSwarmConfig,
  agents: Agent[],
  taskDescription: string,
  signal: AbortSignal,
  callbacks: SwarmCallbacks
): Promise<string> {
  const completed = results.filter((r) => r.status === 'completed' && r.output)
  if (completed.length === 0) {
    return '所有子任务均未返回有效结果，无法生成最终输出。'
  }

  const writer = agents.find((a) => a.role === 'writer' && a.isActive)
  const systemPrompt = writer
    ? getAgentSystemPrompt(writer, [])
    : 'You are a synthesis agent. Merge sub-task results into a coherent final answer.'

  const provider = callbacks.getProvider()
  if (!provider) return '未配置 AI 提供商，无法聚合结果。'

  const combined = completed.map((r) => `## ${r.agentName} (${r.agentRole})\n${r.output}`).join('\n\n---\n\n')

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `原始任务：\n${taskDescription}\n\n各子任务结果：\n\n${combined}\n\n请整合以上结果，输出一份完整、结构清晰的最终报告。` },
  ]

  let finalOutput = ''
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('已取消'))
      return
    }
    const abort = chatApi.streamChat(
      {
        provider: provider.provider.toLowerCase(),
        model: provider.model,
        baseUrl: provider.baseUrl,
        messages,
      },
      (chunk) => {
        if (signal.aborted) return
        if (chunk.type === 'content' && chunk.content) {
          finalOutput += chunk.content
        }
      },
      (error) => {
        if (signal.aborted) return
        reject(error)
      },
      () => {
        if (signal.aborted) return
        resolve()
      }
    )
    signal.addEventListener(
      'abort',
      () => {
        abort()
        reject(new Error('已取消'))
      },
      { once: true }
    )
  })

  callbacks.addMessage({
    agentId: writer?.id || 'writer',
    agentName: writer?.name || 'Synthesis Agent',
    role: writer?.role || 'writer',
    content: finalOutput,
    type: 'final',
  })

  return finalOutput
}

export async function executeSwarm(
  config: AgentSwarmConfig,
  agents: Agent[],
  taskDescription: string,
  signal: AbortSignal,
  callbacks: SwarmCallbacks
): Promise<ExecutionResult> {
  const startTime = Date.now()
  const { addMessage, addTask, updateTask, getProvider, getMemories } = callbacks

  const provider = getProvider()
  if (!provider) {
    addMessage({
      agentId: 'orchestrator',
      agentName: 'Orchestrator',
      role: 'orchestrator',
      content: '未配置 AI 提供商，请先选择模型',
      type: 'system',
    })
    return {
      taskId: generateId(),
      status: 'failed',
      finalOutput: '未配置 AI 提供商',
      totalExecutionTimeMs: 0,
    }
  }

  const mainTaskId = addTask({
    title: taskDescription.slice(0, 50),
    description: taskDescription,
    status: 'planning',
  })

  const memories = getMemories ? getMemories(taskDescription) : []
  const enhancedTask =
    memories.length > 0
      ? `${taskDescription}\n\n【相关背景记忆】\n${memories.map((m) => `- ${m}`).join('\n')}`
      : taskDescription

  try {
    // 规划
    const plan = await callOrchestrator(config, enhancedTask, agents, provider, signal, addMessage)

    if (signal.aborted) {
      updateTask(mainTaskId, { status: 'cancelled' })
      return { taskId: mainTaskId, status: 'cancelled', totalExecutionTimeMs: Date.now() - startTime }
    }

    // 限制子任务数量
    if (plan.subTasks.length > config.orchestrator.maxSubAgents) {
      plan.subTasks = plan.subTasks.slice(0, config.orchestrator.maxSubAgents)
      addMessage({
        agentId: 'orchestrator',
        agentName: 'Orchestrator',
        role: 'orchestrator',
        content: `子任务数量超过最大限制，已截断至 ${config.orchestrator.maxSubAgents} 个。`,
        type: 'system',
      })
    }

    updateTask(mainTaskId, { status: 'running' })

    // 调度执行
    let results: SubTaskResult[] = []
    switch (config.orchestrator.parallelMode) {
      case 'full_parallel':
        results = await executeFullParallel(plan, config, agents, enhancedTask, signal, callbacks)
        break
      case 'adaptive':
        results = await executeAdaptive(plan, config, agents, enhancedTask, signal, callbacks)
        break
      case 'pipeline':
        results = await executePipeline(plan, config, agents, enhancedTask, signal, callbacks)
        break
      case 'map_reduce':
        results = await executeMapReduce(plan, config, agents, enhancedTask, signal, callbacks)
        break
      case 'dag':
        results = await executeDag(plan, config, agents, enhancedTask, signal, callbacks)
        break
      default:
        results = await executeFullParallel(plan, config, agents, enhancedTask, signal, callbacks)
    }

    if (signal.aborted) {
      updateTask(mainTaskId, { status: 'cancelled' })
      return { taskId: mainTaskId, status: 'cancelled', totalExecutionTimeMs: Date.now() - startTime }
    }

    // 交叉验证
    let crossVerificationPassed: boolean | undefined = undefined
    let verificationIssues: string[] = []
    if (config.orchestrator.enableCrossVerification) {
      updateTask(mainTaskId, { status: 'verifying' })
      const verifyOutcome = await verifyResults(results, config, agents, enhancedTask, signal, callbacks)
      if (signal.aborted) {
        updateTask(mainTaskId, { status: 'cancelled' })
        return { taskId: mainTaskId, status: 'cancelled', totalExecutionTimeMs: Date.now() - startTime }
      }
      crossVerificationPassed = verifyOutcome.passed
      verificationIssues = verifyOutcome.issues
    }

    // 聚合
    updateTask(mainTaskId, { status: 'merging' })
    const finalOutput = await mergeResults(results, config, agents, enhancedTask, signal, callbacks)

    if (signal.aborted) {
      updateTask(mainTaskId, { status: 'cancelled' })
      return { taskId: mainTaskId, status: 'cancelled', totalExecutionTimeMs: Date.now() - startTime }
    }

    const completedCount = results.filter((r) => r.status === 'completed').length
    const parallelismDegree =
      config.orchestrator.parallelMode === 'full_parallel'
        ? results.length
        : Math.ceil(results.length / 2)

    const executionResult: ExecutionResult = {
      taskId: mainTaskId,
      status: 'completed',
      finalOutput,
      subResults: results,
      totalSteps: results.reduce((sum, r) => sum + (r.executionSteps || 1), 0),
      totalTokensUsed: results.reduce((sum, r) => sum + (r.tokensUsed || 0), 0),
      totalExecutionTimeMs: Date.now() - startTime,
      parallelismDegree,
      criticalSteps: estimateCriticalSteps(
        results.length,
        10,
        config.orchestrator.maxSupervisionSteps,
        config.orchestrator.parallelMode
      ),
      crossVerificationPassed,
      verificationIssues,
      createdAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
    }

    updateTask(mainTaskId, { status: 'completed', completedAt: Date.now() })

    try {
      useUsageStore.getState().report(
        buildTodayUsageRecord({
          // Token 已在 chatApi.streamChat 层统计，此处仅记录一次 Swarm 执行
          apiCalls: 1,
        })
      )
    } catch {
      // 用量上报失败不影响执行结果
    }

    return executionResult
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : '执行失败'
    if (errorMsg === '已取消') {
      updateTask(mainTaskId, { status: 'cancelled' })
      return { taskId: mainTaskId, status: 'cancelled', totalExecutionTimeMs: Date.now() - startTime }
    }
    updateTask(mainTaskId, { status: 'failed' })
    addMessage({
      agentId: 'orchestrator',
      agentName: 'Orchestrator',
      role: 'orchestrator',
      content: `执行失败：${errorMsg}`,
      type: 'system',
    })
    return {
      taskId: mainTaskId,
      status: 'failed',
      finalOutput: errorMsg,
      totalExecutionTimeMs: Date.now() - startTime,
    }
  }
}

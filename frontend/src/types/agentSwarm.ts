/**
 * Agent Swarm 类型定义
 * 参考 Kimi Agent Swarm 设计文档适配到 WonWork 项目
 */

// ==================== 枚举 ====================

export type AgentRole =
  | 'orchestrator'
  | 'researcher'
  | 'writer'
  | 'coder'
  | 'reviewer'
  | 'analyst'
  | 'planner'
  | 'explorer'
  | 'designer'
  | 'product_manager'
  | 'custom'

export const AGENT_ROLES: AgentRole[] = [
  'orchestrator',
  'researcher',
  'writer',
  'coder',
  'reviewer',
  'analyst',
  'planner',
  'explorer',
  'designer',
  'product_manager',
  'custom',
]

export type SwarmTaskStatus =
  | 'pending'
  | 'planning'
  | 'assigned'
  | 'running'
  | 'verifying'
  | 'merging'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'cancelled'

export const SWARM_TASK_STATUSES: SwarmTaskStatus[] = [
  'pending',
  'planning',
  'assigned',
  'running',
  'verifying',
  'merging',
  'completed',
  'failed',
  'retrying',
  'cancelled',
]

export type ParallelMode =
  | 'full_parallel'
  | 'pipeline'
  | 'map_reduce'
  | 'dag'
  | 'adaptive'

export const PARALLEL_MODES: ParallelMode[] = [
  'full_parallel',
  'pipeline',
  'map_reduce',
  'dag',
  'adaptive',
]

export type ContextStrategy =
  | 'sharding'
  | 'summary'
  | 'hide_tools'
  | 'full_context'
  | 'discard_all'

export const CONTEXT_STRATEGIES: ContextStrategy[] = [
  'sharding',
  'summary',
  'hide_tools',
  'full_context',
  'discard_all',
]

export type FailoverStrategy = 'reassign' | 'escalate' | 'skip'

export type TaskType =
  | 'research'
  | 'writing'
  | 'coding'
  | 'analysis'
  | 'document_processing'
  | 'batch_processing'
  | 'multi_perspective'
  | 'custom'

export type OutputFormat =
  | 'markdown'
  | 'json'
  | 'html'
  | 'python'
  | 'typescript'
  | 'docx'
  | 'xlsx'
  | 'pdf'
  | 'pptx'

// ==================== Token 预算 ====================

export interface TokenBudget {
  maxContextLength: number
  maxOutputTokens: number
  reservedForSummary: number
  shardSize: number
}

// ==================== 子 Agent 配置 ====================

export interface SubAgentConfig {
  name: string
  role?: AgentRole
  description?: string
  systemPrompt?: string
  allowedTools?: string[]
  readOnly?: boolean
  noShell?: boolean
  contextStrategy?: ContextStrategy
  maxContextTokens?: number
  maxExecutionSteps?: number
  timeoutSeconds?: number
  autoRetryCount?: number
}

// ==================== Orchestrator 配置 ====================

export interface OrchestratorConfig {
  maxSubAgents: number
  maxTotalSteps: number
  maxSupervisionSteps: number
  decompositionDepth: number
  minSubTaskGranularity: number
  adaptiveDecomposition: boolean
  parallelMode: ParallelMode
  enableLoadBalancing: boolean
  enableCrossVerification: boolean
  contextStrategy: ContextStrategy
  tokenBudget: TokenBudget
  maxRetries: number
  failoverStrategy: FailoverStrategy
}

// ==================== 子任务与结果 ====================

export interface SubTaskDefinition {
  subTaskId: string
  title: string
  description: string
  assignedRole?: AgentRole
  assignedAgentName?: string
  dependencies?: string[]
  stage?: string
  contextShard?: string
  expectedOutputFormat?: OutputFormat
}

export interface SubTaskResult {
  subTaskId: string
  agentName: string
  agentRole: AgentRole
  status: SwarmTaskStatus
  output?: string
  executionSteps?: number
  tokensUsed?: number
  executionTimeMs?: number
  errors?: string[]
}

// ==================== 执行结果 ====================

export interface ExecutionResult {
  taskId: string
  status: SwarmTaskStatus
  finalOutput?: string
  outputFiles?: string[]
  subResults?: SubTaskResult[]
  totalSteps?: number
  totalTokensUsed?: number
  totalExecutionTimeMs?: number
  parallelismDegree?: number
  criticalSteps?: number
  crossVerificationPassed?: boolean
  verificationIssues?: string[]
  createdAt?: string
  completedAt?: string
}

// ==================== 任务定义 ====================

export interface SwarmTaskDefinition {
  taskId: string
  title: string
  description: string
  taskType?: TaskType
  expectedOutputFormat?: OutputFormat
  qualityCriteria?: string[]
  constraints?: string[]
  suggestedParallelMode?: ParallelMode
  inputFiles?: string[]
  priority?: number
  deadline?: string
  maxBudgetTokens?: number
}

// ==================== 顶层配置 ====================

export interface AgentSwarmConfig {
  name: string
  version: string
  description?: string
  orchestrator: OrchestratorConfig
  subAgentTemplates?: Record<string, SubAgentConfig>
  defaultTaskTimeout?: number
  maxConcurrentTasks?: number
  enableLogging?: boolean
  enableProgressTracking?: boolean
}

// ==================== 工具函数 ====================

export function estimateCriticalSteps(
  numSubAgents: number,
  avgStepsPerAgent: number,
  orchestratorSteps: number,
  parallelMode: ParallelMode
): number {
  let maxSubSteps: number

  switch (parallelMode) {
    case 'full_parallel':
      maxSubSteps = avgStepsPerAgent
      break
    case 'pipeline':
      maxSubSteps = (avgStepsPerAgent * numSubAgents) / Math.max(2, numSubAgents / 10)
      break
    case 'map_reduce':
      maxSubSteps = avgStepsPerAgent + avgStepsPerAgent / 2
      break
    case 'dag':
      maxSubSteps = avgStepsPerAgent * 1.2
      break
    case 'adaptive':
      maxSubSteps = avgStepsPerAgent * 1.1
      break
    default:
      maxSubSteps = avgStepsPerAgent * 0.7
  }

  return orchestratorSteps + Math.ceil(maxSubSteps)
}

export function createDefaultSwarmConfig(): AgentSwarmConfig {
  return {
    name: 'default-k2-6-swarm',
    version: '2.6',
    description: '通用自适应 Agent Swarm 配置',
    orchestrator: {
      maxSubAgents: 10,
      maxTotalSteps: 4000,
      maxSupervisionSteps: 15,
      decompositionDepth: 2,
      minSubTaskGranularity: 1,
      adaptiveDecomposition: true,
      parallelMode: 'adaptive',
      enableLoadBalancing: true,
      enableCrossVerification: true,
      contextStrategy: 'sharding',
      tokenBudget: {
        maxContextLength: 128000,
        maxOutputTokens: 8192,
        reservedForSummary: 4096,
        shardSize: 32768,
      },
      maxRetries: 3,
      failoverStrategy: 'reassign',
    },
    subAgentTemplates: {},
    maxConcurrentTasks: 6,
    enableProgressTracking: true,
  }
}

// ==================== 预设配置 ====================

export class PresetConfigs {
  static largeScaleResearch(): AgentSwarmConfig {
    return {
      name: 'large-scale-research',
      version: '2.6',
      description: 'Optimized for wide-scale parallel information gathering',
      orchestrator: {
        maxSubAgents: 20,
        maxTotalSteps: 4000,
        maxSupervisionSteps: 15,
        decompositionDepth: 3,
        minSubTaskGranularity: 1,
        adaptiveDecomposition: true,
        parallelMode: 'full_parallel',
        enableLoadBalancing: true,
        enableCrossVerification: true,
        contextStrategy: 'sharding',
        tokenBudget: {
          maxContextLength: 128000,
          maxOutputTokens: 8192,
          reservedForSummary: 4096,
          shardSize: 32768,
        },
        maxRetries: 3,
        failoverStrategy: 'reassign',
      },
      subAgentTemplates: {
        researcher: {
          name: 'Researcher',
          role: 'researcher',
          allowedTools: ['web_search', 'browser_visit', 'data_extraction'],
          contextStrategy: 'sharding',
          maxExecutionSteps: 50,
        },
        analyst: {
          name: 'Analyst',
          role: 'analyst',
          allowedTools: ['data_analysis', 'chart_generation', 'excel'],
          contextStrategy: 'summary',
          maxExecutionSteps: 100,
        },
      },
      maxConcurrentTasks: 10,
    }
  }

  static longFormWriting(): AgentSwarmConfig {
    return {
      name: 'long-form-writing',
      version: '2.6',
      description: 'Optimized for collaborative long-document writing',
      orchestrator: {
        maxSubAgents: 12,
        maxTotalSteps: 4000,
        maxSupervisionSteps: 15,
        decompositionDepth: 2,
        minSubTaskGranularity: 1,
        adaptiveDecomposition: true,
        parallelMode: 'pipeline',
        enableLoadBalancing: true,
        enableCrossVerification: true,
        contextStrategy: 'sharding',
        tokenBudget: {
          maxContextLength: 128000,
          maxOutputTokens: 8192,
          reservedForSummary: 4096,
          shardSize: 32768,
        },
        maxRetries: 3,
        failoverStrategy: 'reassign',
      },
      subAgentTemplates: {
        writer: {
          name: 'Writer',
          role: 'writer',
          allowedTools: ['document_write', 'markdown', 'pdf_export'],
          contextStrategy: 'sharding',
          maxExecutionSteps: 200,
        },
        reviewer: {
          name: 'Reviewer',
          role: 'reviewer',
          allowedTools: ['document_read', 'comment'],
          readOnly: true,
          maxExecutionSteps: 100,
        },
      },
      maxConcurrentTasks: 6,
    }
  }

  static softwareDevelopment(): AgentSwarmConfig {
    return {
      name: 'software-development',
      version: '2.6',
      description: 'Optimized for multi-file software engineering',
      orchestrator: {
        maxSubAgents: 10,
        maxTotalSteps: 4000,
        maxSupervisionSteps: 15,
        decompositionDepth: 3,
        minSubTaskGranularity: 1,
        adaptiveDecomposition: true,
        parallelMode: 'dag',
        enableLoadBalancing: true,
        enableCrossVerification: true,
        contextStrategy: 'sharding',
        tokenBudget: {
          maxContextLength: 128000,
          maxOutputTokens: 8192,
          reservedForSummary: 4096,
          shardSize: 32768,
        },
        maxRetries: 3,
        failoverStrategy: 'reassign',
      },
      subAgentTemplates: {
        coder: {
          name: 'Coder',
          role: 'coder',
          systemPrompt:
            'You are a software engineer. Implement features, fix bugs, and write tests following the project conventions.',
          allowedTools: ['file_read', 'file_write', 'shell', 'code_search'],
          maxExecutionSteps: 150,
        },
        explorer: {
          name: 'Explorer',
          role: 'explorer',
          systemPrompt:
            'You are a codebase explorer. Read files and summarize structure and conventions. Never modify files.',
          allowedTools: ['file_read', 'code_search'],
          readOnly: true,
          maxExecutionSteps: 100,
        },
        planner: {
          name: 'Planner',
          role: 'planner',
          systemPrompt:
            'You are a software architect. Create implementation plans and design documents only. Do not write production code.',
          allowedTools: ['file_read'],
          noShell: true,
          maxExecutionSteps: 80,
        },
      },
      maxConcurrentTasks: 6,
    }
  }

  static multiPerspectiveAnalysis(): AgentSwarmConfig {
    return {
      name: 'multi-perspective-analysis',
      version: '2.6',
      description: 'Optimized for diverse viewpoint generation and synthesis',
      orchestrator: {
        maxSubAgents: 8,
        maxTotalSteps: 4000,
        maxSupervisionSteps: 15,
        decompositionDepth: 2,
        minSubTaskGranularity: 1,
        adaptiveDecomposition: true,
        parallelMode: 'full_parallel',
        enableLoadBalancing: true,
        enableCrossVerification: true,
        contextStrategy: 'sharding',
        tokenBudget: {
          maxContextLength: 128000,
          maxOutputTokens: 8192,
          reservedForSummary: 4096,
          shardSize: 32768,
        },
        maxRetries: 2,
        failoverStrategy: 'reassign',
      },
      subAgentTemplates: {
        product_manager: {
          name: 'Product Manager',
          role: 'product_manager',
          systemPrompt:
            'You are a senior product manager. Analyze from UX, technical debt, prioritization, and competitive positioning.',
          maxExecutionSteps: 80,
        },
        analyst: {
          name: 'Investor Analyst',
          role: 'analyst',
          systemPrompt:
            'You are a skeptical investor. Challenge assumptions and evaluate unit economics, market size, and risks.',
          maxExecutionSteps: 80,
        },
        reviewer: {
          name: 'Customer Success',
          role: 'reviewer',
          systemPrompt:
            'You are a customer success lead. Defend edge cases, enterprise requirements, and end-user needs.',
          maxExecutionSteps: 80,
        },
      },
      maxConcurrentTasks: 6,
    }
  }

  static documentProcessing(): AgentSwarmConfig {
    return {
      name: 'document-processing',
      version: '2.6',
      description: 'Optimized for batch document processing and report generation',
      orchestrator: {
        maxSubAgents: 20,
        maxTotalSteps: 4000,
        maxSupervisionSteps: 15,
        decompositionDepth: 2,
        minSubTaskGranularity: 1,
        adaptiveDecomposition: true,
        parallelMode: 'map_reduce',
        enableLoadBalancing: true,
        enableCrossVerification: false,
        contextStrategy: 'sharding',
        tokenBudget: {
          maxContextLength: 128000,
          maxOutputTokens: 8192,
          reservedForSummary: 4096,
          shardSize: 16384,
        },
        maxRetries: 2,
        failoverStrategy: 'skip',
      },
      subAgentTemplates: {
        extractor: {
          name: 'Document Extractor',
          role: 'custom',
          systemPrompt:
            'You extract structured data from documents. Be concise and output only the extracted fields.',
          allowedTools: ['docx_read', 'xlsx_read', 'pdf_read', 'data_extraction', 'ocr'],
          contextStrategy: 'sharding',
          maxExecutionSteps: 30,
        },
        aggregator: {
          name: 'Data Aggregator',
          role: 'analyst',
          systemPrompt:
            'You aggregate extracted data into summary tables and pivot views.',
          allowedTools: ['data_analysis', 'excel', 'pivot_table'],
          contextStrategy: 'summary',
          maxExecutionSteps: 100,
        },
        generator: {
          name: 'Report Generator',
          role: 'custom',
          systemPrompt:
            'You generate executive-friendly reports with charts, summary tables, and clear narratives.',
          allowedTools: ['xlsx_write', 'pptx_write', 'chart_generation'],
          maxExecutionSteps: 80,
        },
      },
      maxConcurrentTasks: 10,
    }
  }

  static dataPipeline(): AgentSwarmConfig {
    return {
      name: 'data-pipeline',
      version: '2.6',
      description: 'Map-reduce data processing pipeline',
      orchestrator: {
        maxSubAgents: 16,
        maxTotalSteps: 4000,
        maxSupervisionSteps: 15,
        decompositionDepth: 2,
        minSubTaskGranularity: 1,
        adaptiveDecomposition: true,
        parallelMode: 'map_reduce',
        enableLoadBalancing: true,
        enableCrossVerification: true,
        contextStrategy: 'sharding',
        tokenBudget: {
          maxContextLength: 128000,
          maxOutputTokens: 8192,
          reservedForSummary: 4096,
          shardSize: 65536,
        },
        maxRetries: 3,
        failoverStrategy: 'reassign',
      },
      subAgentTemplates: {
        mapper: {
          name: 'Mapper',
          role: 'analyst',
          systemPrompt:
            'You process data chunks and extract key metrics. Output structured intermediate results.',
          allowedTools: ['data_analysis', 'python_execute', 'sql_query'],
          maxExecutionSteps: 100,
        },
        reducer: {
          name: 'Reducer',
          role: 'analyst',
          systemPrompt:
            'You aggregate mapper outputs by category and produce summarized datasets.',
          allowedTools: ['data_analysis', 'aggregation', 'chart_generation'],
          maxExecutionSteps: 150,
        },
        reporter: {
          name: 'Reporter',
          role: 'writer',
          systemPrompt:
            'You generate a concise executive summary from aggregated data.',
          allowedTools: ['document_write', 'chart_generation'],
          maxExecutionSteps: 50,
        },
      },
      maxConcurrentTasks: 10,
    }
  }
}

export const SWARM_PRESETS: Record<string, () => AgentSwarmConfig> = {
  'large-scale-research': PresetConfigs.largeScaleResearch,
  'long-form-writing': PresetConfigs.longFormWriting,
  'software-development': PresetConfigs.softwareDevelopment,
  'multi-perspective-analysis': PresetConfigs.multiPerspectiveAnalysis,
  'document-processing': PresetConfigs.documentProcessing,
  'data-pipeline': PresetConfigs.dataPipeline,
}

export function loadPreset(name: string): AgentSwarmConfig {
  const factory = SWARM_PRESETS[name]
  return factory ? factory() : createDefaultSwarmConfig()
}

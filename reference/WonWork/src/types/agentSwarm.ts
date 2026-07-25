/**
 * Agent Swarm 类型定义
 *
 * 参考 E:\code\WonWork\learn\04\agent-swarm\agent-swarm-overview.md
 */

// ==================== Agent 角色 ====================

export type AgentRole = 'orchestrator' | 'worker' | 'reviewer' | 'observer'

export interface AgentConfig {
  id: string
  name: string
  role: AgentRole
  /** Agent 擅长领域 / 职责描述 */
  description: string
  /** 模型提供商 */
  modelProvider: string
  /** 模型名称 */
  modelName: string
  /** 系统提示词 */
  systemPrompt: string
  /** 温度 */
  temperature?: number
  /** 最大输出 token */
  maxTokens?: number
}

// ==================== Swarm 配置 ====================

export type SwarmExecutionMode = 'sequential' | 'parallel' | 'voting' | 'debate'

export interface SwarmConfig {
  id: string
  name: string
  description?: string
  executionMode: SwarmExecutionMode
  agents: AgentConfig[]
  /** Orchestrator 交叉验证次数 */
  crossCheckCount?: number
  /** 投票阈值（voting 模式） */
  voteThreshold?: number
  /** 辩论轮次（debate 模式） */
  debateRounds?: number
  /** 是否启用审查 */
  enableReview?: boolean
  /** 是否启用观察者 */
  enableObserver?: boolean
  /** 超时毫秒 */
  timeoutMs?: number
}

// ==================== Orchestrator 配置 ====================

export interface OrchestratorConfig {
  /** 是否启用 Orchestrator 思维链路由 */
  enabled: boolean
  /** Orchestrator 模型提供商 */
  provider?: string
  /** Orchestrator 模型名称 */
  model?: string
  /** Orchestrator 系统提示 */
  systemPrompt?: string
}

// ==================== 预设 ====================

export class PresetConfigs {
  static researchSwarm(): SwarmConfig {
    return {
      id: 'research-swarm',
      name: '研究团队',
      description: '多角度研究分析，适合需要全面了解的议题',
      executionMode: 'parallel',
      agents: [
        {
          id: 'analyst',
          name: '分析师',
          role: 'worker',
          description: '擅长数据分析和结构化信息提取',
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-20250514',
          systemPrompt: '你是一位数据分析师，擅长从信息中提取结构化数据并生成分析报告。',
          temperature: 0.3,
        },
        {
          id: 'critic',
          name: '评论家',
          role: 'reviewer',
          description: '擅长发现逻辑漏洞和盲点',
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-20250514',
          systemPrompt: '你是一位评论家，擅长从不同角度审视观点，指出逻辑漏洞和盲点。',
          temperature: 0.5,
        },
      ],
      crossCheckCount: 1,
      enableReview: true,
    }
  }

  static codeReviewSwarm(): SwarmConfig {
    return {
      id: 'code-review-swarm',
      name: '代码审查团队',
      description: '全面代码审查，涵盖安全、性能、可维护性',
      executionMode: 'parallel',
      agents: [
        {
          id: 'security-auditor',
          name: '安全审计员',
          role: 'worker',
          description: '擅长发现安全漏洞',
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-20250514',
          systemPrompt: '你是一位安全审计专家，擅长识别代码中的安全漏洞和风险。',
          temperature: 0.2,
        },
        {
          id: 'performance-engineer',
          name: '性能工程师',
          role: 'worker',
          description: '擅长性能分析和优化',
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-20250514',
          systemPrompt: '你是一位性能工程师，擅长识别代码中的性能瓶颈并给出优化建议。',
          temperature: 0.3,
        },
        {
          id: 'maintainability-expert',
          name: '可维护性专家',
          role: 'reviewer',
          description: '擅长代码可读性和架构评估',
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-20250514',
          systemPrompt: '你是一位软件架构师，擅长评估代码的可读性、可维护性和架构合理性。',
          temperature: 0.4,
        },
      ],
      enableReview: true,
    }
  }
}

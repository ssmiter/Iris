// WorkFlow（工作流）类型：~/.wonwork/workflow/<id>.json 平铺 JSON 文件（2026-09-08 起）。
// 定位：workflow 的「过程结构层」——节点=能力目录真实工具名、边=条件语义
// （锚回执 reason/status 码，不锚散文不锚参数）的结构化文字资产，agent 阅读参照。
// 它不是执行引擎——执行永远由 agent loop 承担。旧 DagWorkflow 体系（执行语义）与此无关。
// JSON 字段名即契约（snake_case 段保持与后端 WorkflowDoc 一致），双端同步改。

export interface WorkflowDoc {
  id: string
  name: string
  /** 版本纪律同 skill/domainPack：改动必升 */
  version: string
  /** 一句话：这条工作流描述哪条主链的预期结构 */
  description: string
  /** 模型匹配主依据：以「当…时加载」风格写触发场景（同 skill 条目规范） */
  whenToUse: string
  /** 归属域；与 domainPack 的互引锚 */
  domain: string
  /** authored=预构建干线 | sedimented=对话沉淀支线 */
  source: 'authored' | 'sedimented'
  /** 沉淀来源会话引用（source=sedimented 时填） */
  origin?: string
  /** 显式起点节点 id（含循环边的图不存在可推断的唯一入度 0 起点） */
  start: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface WorkflowNode {
  id: string
  /** 能力目录真实工具名 */
  tool: string
  /** 人读标签 */
  label: string
  /** 该节点在链上的职责（一句话） */
  purpose: string
  /** 完成判据：锚回执确定性字段/status 码，不锚散文 */
  done_when?: WorkflowDoneWhen
  /** 失败判据：锚 reason 码 */
  fail_when?: WorkflowFailWhen
  /** 互引锚：判断细节去 domainPack/skill，这里不复述 */
  see?: string
}

export interface WorkflowDoneWhen {
  receipt_status?: string
  receipt_status_in?: string[]
  has_field?: string[]
}

export interface WorkflowFailWhen {
  /** 匹配回执的 reason 或 failure_reason 字段（资产层不暴露键名差异） */
  reason_in?: string[]
  /** 匹配回执 status 字段（部分工具把失败放在 status 值里） */
  receipt_status_in?: string[]
}

export interface WorkflowEdge {
  from: string
  /** null=出口（转人工/终点）。分支=同节点多条出边条件互斥；
   * 并行=多条 when:done 无条件扇出；汇合=多条边指入同一节点（执行侧由子代理承担）。 */
  to: string | null
  /** 转移条件：done | reason=<码> | 用户决策短语 */
  when: string
  note?: string
}

/** 清单条目：manifest 级信息 + 有效性信号（结构待修的文件也进清单） */
export interface WorkflowListEntry {
  id: string
  name: string
  version: string
  description: string
  whenToUse: string
  domain: string
  source: string
  nodeCount: number
  edgeCount: number
  valid: boolean
  error?: string
  updatedAt: string
}

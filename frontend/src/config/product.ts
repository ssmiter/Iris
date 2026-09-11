/**
 * Iris 产品能力开关。迁入的 WonWork 多构建目标收敛为本地个人版。
 *
 * 【Iris 迁移 2026-09】WonWork 的 online / mescli 双构建目标与 standalone/mescli
 * 双 API 实现均已删除：Iris 只有一种形态（本地后端 :15001 + 前端 :15173）。
 */

/** 功能特性标志（能力标识符，供权限/隐藏守卫使用） */
export const FEATURE_FLAGS = {
  chat: 'chat',
  webbridge: 'webbridge',
  cronScheduler: 'cronScheduler',
  agentSwarm: 'agentSwarm',
  memory: 'memory',
  skill: 'skill',
  plugin: 'plugin',
  localModel: 'localModel',
  payment: 'payment',
  team: 'team',
} as const

export type FeatureFlag = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS]

/**
 * 产品决策隐藏的功能入口：仅隐藏 UI 入口（侧边栏按钮），引擎与内部逻辑照常运行。
 * 恢复时从数组中移除即可。
 * 2026-08-01 起隐藏 agentSwarm：它是独立孤岛（不经 Agent Loop/工具发现/审批体系，
 * prompt-only 分波），真子 Agent 已由 explore_agent 承担；引擎与 DAG 节点保留可用。
 * 2026-08-12 起隐藏 plugin（MCP 插件页）：核查确认它管的是独立插件包系统
 * （/api/plugins/*，skill/workflow_node/webbridge_action 三类贡献），而三类贡献
 * 前后端均无任何消费/加载点（仅存包+验签）——页面展示的是死数据；MCP 的安装/
 * 启停/凭据/删除主链路已由能力页（/api/mcp/*）全面覆盖。页面、store、后端
 * PluginController 全部休眠保留，恢复时从数组移除即可。
 * 2026-09-09：workflow（引导式向导）与 dagWorkflow（旧 DAG 执行体系）两族
 * 前后端整体下线删除，不再是"隐藏"而是移除——WorkFlow 工作流层（过程结构资产，
 * 非执行引擎）是其形态继任。
 */
export const HIDDEN_FEATURES: string[] = [FEATURE_FLAGS.agentSwarm, FEATURE_FLAGS.plugin]

/** 判断某个功能入口是否被产品决策隐藏 */
export const isFeatureHidden = (feature?: string): boolean =>
  !!feature && HIDDEN_FEATURES.includes(feature)

export const productDisplayName = 'Iris'

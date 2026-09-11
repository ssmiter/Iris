/**
 * WonWork 产品变体配置（编译时标志）
 *
 * 本文件是判断当前构建产物（Online / MESCLI）的唯一入口。
 * UI 代码应通过此处导出的标志位控制功能入口，禁止直接读取 import.meta.env。
 *
 * 【当前构建现状 2026-07】统一构建脚本 build-installer.ps1 只产出 Online 构建
 * （VITE_BUILD_TARGET=online），另保留 mescli 企业构建目标。
 * 因此 Online 构建下的差异化能力不在这里（编译时大家都一样），而是由运行时决定：
 *   - 运行时身份：runtimeMode.ts（未登录=mescli-local / 官网登录=website-online / MES登录=mescli-online）
 *   - 运行时配置：/api/auth/runtime-config → runtimeConfigStore（如 byokEnabled，
 *     由构建期 -EnableByok 写入 appsettings PublicAuth:ByokEnabled）
 * 本文件的 supportsXxx 只是"编译时底线"，实际可见性 = 编译时底线 OR 运行时放开，
 * 典型例子见 ApiKeySettingsView 的 showByok = supportsByok || byokEnabled。
 */

export type BuildTarget = 'online' | 'mescli'

export const BUILD_TARGET = (import.meta.env.VITE_BUILD_TARGET as BuildTarget | undefined) || 'mescli'

export const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

export const isOnline = BUILD_TARGET === 'online'
export const isMescli = BUILD_TARGET === 'mescli'

/** 当前版本是否需要 Wongoing 账号体系 */
export const requiresAccount = isOnline

/** 是否展示 Token Plan / 额度相关入口 */
export const supportsTokenPlan = isOnline

/** 是否展示支付/订购入口 */
export const supportsPayment = isOnline

/**
 * 是否支持用户自备 API Key（BYOK）——编译时底线。
 * Online 构建此处为 false：BYOK 是否开放改由运行时 PublicAuth:ByokEnabled 决定
 * （构建期 -EnableByok 写入；ON=内部人员/演示版双轨，OFF=客户版仅 tokenhub 付费）。
 */
export const supportsByok = isMescli

/**
 * 是否支持本地模型（Ollama / LM Studio / WebLLM）——编译时底线。
 * Online 构建暂不开放；后续支持私有部署/本地模型时可改为运行时配置放开
 * （与 BYOK 同模式），不必出新的构建变体。
 */
export const supportsLocalModel = isMescli

/**
 * 是否需要用户手工输入 License Key 进行产品激活。
 * Online 版以官网账号登录作为唯一身份入口，套餐和额度由云端账号返回，
 * 不再叠加旧版机器 License Key 激活。
 */
export const supportsLicenseActivation = false

/** 是否支持离线应急模式 */
export const supportsOfflineMode = IS_STANDALONE

/** 是否连接 Wongoing SaaS 云端 */
export const connectsToWongoingCloud = isOnline

/** 功能特性标志，用于与 License.features 做守卫匹配 */
export const FEATURE_FLAGS = {
  chat: 'chat',
  webbridge: 'webbridge',
  cronScheduler: 'cronScheduler',
  agentSwarm: 'agentSwarm',
  memory: 'memory',
  skill: 'skill',
  plugin: 'plugin',
  byok: 'byok',
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

/** 各套餐默认启用的功能列表 */
export const DEFAULT_FEATURES_BY_TIER: Record<'free' | 'pro' | 'enterprise', string[]> = {
  free: [FEATURE_FLAGS.chat, FEATURE_FLAGS.memory],
  pro: [
    FEATURE_FLAGS.chat,
    FEATURE_FLAGS.memory,
    FEATURE_FLAGS.webbridge,
    FEATURE_FLAGS.cronScheduler,
    FEATURE_FLAGS.agentSwarm,
    FEATURE_FLAGS.skill,
    FEATURE_FLAGS.plugin,
    FEATURE_FLAGS.byok,
    FEATURE_FLAGS.localModel,
  ],
  enterprise: Object.values(FEATURE_FLAGS),
}
export const productDisplayName = isOnline ? 'WonWork Online' : 'WonWork'

/** 构建目标描述，用于日志、设置页等 */
export const buildTargetDescription: Record<BuildTarget, string> = {
  online: 'WonWork Online（在线版，需账号与 Token Plan）',
  mescli: 'WonWork MESCLI 模式（连接企业 MESCLI 后端）',
}

/** 调试信息（开发环境可用） */
export function getProductDebugInfo(): Record<string, unknown> {
  return {
    buildTarget: BUILD_TARGET,
    isStandalone: IS_STANDALONE,
    isOnline,
    isMescli,
    requiresAccount,
    supportsTokenPlan,
    supportsPayment,
    supportsByok,
    supportsLocalModel,
    supportsLicenseActivation,
    supportsOfflineMode,
    productDisplayName,
  }
}

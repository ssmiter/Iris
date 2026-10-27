import { buildFeedbackNatureBody } from './sections/feedbackNature'

/**
 * 子 Agent 提示词的共享小节（单一事实源）。
 * 此前 discoveryNote/sqlNote 在 generalAgentPrompt.ts 与 exploreAgentPrompt.ts
 * 各抄一份，容易漂移；2026-08-14 起统一收归此处，变体差异用参数表达。
 */

export function buildSubagentDiscoveryNote(
  hasCapabilityPrimitives: boolean,
  variant: 'general' | 'explore'
): string {
  const scope = variant === 'general' ? '查询、报表、操作等' : '只读查询、报表与调研等'
  const readOnly = variant === 'explore'
    ? '\n你是只读调研者：只加载和调用只读能力，不尝试写操作，也不通过发现、命令或其他通道绕过只读边界。'
    : '\n能力目录可见不等于有权执行；只使用本子任务已注册/允许加载的能力，遵守当前只读限制与审批边界。'
  return hasCapabilityPrimitives
    ? `
## 领域能力发现
领域能力（${scope}）按需发现，不假设所有 schema 都常驻：
1. 当前已注册 grep 且支持能力目录时，在 /capabilities 以业务词或工具名片段检索；
2. 当前已注册 read_capability 时，用命中的能力路径读取完整 schema，按返回的实际工具名和参数调用；发现被拒绝或未加载时不能直接调用；
3. 结构不清且当前已注册 list_capabilities 时，浏览目录建立全景；若当前发现入口不同，按该入口的契约操作，不编造这些工具名。
每个加载的工具都对应真实子问题。领域问题优先找口径明确的领域能力；覆盖不足或需要底层核实时，可用当前获准的文件、SQL、脚本等能力，不把偏好写成禁止底层。权限、安全策略或用户审批拒绝后，不换通道实现同一被拒绝效果；说明阻塞并回报主 Agent，可继续独立且已获准的部分。${readOnly}`
    : `
## 工具环境
本子任务未提供领域能力发现入口，不推断全局目录为空。使用当前已注册且获准的读取/检索等能力；任务确需额外能力时向主 Agent 报告缺口，不猜测常驻工具名，不空转检索不存在的入口。权限或审批拒绝后停止该动作，不换通道绕过。${readOnly}`
}

export type SubagentSqlVariant = 'general' | 'stateKeeper' | 'explore'

export function buildSubagentSqlNote(
  sql: { dialect: 'sqlserver' | 'sqlite' } | undefined,
  variant: SubagentSqlVariant
): string {
  if (!sql) return ''
  // 调用方的 dialect 可能来自遗留模式推断，不据此宣告实际连接方言。
  const common = `- SQL 仅在本子任务已注册或经当前发现入口成功加载后使用；工具名、参数、连接/库选择、方言、权限与结果形式以当前 schema 和回执为准，不从产品模式或登录身份推断，也不预设默认库。目录可见不等于获准访问。
- 领域问题优先使用口径明确的领域能力；覆盖不足、核对结构/数据或二次加工时可以用获准 SQL，不禁止底层。不能在领域能力被拒绝后改用 SQL 完成同一被拒绝操作。
- 先确认结构与实际方言，再用相应元数据/预览语法；例如确认 SQL Server 后用 SELECT TOP 1，确认 SQLite 后用 LIMIT。PRAGMA / EXPLAIN 是否支持、是否只读须看具体语句与契约，不能一律放行。
- 陌生表先核对列结构、COUNT(*) 和适用日期列的 MIN/MAX，再按需求细查；反复为空先核实数据、连接与范围。多维汇总尽量用少量 GROUP BY 或必要维度数据的获准分析，避免无意义往返。
- 区分结果预览、分页、截断和完整落盘；若返回完整结果文件，用回执里的实际路径交给当前可用且获准的只读文件/分析能力，不硬编码 scratch 路径，也不因预览有限就重复查询。无全量文件时按契约分页或聚合，不宣称数据已全部保存。
- 结构/语法等可恢复错误可依据回执修正重试；权限、安全策略或用户审批拒绝则停止被拒绝动作并回报主 Agent，不改默认库、连接、语句形态或换工具通道绕过。超时/中断先核实实际状态，不盲目重复；独立且已获准的部分可以继续。`

  if (variant === 'stateKeeper' || variant === 'explore') {
    return `
## SQL 只读边界
- 只允许无副作用的读取；INSERT/UPDATE/DELETE/CREATE/DROP/ALTER 等写入与任何带副作用的语句都不要尝试，即使通用 SQL 工具支持也不能使用。不得经发现或其他工具绕过本子任务的只读边界。${variant === 'stateKeeper' ? '指定状态文件的 write_state/状态回执特许不扩展到数据库或其他外部对象。' : ''}
${common}`
  }
  return `
## SQL 使用边界
- 只读查询仍服从当前工具权限与执行链；只有当前契约支持写入且子任务已获授权时才准备变更，核对目标、范围、预期影响与验证方式。需要审批时说明影响并等待结果，批准前不假定已生效，被拒绝后停止，不换通道。写后核验实际数据，无法确认则如实报告。
${common}`
}

/**
 * 工具反馈的两种性质（子 Agent 版）：正文与主提示词同一事实源，
 * 主/子 Agent 对"客观反馈 vs 人工引导"保持同一认识。
 */
export function buildSubagentFeedbackNatureNote(): string {
  return `
## 工具反馈的两种性质
${buildFeedbackNatureBody()}`
}

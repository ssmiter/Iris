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
  const scope = variant === 'general' ? 'MES 查询/报表/操作等' : 'MES 查询/报表等'
  return hasCapabilityPrimitives
    ? `
## 业务工具发现
业务工具（${scope}）默认不在你的上下文里，需要先发现再加载：
1. 用 grep 在 /capabilities 检索目录全文搜索（中文业务词、英文工具名片段均可）；
2. 命中的工具路径用 read_capability 读取完整 schema，读取后即可直接调用；
3. 结构不清时用 list_capabilities 浏览目录建立全景。
发现阶段的几轮调用是正常投资，但每个加载的工具都应对应一个真实的子问题。`
    : `
## 工具环境
本环境没有业务工具目录（/capabilities 为空），不要在其中空转检索——直接用文件与检索原语完成任务。`
}

export type SubagentSqlVariant = 'general' | 'stateKeeper' | 'explore'

export function buildSubagentSqlNote(
  sql: { dialect: 'sqlserver' | 'sqlite' } | undefined,
  variant: SubagentSqlVariant
): string {
  if (!sql) return ''
  const selectOnly = `SELECT${sql.dialect === 'sqlserver' ? '' : ' / PRAGMA / EXPLAIN'}`
  const dialectLine =
    sql.dialect === 'sqlserver'
      ? '- 当前是 SQL Server：预览表结构用 SELECT TOP 1 * FROM table_name，不要用 LIMIT/PRAGMA。'
      : '- 当前是 SQLite：预览表结构用 SELECT * FROM table_name LIMIT 1。'
  const landingLine =
    '- 查询结果会落盘到 /workspace/scratch/{date}/sql_result_*.json，需要全量分析时用文件工具读取落盘文件。'

  if (variant === 'stateKeeper') {
    return `
## SQL 使用边界
- 只允许只读查询（${selectOnly}）；写操作会被直接拒绝，不要尝试。
${dialectLine}
${landingLine}`
  }
  if (variant === 'explore') {
    const businessPriority =
      sql.dialect === 'sqlserver'
        ? '- 业务问题优先用业务工具：execute_sql_query 是辅助角色——先经能力发现找口径已确认的业务工具，SQL 只用于预览表结构、业务工具覆盖不了、或对业务工具结果二次加工；与业务无关的通用探索一般用不到 SQL。\n'
        : ''
    return `
## SQL 查询边界
- 只允许只读查询（${selectOnly}）；任何写操作（INSERT/UPDATE/DELETE/CREATE/DROP/ALTER 等）会被结构性拒绝，不要尝试。
${businessPriority}${dialectLine}
- 查询结果会落盘到 /workspace/scratch/{date}/sql_result_*.json，需要全量分析时用文件工具读取落盘文件，不要因预览行数有限而重复查询。`
  }
  // general
  const businessPriority =
    sql.dialect === 'sqlserver'
      ? '- 业务问题优先用业务工具：execute_sql_query 是辅助角色——先经能力发现找口径已确认的业务工具，SQL 只用于预览表结构、业务工具覆盖不了、或对业务工具结果二次加工。\n'
      : ''
  return `
## SQL 使用边界
- 只读查询（${selectOnly}）直接执行；
- 写操作（INSERT/UPDATE/DELETE/CREATE/DROP/ALTER 等）会触发用户审批——提交后等结果，批准前不要假设已生效，被拒绝就换路径或在报告中说明。
${businessPriority}${dialectLine}
${landingLine}`
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

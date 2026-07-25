/**
 * 后端工具目录加载后的动态覆盖。
 *
 * 后端工具目录只包含静态元数据，但部分工具的实际风险随输入变化。
 * 在这里为这类工具附加前端权限检查，使审批/提示在调用后端前就能按参数动态判定。
 */

import type { FrontendToolRegistry } from './toolRegistry'
import { classifySql } from './sqlOperationClassifier'
import type { PermissionResult, ToolPermissionContext } from './types'

/**
 * 后端工具目录加载后的动态覆盖。
 *
 * 后端工具目录只包含静态元数据，但部分工具的实际风险随输入变化。
 * 在这里为这类工具附加前端权限检查，使审批/提示在调用后端前就能按参数动态判定。
 */
export function applyBackendToolOverrides(registry: FrontendToolRegistry): void {
  attachSqlToolDynamicApproval(registry)
}

/**
 * execute_sql_query 的动态审批策略：
 * - 读操作（SELECT / PRAGMA / EXPLAIN）直接放行；
 * - 写操作（INSERT / UPDATE / DELETE / DDL 等）要求用户显式确认；
 * - 参数为空或包含明显注入标记时拒绝，不调用后端。
 */
function attachSqlToolDynamicApproval(registry: FrontendToolRegistry): void {
  const tool = registry.get('execute_sql_query')
  if (!tool) return

  registry.register({
    ...tool,
    riskLevel: 'standard',
    isReadOnly: (input: unknown): boolean => {
      const args = (input || {}) as Record<string, unknown>
      const sql = typeof args.sql === 'string' ? args.sql.trim() : ''
      if (!sql) return false
      return classifySql(sql).isReadOnly
    },
    checkPermissions: (input: unknown, _context: ToolPermissionContext): PermissionResult => {
      const args = (input || {}) as Record<string, unknown>
      const sql = typeof args.sql === 'string' ? args.sql.trim() : ''

      if (!sql) {
        return {
          allowed: false,
          behavior: 'deny',
          reason: 'SQL 参数为空，无法执行。',
        }
      }

      if (sql.includes(';') || sql.includes('--') || sql.includes('/*') || sql.includes('*/')) {
        return {
          allowed: false,
          behavior: 'deny',
          reason: 'SQL 中不能包含分号或注释。',
        }
      }

      const classification = classifySql(sql)
      if (classification.isReadOnly) {
        return { allowed: true, behavior: 'allow' }
      }

      const tables = classification.tables.length > 0 ? classification.tables.join(', ') : '未知表'
      const DESTRUCTIVE_OPS = new Set(['DELETE', 'DROP', 'TRUNCATE', 'ALTER', 'RENAME'])
      const isDestructiveOp = DESTRUCTIVE_OPS.has(classification.operation)
      return {
        allowed: false,
        behavior: 'ask',
        alwaysAsk: true,
        reason: isDestructiveOp
          ? `SQL 破坏性操作（${classification.operation}）需要确认（全部自动模式下仍保留）。涉及表：${tables}。`
          : `SQL 写操作（${classification.operation}）需要确认（全部自动模式下仍保留）。涉及表：${tables}。确认后才会发送给后端执行。`,
      }
    },
  })
}

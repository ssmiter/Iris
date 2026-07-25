/**
 * SQL 语句操作类型分类器
 *
 * 前后端共用同一语义：
 * - 读操作：SELECT、PRAGMA、EXPLAIN
 * - 写操作：INSERT / UPDATE / DELETE / CREATE / DROP / ALTER / TRUNCATE / MERGE / REPLACE / RENAME
 *
 * 仅用于审批决策与权限提示，不替代后端执行前的语法/安全校验。
 */

export type SqlOperationKind = 'read' | 'write'

export interface SqlClassification {
  kind: SqlOperationKind
  operation: string
  tables: string[]
  isReadOnly: boolean
}

function normalize(sql: string): string {
  return (sql || '').trim().replace(/\s+/g, ' ')
}

export function classifySql(sql: string): SqlClassification {
  const normalized = normalize(sql)
  if (normalized.length === 0) {
    return { kind: 'read', operation: 'empty', tables: [], isReadOnly: true }
  }

  const upper = normalized.toUpperCase()

  // PRAGMA / EXPLAIN 视为 schema 自省读操作
  if (/^\s*(PRAGMA|EXPLAIN)\b/i.test(normalized)) {
    return { kind: 'read', operation: 'schema_inspection', tables: extractTables(normalized), isReadOnly: true }
  }

  // 写操作关键字
  const writeMatch = upper.match(/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|MERGE|REPLACE|RENAME|EXEC|EXECUTE|GRANT|REVOKE)\b/)
  if (writeMatch) {
    return {
      kind: 'write',
      operation: writeMatch[1],
      tables: extractTables(normalized),
      isReadOnly: false,
    }
  }

  // SELECT ... INTO 会新建表（T-SQL），表面是 SELECT 实际是写
  if (/^\s*SELECT\b[\s\S]*\bINTO\b/i.test(normalized)) {
    return {
      kind: 'write',
      operation: 'SELECT_INTO',
      tables: extractTables(normalized),
      isReadOnly: false,
    }
  }

  // 默认按只读处理（SELECT、WITH 等）
  return { kind: 'read', operation: 'query', tables: extractTables(normalized), isReadOnly: true }
}

function extractTables(sql: string): string[] {
  const regex = /\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/gi
  const tables: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(sql)) !== null) {
    const name = match[2]
    if (name && !tables.some((t) => t.toLowerCase() === name.toLowerCase())) {
      tables.push(name)
    }
  }
  return tables
}

/**
 * 判断 SQL 是否包含明显危险的多语句/注释注入特征。
 * 仅作前端快速提示，真实校验由后端执行。
 */
export function hasSqlInjectionMarkers(sql: string): boolean {
  const normalized = normalize(sql)
  return normalized.includes(';') || normalized.includes('--') || normalized.includes('/*') || normalized.includes('*/')
}

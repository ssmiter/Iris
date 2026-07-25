/**
 * SQL 写操作分类器
 *
 * 仅用于前端轻量判断 execute_sql_query 是否需要展示"解释此 SQL 影响"入口。
 * 规则覆盖常见写操作关键字，不保证语义完整（复杂动态 SQL 可能误判），
 * 但宁可漏判也不应把明显写操作当成只读。
 */

const WRITE_KEYWORDS = [
  // DML
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'REPLACE', // MySQL REPLACE INTO
  // DDL
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'RENAME',
  // DCL / 执行类（可能包含写操作）
  'GRANT',
  'REVOKE',
  'EXEC',
  'EXECUTE',
  'sp_executesql',
]

const READ_KEYWORDS = ['SELECT', 'WITH', 'EXPLAIN', 'PRAGMA', 'DESCRIBE', 'SHOW']

/**
 * 判断 SQL 是否为写操作。
 *
 * 规则：
 * 1. 空 / 非字符串 → false
 * 2. 按空白/标点分词后，出现任意写操作关键字 → true
 * 3. 仅出现只读关键字且无写操作关键字 → false
 * 4. 无法明确识别时保守返回 false（不展示解释按钮）
 */
export function isSqlWriteOperation(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false

  const normalized = sql
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]/g, '$1')
    .replace(/"([^"]*)"/g, '$1')
    .replace(/'/g, '')
    .replace(/;/g, ' ')

  const tokens = normalized.split(/[^a-zA-Z0-9_#@$]+/).filter(Boolean)
  const upperTokens = tokens.map((t) => t.toUpperCase())

  const hasWrite = WRITE_KEYWORDS.some((kw) => upperTokens.includes(kw))
  if (hasWrite) return true

  const hasRead = READ_KEYWORDS.some((kw) => upperTokens.includes(kw))
  if (hasRead) return false

  // 动态 SQL / 存储过程等无法确定时保守处理
  return false
}

/**
 * 从 SQL 文本中提取操作类型与目标表名（尽力而为）。
 * 用于规则级提示或作为模型输入的补充。
 */
export function extractSqlOperationHint(sql: string): string {
  if (!sql || typeof sql !== 'string') return '未知 SQL'

  const normalized = sql
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]/g, '$1')
    .replace(/"([^"]*)"/g, '$1')
    .replace(/'/g, "'")
    .replace(/;/g, ' ')

  const tokens = normalized.split(/[^a-zA-Z0-9_#@$.]+/).filter(Boolean)
  const upper = tokens.map((t) => t.toUpperCase())

  const writeIdx = upper.findIndex((t) =>
    WRITE_KEYWORDS.includes(t)
  )
  if (writeIdx === -1) return '读操作'

  const op = tokens[writeIdx].toUpperCase()

  // 找目标表：紧跟 INTO / UPDATE / FROM / TABLE 后的标识
  let table = ''
  for (let i = writeIdx; i < tokens.length - 1; i++) {
    const u = upper[i]
    const next = tokens[i + 1]
    if (
      (u === 'INTO' || u === 'UPDATE' || u === 'TABLE' || u === 'FROM') &&
      next &&
      !/^\d/.test(next) &&
      !['SELECT', 'WHERE', 'JOIN', 'ON', 'SET', 'VALUES'].includes(next.toUpperCase())
    ) {
      table = next
      break
    }
  }

  return table ? `${op} ${table}` : op
}

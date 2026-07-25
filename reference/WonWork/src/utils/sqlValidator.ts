import type { ExecutionPlan, ExecutionPlanStep } from '@/types/dagWorkflow'
import {
  executeSqlQuery,
  getTableSchema,
  searchSchema,
  type SchemaTableInfo,
} from './schemaDiscovery'

export type SqlValidationStatus = 'pending' | 'validating' | 'valid' | 'invalid' | 'skipped'

export interface SqlValidationResult {
  stepId: string
  status: SqlValidationStatus
  query: string
  queries: string[]
  dbName?: string
  tablesReferenced: string[]
  tablesFound: string[]
  tablesMissing: string[]
  missingColumns: Array<{ tableName: string; columnName: string }>
  executionError?: string
  executionResult?: {
    rowCount: number
    columns: string[]
  }
  sanitizedQuery?: string
  schemaSnapshot?: Record<string, SchemaTableInfo>
}

export interface PlanValidationState {
  sqlResults: SqlValidationResult[]
  overallSqlValid: boolean
}

const TABLE_NAME_REGEX =
  /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+([`"\[]?)([\w_]+(?:\.[\w_]+)?)\1/gi

const SQL_KEYWORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'NULL',
  'IS',
  'IN',
  'BETWEEN',
  'LIKE',
  'EXISTS',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'OUTER',
  'CROSS',
  'ON',
  'AS',
  'GROUP',
  'BY',
  'ORDER',
  'HAVING',
  'LIMIT',
  'TOP',
  'DISTINCT',
  'UNION',
  'ALL',
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'CAST',
  'CONVERT',
  'ASC',
  'DESC',
])

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '')
}

export function extractTableNamesFromSql(sql: string): string[] {
  const clean = stripSqlComments(sql)
  const names = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = TABLE_NAME_REGEX.exec(clean)) !== null) {
    const raw = match[2]
    const parts = raw.split('.')
    const tableName = parts.length > 1 ? parts[parts.length - 1] : raw
    names.add(tableName)
  }
  return Array.from(names)
}

function looksLikeSql(text: string): boolean {
  const upper = text.toUpperCase()
  return upper.includes('SELECT') && upper.includes('FROM')
}

function looksLikePythonCode(text: string): boolean {
  const upper = text.toUpperCase()
  return (
    upper.includes('IMPORT') ||
    upper.includes('DEF ') ||
    upper.includes('PRINT(') ||
    upper.includes('PYTHON')
  )
}

function extractSqlFromPythonCode(code: string): string[] {
  const sqls: string[] = []
  const patterns = [
    { regex: /'''[\s\S]*?'''/g, strip: 3 },
    { regex: /"""[\s\S]*?"""/g, strip: 3 },
    { regex: /'[^'\\]*(?:\\.[^'\\]*)*'/g, strip: 1 },
    { regex: /"[^"\\]*(?:\\.[^"\\]*)*"/g, strip: 1 },
  ]
  for (const { regex, strip } of patterns) {
    const matches = code.matchAll(regex)
    for (const m of matches) {
      const raw = m[0]
      const inner = raw.slice(strip, -strip)
      if (looksLikeSql(inner)) {
        sqls.push(inner)
      }
    }
  }
  return sqls
}

function extractSqlsFromString(text: string): string[] {
  if (!looksLikeSql(text)) return []
  if (looksLikePythonCode(text)) {
    return extractSqlFromPythonCode(text)
  }
  return [text]
}

function findSqlStrings(value: unknown): string[] {
  const results: string[] = []
  if (typeof value === 'string') {
    results.push(...extractSqlsFromString(value))
  } else if (Array.isArray(value)) {
    for (const item of value) {
      results.push(...findSqlStrings(item))
    }
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) {
      results.push(...findSqlStrings(v))
    }
  }
  return results
}

function isSelectOnly(sql: string): boolean {
  const normalized = sql.trim().toUpperCase()
  return normalized.startsWith('SELECT') && !normalized.includes(' INTO ')
}

function containsIntToDateCast(sql: string): boolean {
  const upper = sql.toUpperCase()
  // CAST(20260401 AS DATE) / CAST(20260401 AS DATETIME) / CAST(20260401 AS DATETIME2)
  if (/\bCAST\s*\(\s*\d+\s+AS\s+(?:DATE|DATETIME|DATETIME2|SMALLDATETIME)\b/i.test(sql)) return true
  // CONVERT(DATE, 20260401) / CONVERT(DATETIME, 20260401)
  if (/\bCONVERT\s*\(\s*(?:DATE|DATETIME|DATETIME2|SMALLDATETIME)\s*,\s*\d+\b/i.test(sql)) return true
  // 形如 WHERE date_col >= 20260401 的 int 字面量与日期列比较
  if (/\b(?:WHERE|AND|OR)\s+.*?(?:>=|>|<=|<|=)\s*\d{8,}\b/i.test(sql)) return true
  return false
}

function extractIdentifiersFromClause(clause: string): string[] {
  const identifiers = new Set<string>()
  // table.column pattern: keep the column part
  const qualifiedMatches = clause.matchAll(/\b(\w+)\s*\.\s*(\w+)\b/g)
  for (const m of qualifiedMatches) {
    identifiers.add(m[2])
  }
  // standalone words
  const words = clause.match(/\b(?!\d)\w+\b/g) || []
  for (const word of words) {
    if (!SQL_KEYWORDS.has(word.toUpperCase())) {
      identifiers.add(word)
    }
  }
  return Array.from(identifiers)
}

function extractColumnRefsFromSql(sql: string): string[] {
  const clean = stripSqlComments(sql)
  // Replace string literals so quoted text does not pollute extraction
  const withoutStrings = clean
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')

  const columns = new Set<string>()

  const addFromClause = (clause: string | undefined) => {
    if (!clause) return
    for (const id of extractIdentifiersFromClause(clause)) {
      columns.add(id)
    }
  }

  // SELECT
  const selectMatch = withoutStrings.match(/SELECT\s+(.*?)\s+FROM\b/is)
  if (selectMatch && selectMatch[1].trim() !== '*') {
    addFromClause(selectMatch[1])
  }

  // WHERE
  const whereMatch = withoutStrings.match(/WHERE\s+(.*?)(?:ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|$)/is)
  addFromClause(whereMatch?.[1])

  // GROUP BY
  const groupMatch = withoutStrings.match(/GROUP\s+BY\s+(.*?)(?:ORDER\s+BY|HAVING|LIMIT|$)/is)
  addFromClause(groupMatch?.[1])

  // ORDER BY
  const orderMatch = withoutStrings.match(/ORDER\s+BY\s+(.*?)(?:LIMIT|$)/is)
  addFromClause(orderMatch?.[1])

  // HAVING
  const havingMatch = withoutStrings.match(/HAVING\s+(.*?)(?:ORDER\s+BY|LIMIT|$)/is)
  addFromClause(havingMatch?.[1])

  // JOIN ON
  const onMatches = withoutStrings.matchAll(/\bON\s+(.+?)(?:\bJOIN\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|$)/gis)
  for (const m of onMatches) {
    addFromClause(m[1])
  }

  return Array.from(columns)
}

/**
 * 为验证目的替换 SQL 中的变量引用。
 * ${inputs.xxx} -> 空字符串或 0（根据名称猜测）
 * ${steps.xxx.yyy} -> NULL
 * ${variables.xxx} -> NULL
 *
 * 注意：LLM 有时会把变量引用包在引号里，如 '${inputs.xxx}'。
 * 这种写法在运行时是正确的（runtime 会把变量值作为字符串/数字直接插入），
 * 但验证替换时如果只替换 ${...} 内部，会造成 ''value'' 双引号语法错误。
 * 因此要先匹配整个 '${...}' 或 "${...}"，把它替换成单个字面量。
 */
function sanitizeVariablesForValidation(sql: string): string {
  const inputValue = (name: string): string => {
    const lower = name.toLowerCase()
    if (lower.includes('id') || lower.includes('code') || lower.includes('name')) return "''"
    if (lower.includes('date') || lower.includes('time')) return "'1900-01-01'"
    if (lower.includes('count') || lower.includes('qty') || lower.includes('num')) return '0'
    return "''"
  }

  return (
    sql
      // 单/双引号包裹的 inputs 占位符：'${inputs.xxx}' / "${inputs.xxx}" -> 'value'
      .replace(/'(\$\{inputs\.([^}]+)\})'/g, (_, _placeholder, name) => inputValue(name))
      .replace(/"(\$\{inputs\.([^}]+)\})"/g, (_, _placeholder, name) => inputValue(name))
      // 未加引号的 inputs 占位符
      .replace(/\$\{inputs\.([^}]+)\}/g, (_, name) => inputValue(name))
      // 单/双引号包裹的 steps/variables 占位符
      .replace(/'(\$\{(?:steps|variables)\.([^}]+)\})'/g, 'NULL')
      .replace(/"(\$\{(?:steps|variables)\.([^}]+)\})"/g, 'NULL')
      // 未加引号的 steps/variables 占位符
      .replace(/\$\{(?:steps|variables)\.[^}]+\}/g, 'NULL')
  )
}

function normalizeDbName(connection?: string): string | undefined {
  if (!connection) return undefined
  const upper = connection.trim().toUpperCase()
  if (['MES', 'MENS', 'IRIS', 'IRISMIX', 'AIGATEWAY'].includes(upper)) return upper
  return connection.trim()
}

export interface ValidateSqlStepsOptions {
  systemCode?: string
  /** 为 true 时跳过实际执行，只检查表名是否存在 */
  dryRun?: boolean
}

interface SqlValidationTarget {
  stepId: string
  dbName?: string
  queries: string[]
}

function getDatabaseQueryConfig(step: ExecutionPlanStep):
  | { query?: string; connection?: string }
  | undefined {
  if (step.kind !== 'node' || step.nodeType !== 'database_query') return undefined
  const config = step.config as { databaseQuery?: { query?: string; connection?: string } }
  return config.databaseQuery
}

function collectValidationTargets(plan: ExecutionPlan): SqlValidationTarget[] {
  const targets: SqlValidationTarget[] = []

  for (const step of plan.steps) {
    const dbQueryConfig = getDatabaseQueryConfig(step)
    if (dbQueryConfig) {
      const query = dbQueryConfig.query?.trim()
      if (query) {
        targets.push({
          stepId: step.id,
          dbName: normalizeDbName(dbQueryConfig.connection),
          queries: [query],
        })
      }
      continue
    }

    if (step.kind === 'tool') {
      const sqls = findSqlStrings(step.inputs)
      if (sqls.length > 0) {
        const dbName = normalizeDbName(
          String(
            step.inputs.db_name ??
              step.inputs.database ??
              step.inputs.connection ??
              step.inputs.dbName ??
              ''
          )
        )
        targets.push({ stepId: step.id, dbName, queries: sqls })
      }
    }
  }

  return targets
}

/**
 * 验证 ExecutionPlan 中所有包含 SQL 的步骤（database_query 节点以及 tool 参数中的 SQL）。
 * 1. 提取 SQL
 * 2. 提取表名并通过 schema 目录确认表存在
 * 3. 试跑 SQL（LIMIT 1）
 */
export async function validateSqlSteps(
  plan: ExecutionPlan,
  options: ValidateSqlStepsOptions = {}
): Promise<PlanValidationState> {
  const targets = collectValidationTargets(plan)

  if (targets.length === 0) {
    return { sqlResults: [], overallSqlValid: true }
  }

  const results: SqlValidationResult[] = []
  let overallValid = true

  for (const target of targets) {
    const result: SqlValidationResult = {
      stepId: target.stepId,
      status: 'validating',
      query: target.queries[0] || '',
      queries: target.queries,
      dbName: target.dbName,
      tablesReferenced: [],
      tablesFound: [],
      tablesMissing: [],
      missingColumns: [],
      schemaSnapshot: {},
    }
    results.push(result)

    if (target.queries.length === 0) {
      result.status = 'invalid'
      result.executionError = '未找到可验证的 SQL'
      overallValid = false
      continue
    }

    // 合并多个 SQL 的表名/列名用于反馈，但逐条执行验证
    const allTableNames = new Set<string>()
    const allColumnRefs = new Set<string>()

    for (const query of target.queries) {
      const tableNames = extractTableNamesFromSql(query)
      tableNames.forEach((t) => allTableNames.add(t))
      extractColumnRefsFromSql(query).forEach((c) => allColumnRefs.add(c))
    }

    result.tablesReferenced = Array.from(allTableNames)

    // 确认所有表存在并缓存结构
    for (const tableName of allTableNames) {
      try {
        const search = await searchSchema(tableName, target.dbName)
        const matchedTable = search.tables.find(
          (t) => t.tableName.toLowerCase() === tableName.toLowerCase()
        )

        if (!matchedTable) {
          result.tablesMissing.push(tableName)
          overallValid = false
          continue
        }

        result.tablesFound.push(tableName)
        const tableDbName = matchedTable.dbName || target.dbName || 'MES'
        try {
          const schema = await getTableSchema(matchedTable.tableName, tableDbName)
          result.schemaSnapshot![matchedTable.tableName] = schema
        } catch (schemaErr) {
          console.warn(`[SqlValidator] 获取表 ${matchedTable.tableName} 结构失败:`, schemaErr)
        }
      } catch (err) {
        console.warn(`[SqlValidator] 搜索表 ${tableName} 失败:`, err)
      }
    }

    if (result.tablesMissing.length > 0) {
      result.status = 'invalid'
      result.executionError = `表不存在: ${result.tablesMissing.join(', ')}`
      continue
    }

    // 列名校验（轻量，仅用于反馈；执行试跑才是最终判定）
    const snapshotTables = Object.values(result.schemaSnapshot || {})
    for (const col of allColumnRefs) {
      const colLower = col.toLowerCase()
      let found = false
      let foundInTable = ''
      for (const schema of snapshotTables) {
        if (schema.columns.some((c) => c.columnName.toLowerCase() === colLower)) {
          found = true
          foundInTable = schema.tableName
          break
        }
      }
      if (!found) {
        result.missingColumns.push({ tableName: result.tablesFound.join(','), columnName: col })
      } else if (foundInTable) {
        // 记录列确实存在于某个表中，用于调试
      }
    }

    if (options.dryRun) {
      result.status = result.missingColumns.length > 0 ? 'invalid' : 'valid'
      if (result.missingColumns.length > 0) {
        result.executionError = `列可能不存在: ${result.missingColumns.map((c) => c.columnName).join(', ')}`
        overallValid = false
      }
      continue
    }

    // 逐条试跑 SQL（变量替换为占位值）
    let firstError: string | undefined
    let firstSuccess: { rowCount: number; columns: string[] } | undefined

    for (const query of target.queries) {
      if (!isSelectOnly(query)) {
        firstError = firstError || '工作流中的 SQL 只允许 SELECT 查询'
        overallValid = false
        continue
      }

      if (containsIntToDateCast(query)) {
        firstError = firstError || 'SQL 中禁止将 int 数字硬编码或转换为 date/datetime 类型（如 CAST(20260401 AS DATE) 或 WHERE date_col >= 20260401）。日期/时间列请直接与字符串变量比较，例如 WHERE date_col >= ${inputs.beginDate}。'
        overallValid = false
        continue
      }

      try {
        const validationSql = sanitizeVariablesForValidation(query)
        if (validationSql !== query) {
          console.log(`[SqlValidator] step ${target.stepId} 试跑 SQL（变量已替换）:\n${validationSql}`)
        }
        const execResult = await executeSqlQuery(validationSql, target.dbName, 1)
        if (!execResult.success) {
          firstError = firstError || (execResult.error || 'SQL 执行失败')
          result.sanitizedQuery = validationSql
          overallValid = false
        } else if (!firstSuccess) {
          firstSuccess = {
            rowCount: execResult.rowCount,
            columns: execResult.columns,
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        firstError = firstError || msg
        result.sanitizedQuery = sanitizeVariablesForValidation(query)
        overallValid = false
      }
    }

    if (firstError) {
      result.status = 'invalid'
      result.executionError = firstError
    } else {
      result.status = 'valid'
      if (firstSuccess) {
        result.executionResult = firstSuccess
      }
    }
  }

  return { sqlResults: results, overallSqlValid: overallValid }
}

/**
 * 构建 Standalone 模式或跳过 SQL 验证时的占位状态。
 */
export function buildSkippedSqlState(plan: ExecutionPlan): PlanValidationState {
  const targets = collectValidationTargets(plan)
  return {
    sqlResults: targets.map((t) => ({
      stepId: t.stepId,
      status: 'skipped' as const,
      query: t.queries[0] || '',
      queries: t.queries,
      dbName: t.dbName,
      tablesReferenced: [],
      tablesFound: [],
      tablesMissing: [],
      missingColumns: [],
    })),
    overallSqlValid: true,
  }
}

/**
 * 把 SQL 验证结果转换成给 LLM 的反馈文本。
 */
export function buildSchemaContextForPrompt(state: PlanValidationState): string {
  const lines: string[] = []
  lines.push('## SQL 验证结果')

  for (const result of state.sqlResults) {
    lines.push(`\n步骤 ${result.stepId}:`)
    if (result.queries.length > 1) {
      for (let i = 0; i < result.queries.length; i++) {
        lines.push(`SQL ${i + 1}: ${result.queries[i]}`)
        if (result.sanitizedQuery) {
          lines.push(`用于试跑的 SQL（变量已替换）: ${result.sanitizedQuery}`)
        }
      }
    } else {
      lines.push(`SQL: ${result.query}`)
      if (result.sanitizedQuery) {
        lines.push(`用于试跑的 SQL（变量已替换）: ${result.sanitizedQuery}`)
      }
    }
    lines.push(`状态: ${result.status}`)

    if (result.tablesMissing.length > 0) {
      lines.push(`错误: 以下表在数据库 schema 目录中不存在: ${result.tablesMissing.join(', ')}`)
      lines.push('请勿编造表名。你可以使用 search_schema / list_schema_tables 查找真实存在的表。')
    }

    if (result.missingColumns.length > 0) {
      lines.push(`错误: 以下列可能不存在: ${result.missingColumns.map((c) => c.columnName).join(', ')}`)
      lines.push('生成 SQL 前必须先调用 get_table_schema 确认真实列名，严禁编造列名。')
    }

    if (result.executionError) {
      lines.push(`执行错误: ${result.executionError}`)
    }

    if (result.schemaSnapshot && Object.keys(result.schemaSnapshot).length > 0) {
      lines.push('已确认的真实表结构:')
      for (const [tableName, schema] of Object.entries(result.schemaSnapshot)) {
        lines.push(`  表 ${tableName} (${schema.dbName}):`)
        const colDescs = schema.columns.map((c) => {
          let desc = `${c.columnName} ${c.dataType}`
          if (c.columnNameCn) desc += ` (${c.columnNameCn})`
          if (c.isPk) desc += ' PK'
          if (c.isFk) desc += ' FK'
          return desc
        })
        lines.push(`    列: ${colDescs.join(', ')}`)
      }
    }
  }

  lines.push('\n请根据以上真实 schema 修正 SQL，然后重新输出完整 JSON。')
  return lines.join('\n')
}

/**
 * 将 SQL 验证结果合并为 PlanValidationIssue，供 ExecutionPlanPreview 统一展示。
 */
export function sqlValidationResultsToIssues(
  state: PlanValidationState
): Array<{ stepId: string; field: string; message: string; suggestedFix?: string }> {
  const issues: Array<{ stepId: string; field: string; message: string; suggestedFix?: string }> = []

  for (const result of state.sqlResults) {
    if (result.status === 'valid' || result.status === 'skipped') continue

    let message = result.executionError || 'SQL 验证失败'
    if (result.tablesMissing.length > 0) {
      message = `表不存在: ${result.tablesMissing.join(', ')}。${message}`
    }

    issues.push({
      stepId: result.stepId,
      field: 'databaseQuery.query',
      message,
      suggestedFix:
        result.schemaSnapshot && Object.keys(result.schemaSnapshot).length > 0
          ? '请根据真实表结构修正 SQL'
          : '请使用 search_schema / list_schema_tables 查找真实表名',
    })
  }

  return issues
}

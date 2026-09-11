import { toolApi } from '@/api/client'
import type { ToolInvokeResult, ToolInvokeRequest } from '@/types/mescli'

function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export interface SchemaTableSummary {
  tableName: string
  tableNameCn?: string
  description?: string
  domainCode?: string
  dbName: string
}

export interface SchemaColumnInfo {
  columnName: string
  columnNameCn?: string
  dataType: string
  maxLength?: number
  isNullable?: boolean
  isPk?: boolean
  isFk?: boolean
  description?: string
}

export interface SchemaRelationInfo {
  parentColumn: string
  referencedTable: string
  referencedColumn: string
  relationName?: string
}

export interface SchemaTableInfo {
  tableName: string
  dbName: string
  tableNameCn?: string
  description?: string
  domainCode?: string
  columns: SchemaColumnInfo[]
  relations: SchemaRelationInfo[]
}

export interface SchemaSearchResult {
  keyword: string
  tables: SchemaTableSummary[]
  columns: Array<{
    tableName: string
    columnName: string
    columnNameCn?: string
    dataType: string
    description?: string
    dbName: string
  }>
}

export interface SqlExecutionResult {
  success: boolean
  rowCount: number
  columns: string[]
  rows: Record<string, unknown>[]
  error?: string
}

/**
 * 调用后端 tool。
 * 失败时抛出异常，方便上层捕获。
 */
export async function invokeTool(
  toolName: string,
  args: Record<string, unknown>,
  systemCode?: string
): Promise<ToolInvokeResult> {
  const request: ToolInvokeRequest = {
    toolName,
    arguments: JSON.stringify(args),
    systemCode,
    toolUseId: `tool_${generateId()}`,
    traceId: `trace_${generateId()}`,
    approvalDecisions: [],
  }
  return toolApi.execute(request)
}

/**
 * 在 schema 目录中按关键词搜索表或列。
 */
export async function searchSchema(keyword: string, dbName?: string): Promise<SchemaSearchResult> {
  const result = await invokeTool('search_schema', {
    keyword,
    ...(dbName ? { db_name: dbName } : {}),
    search_columns: true,
  })

  const structured = (result.structuredData || {}) as Record<string, unknown>
  return {
    keyword,
    tables: ((structured.tables || []) as Record<string, unknown>[]).map((t) => ({
      tableName: String(t.table_name || ''),
      tableNameCn: t.table_name_cn ? String(t.table_name_cn) : undefined,
      description: t.description ? String(t.description) : undefined,
      domainCode: t.domain_code ? String(t.domain_code) : undefined,
      dbName: String(t.db_name || ''),
    })),
    columns: ((structured.columns || []) as Record<string, unknown>[]).map((c) => ({
      tableName: String(c.table_name || ''),
      columnName: String(c.column_name || ''),
      columnNameCn: c.column_name_cn ? String(c.column_name_cn) : undefined,
      dataType: String(c.data_type || ''),
      description: c.description ? String(c.description) : undefined,
      dbName: String(c.db_name || ''),
    })),
  }
}

/**
 * 列出 schema 目录中的表。
 */
export async function listSchemaTables(options?: {
  domainCode?: string
  dbName?: string
  keyword?: string
}): Promise<SchemaTableSummary[]> {
  const args: Record<string, unknown> = {}
  if (options?.domainCode) args.domain_code = options.domainCode
  if (options?.dbName) args.db_name = options.dbName
  if (options?.keyword) args.keyword = options.keyword

  const result = await invokeTool('list_schema_tables', args)
  const structured = (result.structuredData || {}) as Record<string, unknown>

  return ((structured.tables || []) as Record<string, unknown>[]).map((t) => ({
    tableName: String(t.table_name || ''),
    tableNameCn: t.table_name_cn ? String(t.table_name_cn) : undefined,
    description: t.description ? String(t.description) : undefined,
    domainCode: t.domain_code ? String(t.domain_code) : undefined,
    dbName: String(t.db_name || ''),
  }))
}

/**
 * 获取单张表的完整结构。
 */
export async function getTableSchema(tableName: string, dbName: string): Promise<SchemaTableInfo> {
  const result = await invokeTool('get_table_schema', {
    table_name: tableName,
    db_name: dbName,
  })

  if (!result.success) {
    throw new Error(result.error || `获取表 ${tableName} 结构失败`)
  }

  const structured = (result.structuredData || {}) as Record<string, unknown>

  return {
    tableName: String(structured.table_name || tableName),
    dbName: String(structured.db_name || dbName),
    tableNameCn: structured.table_name_cn ? String(structured.table_name_cn) : undefined,
    description: structured.description ? String(structured.description) : undefined,
    domainCode: structured.domain_code ? String(structured.domain_code) : undefined,
    columns: ((structured.columns || []) as Record<string, unknown>[]).map((c) => ({
      columnName: String(c.column_name || ''),
      columnNameCn: c.column_name_cn ? String(c.column_name_cn) : undefined,
      dataType: String(c.data_type || ''),
      maxLength: typeof c.max_length === 'number' ? c.max_length : undefined,
      isNullable: typeof c.is_nullable === 'boolean' ? c.is_nullable : undefined,
      isPk: typeof c.is_pk === 'boolean' ? c.is_pk : undefined,
      isFk: typeof c.is_fk === 'boolean' ? c.is_fk : undefined,
      description: c.description ? String(c.description) : undefined,
    })),
    relations: ((structured.relations || []) as Record<string, unknown>[]).map((r) => ({
      parentColumn: String(r.parent_column || ''),
      referencedTable: String(r.referenced_table || ''),
      referencedColumn: String(r.referenced_column || ''),
      relationName: r.relation_name ? String(r.relation_name) : undefined,
    })),
  }
}

/**
 * 执行只读 SQL 查询（验证用）。
 * 默认 LIMIT 1，避免大查询。
 */
export async function executeSqlQuery(
  sql: string,
  dbName?: string,
  limit = 1
): Promise<SqlExecutionResult> {
  const result = await invokeTool('execute_sql_query', {
    sql,
    ...(dbName ? { db_name: dbName } : {}),
    limit,
  })

  if (!result.success) {
    return {
      success: false,
      rowCount: 0,
      columns: [],
      rows: [],
      error: result.error || 'SQL 执行失败',
    }
  }

  const structured = (result.structuredData || {}) as Record<string, unknown>
  return {
    success: true,
    rowCount: typeof structured.row_count === 'number' ? structured.row_count : 0,
    columns: ((structured.columns || []) as unknown[]).map(String),
    rows: ((structured.rows || []) as Record<string, unknown>[]).map((row) => {
      const normalized: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) {
        normalized[k] = v
      }
      return normalized
    }),
  }
}

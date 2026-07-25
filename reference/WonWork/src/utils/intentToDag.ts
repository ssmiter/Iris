import { generateExecutionPlan as generateExecutionPlanFromNaturalLanguage } from './naturalLanguageToDag'
import { formatCatalogForPrompt, type CapabilityCatalog } from './capabilityCatalog'
import type { ExecutionPlan } from '@/types/dagWorkflow'

export interface DagIntentField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'select' | 'array' | 'object'
  required?: boolean
  description?: string
  default?: unknown
  options?: Array<{ label: string; value: string }>
  placeholder?: string
  pattern?: string
  min?: number
  max?: number
}

export interface DagIntent {
  name: string
  description: string
  inputs?: DagIntentField[]
  expectedOutput?: string
  domain?: string
}

export function buildExecutionPlanPrompt(intent: DagIntent, catalog: CapabilityCatalog): string {
  const parts: string[] = []
  parts.push(`设计一个名为「${intent.name}」的执行计划。`)
  parts.push(`目标：${intent.description}`)

  if (intent.inputs && intent.inputs.length > 0) {
    parts.push('\n输入变量：')
    for (const input of intent.inputs) {
      const requiredText = input.required ? '，必填' : '，可选'
      parts.push(
        `- ${input.name} (${input.type}${requiredText})${input.description ? '：' + input.description : ''}`
      )
    }
  }

  if (intent.expectedOutput) {
    parts.push(`\n期望输出：${intent.expectedOutput}`)
  }

  if (intent.domain) {
    parts.push(`\n适用领域：${intent.domain}`)
  }

  parts.push('\n---')
  parts.push(formatCatalogForPrompt(catalog))
  parts.push('\n---')
  parts.push(`\n请输出一个 ExecutionPlan JSON，而不是完整的 DAG JSON。规则：
1. 必须优先使用"可用后端工具"中的 tool 来覆盖意图；toolName 必须与 catalog 中的 name 完全一致。已有 tool 是后端实现并测试过的，能够保证调用成功。同时，inputSchema 必须为每个输入变量生成一个条目，type 必须与上面"输入变量"中列出的类型完全一致（例如 beginDate 为 date 类型，不能降级为 string）。
2. 只有当没有任何 tool 能覆盖意图时，才使用 kind: "node"，且 nodeType 必须从以下列表中选择：${catalog.nodeTypes.join(', ')}。
3. 严禁编造表名、列名、工具名。禁止在 node 步骤里写自由 SQL、Python、JS。
4. 如果意图需要查询 MES/IRIS 生产数据但 catalog 中没有对应 tool：
   - 先使用 search_schema 或 list_schema_tables 查找真实表名；
   - 再用 get_table_schema 获取表结构，确认要使用的每一列都真实存在；
   - 最后写 database_query（仅 SELECT），connection 填写数据库名（MES/MENS/IRIS/IRISMIX）。
   - 所有 SQL（包括 tool 参数内部的 sql/python_code）会在生成后通过真实数据库 schema 和执行试跑验证，编造表名/列名会导致计划被驳回。
   - **后端数据库是 SQL Server，SQL 必须使用 T-SQL 语法**。严禁使用 Oracle/MySQL 特有函数，例如 TO_CHAR、NVL、SYSDATE、DECODE、NLS_ 等。日期格式化用 CONVERT/VARCHAR/FORMAT，字符串连接用 + 或 CONCAT，当前时间用 GETDATE()/SYSDATETIME()。
   - **日期/时间列直接与字符串变量比较**。例如写 WHERE date_col >= \${inputs.beginDate}，runtime 会自动加引号。严禁把 int 硬编码或转换为 date，例如 CAST(20260401 AS DATE) 在 SQL Server 中会报错，且禁止在 WHERE 中写 date_col >= 20260401 这类 int 字面量。
5. 如果你无法找到匹配 tool 又无法确定真实表结构，不要硬写 database_query，而是返回一个空步骤并在 description 中说明"未找到匹配工具或表"。
6. 变量引用统一使用 \${inputs.xxx} 或 \${steps.<stepId>.<field>}。**不要在 SQL 中给变量引用加单引号或双引号**；runtime 会根据变量类型自动处理字符串、数字、日期的格式化。例如写 WHERE create_time >= \${inputs.startDate}，不要写成 WHERE create_time >= '\${inputs.startDate}'。
   **tool 参数必须是合法 JSON**，变量引用必须写在 JSON 字符串值内部，例如 {"date": "\${inputs.beginDate}"}。不要写成 {"date": \${inputs.beginDate}}，否则 JSON 会解析失败。
7. **严禁在 SQL 中硬编码示例值**（如 2000、2024、示例编号、示例名称等）。所有条件值必须来自输入变量或上游步骤输出；否则验证时会被当成真实字面量执行，可能导致语法错误或返回空结果。
8. **如果意图没有定义任何输入变量（inputSchema 为空），则 SQL/参数中不得引用 \${inputs.xxx}**。无输入时应查询全部相关数据，或仅在需要时通过上游步骤输出 \${steps.<stepId>.<field>} 过滤。
9. 当 tool 参数包含 python_code 且其中嵌套 JSON 字符串时，JSON 字符串内部必须使用反斜杠 r 反斜杠 n 表示换行，不要出现真实的换行符或已解码的控制字符。例如 data 字段值写为单行 '第一行\\r\\n第二行'，不要写成多行文本；否则 Python 端 json.loads 会报 Invalid control character。
10. **对于 create_pptx_document / create_excel_document / create_word_document 等文档生成节点，严禁把数据直接硬编码或内联到 python_code 中**。必须通过 \${steps.<stepId>} 引用上游数据节点；若上游输出是包装对象（如 { data: [...] }），请在代码中用 json.loads('''\${steps.<stepId>}''').get('data', []) 取得数组后再生成图表/表格。python_code 长度超过 5 万字符会被拒绝执行。
    - 生成 Word/Excel/PPT 表格时，**严禁假设固定列名**（如 "reason"、"name"、"value"）。必须先检查上游数据第一条记录的 keys，使用实际存在的字段名；缺失值应留空，不能用 "-" 填充。
11. **引用上游步骤输出时，必须根据该步骤实际返回结构写字段名，禁止编造字段**。常见返回结构：
   - database_query 节点返回查询结果数组；若只需要结果是否存在/条数，用 \${steps.<stepId>.length}；若需要第一行某列，用 \${steps.<stepId>[0].columnName}。
   - tool 节点返回该 tool 的原始输出对象，字段由 tool 决定，不要假设固定有 "output" 字段。若不确定，优先用 \${steps.<stepId>} 传递整个对象，或查看 catalog 中该 tool 的返回说明。
   - 如果下游只需要某个值，建议在上游节点之后接一个 variable 节点提取，再用 \${variables.xxx} 引用。
12. **优先使用只读操作**（SELECT 查询、GET 请求、读取文件、白名单内 tool）。若生成的工作流完全只读，系统将在保存前自动进行沙箱试运行验证；试运行失败会打回重新生成。包含写操作、通知、WebBridge、JavaScript、Agent Swarm 等副作用节点的工作流将跳过自动试运行。
13. outputMapping 将最终输出名映射到产生它的 step id（例如 { "report": "step-2" }）。
14. 只输出 JSON，不要 markdown、不要解释。`)

  return parts.join('\n')
}

export async function generateExecutionPlan(
  intent: DagIntent,
  catalog: CapabilityCatalog
): Promise<ExecutionPlan> {
  const prompt = buildExecutionPlanPrompt(intent, catalog)
  return generateExecutionPlanFromNaturalLanguage(prompt)
}

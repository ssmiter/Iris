import type {
  DagWorkflow,
  DagNode,
  DagEdge,
  DagNodeType,
  ExecutionPlan,
  ExecutionPlanStep,
  ExecutionPlanToolStep,
  ExecutionPlanWorkflowStep,
  ExecutionPlanNodeStep,
} from '@/types/dagWorkflow'
import { chatApi } from '@/api/client'
import { userConfigApi } from '@/api/client'
import { useChatStore } from '@/stores/chatStore'
import { useApiKeyStore } from '@/stores/apiKeyStore'
import type { Message } from '@/types/mescli'
import { DAG_NODE_TYPES } from '@/types/dagWorkflow'

const SYSTEM_PROMPT = `You are a workflow designer assistant. Convert the user's natural language description into a WonWork DAG workflow JSON.

Output ONLY a JSON object matching this schema (no markdown, no explanation):

{
  "name": "short workflow name",
  "description": "short description",
  "version": "1.0.0",
  "inputSchema": {
    "factoryId": { "type": "string", "required": true, "description": "工厂编号" },
    "beginDate": { "type": "date", "required": true, "description": "分析开始日期" },
    "endDate": { "type": "date", "required": true, "description": "分析结束日期" },
    "groupBy": { "type": "select", "required": false, "default": "reason", "description": "分组方式", "options": [{ "label": "原因", "value": "reason" }, { "label": "机台", "value": "machine" }] }
  },
  "outputMapping": {
    "result": "node-1"
  },
  "nodes": [
    { "id": "start", "type": "start", "position": { "x": 0, "y": 0 }, "data": { "label": "Start" } },
    { "id": "node-1", "type": "llm", "position": { "x": 300, "y": 0 }, "data": { "label": "LLM", "llm": { "prompt": "..." } } },
    { "id": "end", "type": "end", "position": { "x": 900, "y": 0 }, "data": { "label": "End" } }
  ],
  "edges": [
    { "id": "e-start-node-1", "source": "start", "target": "node-1", "type": "default" },
    { "id": "e-node-1-end", "source": "node-1", "target": "end", "type": "default" }
  ]
}

Rules:
- node.id must be unique strings.
- node.type must be one of: ${DAG_NODE_TYPES.join(', ')}.
- The workflow MUST contain exactly one "start" node and exactly one "end" node.
- All non-start/end nodes must be reachable from start and reach end via edges.
- Use "condition" nodes for branches. Condition edges should use labels "true" and "false" and type "condition".
- Use "loop" nodes for iteration. Loop back edges should use type "loopback".
- Position nodes left-to-right with x spacing 300 and y spacing 150.
- Keep the workflow concise (3-8 nodes unless the request is complex).
- Prefer simple, robust workflows over clever ones.
- DO NOT create a node unless you can fill in its required configuration. An empty node will fail to run.
- inputSchema: describe inputs the workflow expects. Each key maps to an object with { type, required?, default?, description?, options?, min?, max?, pattern?, placeholder? }. Only include if the user provides inputs.
  - type must be one of: string, number, boolean, date, datetime, select, array, object.
  - Use "date" for dates (e.g., beginDate, endDate) and "datetime" for timestamps. Do NOT use "string" with a date format description instead of "date"/"datetime".
  - Use "select" when the input has a small fixed set of choices; provide "options" as an array of { label, value }.
  - Use "number" for numeric quantities, "boolean" for true/false flags, "array" for lists, "object" for structured records.
  - default must match the type (e.g., a date string for "date", a boolean for "boolean").
- outputMapping: map final output names to the node id that produces them (e.g. {"report": "node-2"}). Only include if useful.

Node configuration requirements (all strings unless noted):
- "start"/"end": no extra fields.
- "llm": data.llm.prompt (required), data.llm.model (optional), data.llm.systemPrompt (optional).
- "tool": data.tool.toolName (required, e.g. "create_excel_document", "execute_sql_query", "web_search"), data.tool.args (required, JSON object string, supports variable interpolation like "\${inputs.factoryId}" or "\${steps.node-1}").
- "webbridge": either data.webbridge.workflowId (string) OR data.webbridge.actions (array of BrowserAction objects). If using actions, set securityPreset optionally to one of: research-assistant, form-automation, data-extraction, monitoring, secure-enterprise.
- "database_query": data.databaseQuery.query (required SQL string), data.databaseQuery.parameters (required JSON object string), data.databaseQuery.connection (optional string).
- "file_operation": data.fileOperation.action (required: read/write/upload/download), data.fileOperation.path (required), data.fileOperation.content (string, used for write/upload), data.fileOperation.dataUrl (string, used for download).
- "condition": data.condition.conditionExpression (required, e.g. "variables.score > 80").
- "loop": data.loop.loopVariable (string, default "item"), data.loop.loopOver (required, e.g. "inputs.items"), data.loop.maxIterations (number, default 100).
- "agent_swarm": data.agentSwarm.taskDescription (required).
- "http_request": data.httpRequest.url (required), data.httpRequest.method (GET/POST/PUT/DELETE/PATCH), data.httpRequest.headers (JSON object string), data.httpRequest.body (string), data.httpRequest.timeout (number, ms).
- "send_message": data.sendMessage.channel ("log"/"notification"/"toast"), data.sendMessage.title, data.sendMessage.content.
- "javascript": data.javascript.code (required, returning an object).
- "variable": data.variable.variableName (required), data.variable.variableValue (required, supports "\${inputs.xxx}" interpolation).
- "delay": data.delay.delayMs (required, number).
- "merge": no extra fields.

- When a query node feeds a document generation node (create_pptx_document / create_excel_document / create_word_document), always set "top_n" to a reasonable limit (e.g. 30-50) in the query args to avoid passing excessive data into the document. In the document python_code, use json.loads('''\${steps.<nodeId>}''').get('data', []) (or .rows, .results) and optionally slice to the top N rows.
- **DO NOT assume fixed column names** (like "reason", "name", "value", "count") when building document tables/charts. First inspect the actual upstream data keys (e.g., print the first row keys or use list(data[0].keys())), then use the real column names that match the semantic meaning. If a value is missing, leave the cell blank; do NOT fill every cell with "-" or placeholder text.

Example: generate a report from queried data
- Node "query": type "tool", toolName "iris_report_molding_non_running", args '{"analysis_type": "report", "start_date": "\${inputs.startDate}", "end_date": "\${inputs.endDate}", "group_by": "reason", "top_n": 30}'.
- Node "ppt": type "tool", toolName "create_pptx_document", args '{"template": "business", "fileName": "report", "python_code": "import json, os\nfrom pptx import Presentation\nresult = json.loads(\'\'\'\${steps.query}\'\'\')\ndata = result.get(\'data\', [])[:30] if isinstance(result, dict) else result[:30]\nprs = Presentation()\n# ... build slides using data ...\nprs.save(os.environ[\'OUTPUT_PATH\'])"}'.
- Edge from "query" to "ppt" so the query result is available as "\${steps.query}".
- outputMapping: {"report": "ppt"}.

Example: generate a Word report from queried data
- Node "query": type "tool", toolName "iris_report_molding_non_running", args '{"analysis_type": "report", "start_date": "\${inputs.startDate}", "end_date": "\${inputs.endDate}", "group_by": "reason", "top_n": 30}'.
- Node "doc": type "tool", toolName "create_word_document", args '{"template": "business", "fileName": "report", "python_code": "import json, os\nfrom docx import Document\nresult = json.loads(\'\'\'\${steps.query}\'\'\')\ndata = result.get(\'data\', []) if isinstance(result, dict) else result\n# Inspect actual columns instead of assuming names\ncols = list(data[0].keys()) if data else []\nreason_col = next((c for c in cols if \'reason\' in c.lower() or \'原因\' in c or \'desc\' in c.lower()), cols[0] if cols else None)\ncount_col = next((c for c in cols if \'count\' in c.lower() or \'num\' in c.lower() or \'次数\' in c or \'时长\' in c), None)\ndoc = Document()\n# ... add heading and build table using actual cols, reason_col, count_col ...\ndoc.save(os.environ[\'OUTPUT_PATH\'])"}'.
- Edge from "query" to "doc" so the query result is available as "\${steps.query}".
- outputMapping: {"report": "doc"}.`

function validateNodeType(type: string): type is DagNodeType {
  return DAG_NODE_TYPES.includes(type as DagNodeType)
}

function sanitizeWorkflow(draft: Partial<DagWorkflow>): Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'> {
  const nodes: DagNode[] = []
  const edges: DagEdge[] = []

  for (const n of draft.nodes || []) {
    if (!n.id || !validateNodeType(n.type)) continue
    nodes.push({
      id: String(n.id),
      type: n.type,
      position: {
        x: typeof n.position?.x === 'number' ? n.position.x : 0,
        y: typeof n.position?.y === 'number' ? n.position.y : 0,
      },
      data: typeof n.data === 'object' && n.data !== null ? (n.data as DagNode['data']) : { label: n.type },
    })
  }

  const nodeIds = new Set(nodes.map((n) => n.id))
  for (const e of draft.edges || []) {
    if (!e.id || !nodeIds.has(e.source) || !nodeIds.has(e.target)) continue
    edges.push({
      id: String(e.id),
      source: String(e.source),
      target: String(e.target),
      label: typeof e.label === 'string' ? e.label : undefined,
      type: e.type === 'condition' || e.type === 'loopback' ? e.type : 'default',
    })
  }

  // Ensure single start/end
  const starts = nodes.filter((n) => n.type === 'start')
  const ends = nodes.filter((n) => n.type === 'end')
  if (starts.length === 0) {
    nodes.unshift({ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start' } })
  } else if (starts.length > 1) {
    throw new Error('生成的 DAG 包含多个 start 节点')
  }
  if (ends.length === 0) {
    nodes.push({ id: 'end', type: 'end', position: { x: nodes.length * 300, y: 0 }, data: { label: 'End' } })
  } else if (ends.length > 1) {
    throw new Error('生成的 DAG 包含多个 end 节点')
  }

  // Ensure start has outgoing edge
  const startId = nodes.find((n) => n.type === 'start')!.id
  const endId = nodes.find((n) => n.type === 'end')!.id
  const startHasEdge = edges.some((e) => e.source === startId)
  const endHasEdge = edges.some((e) => e.target === endId)

  if (!startHasEdge && startId !== endId) {
    const firstNonStart = nodes.find((n) => n.id !== startId && n.id !== endId)
    if (firstNonStart) {
      edges.unshift({ id: `e-${startId}-${firstNonStart.id}`, source: startId, target: firstNonStart.id, type: 'default' })
    } else {
      edges.unshift({ id: `e-${startId}-${endId}`, source: startId, target: endId, type: 'default' })
    }
  }
  if (!endHasEdge && startId !== endId) {
    const lastNonEnd = [...nodes].reverse().find((n) => n.id !== startId && n.id !== endId)
    if (lastNonEnd) {
      edges.push({ id: `e-${lastNonEnd.id}-${endId}`, source: lastNonEnd.id, target: endId, type: 'default' })
    }
  }

  return {
    name: typeof draft.name === 'string' && draft.name.trim() ? draft.name.trim() : 'Generated Workflow',
    description: typeof draft.description === 'string' ? draft.description : '',
    version: '1.0.0',
    nodes,
    edges,
    inputSchema:
      typeof draft.inputSchema === 'object' && draft.inputSchema !== null
        ? (draft.inputSchema as DagWorkflow['inputSchema'])
        : undefined,
    outputMapping:
      typeof draft.outputMapping === 'object' && draft.outputMapping !== null
        ? (draft.outputMapping as DagWorkflow['outputMapping'])
        : undefined,
  }
}

export interface DagValidationIssue {
  nodeId: string
  nodeType: DagNodeType
  message: string
}

export function validateGeneratedWorkflow(
  workflow: Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'>
): { valid: boolean; issues: DagValidationIssue[] } {
  const issues: DagValidationIssue[] = []

  for (const node of workflow.nodes) {
    if (node.type === 'start' || node.type === 'end') continue

    const data = node.data
    const add = (message: string) => issues.push({ nodeId: node.id, nodeType: node.type, message })

    switch (node.type) {
      case 'llm':
        if (!data.llm?.prompt?.trim()) add('LLM 节点的 prompt 不能为空')
        break
      case 'tool':
        if (!data.tool?.toolName?.trim()) add('Tool 节点必须指定 toolName')
        if (!data.tool?.args?.trim()) {
          add('Tool 节点必须提供 args（至少填 "{}"）')
        } else {
          try {
            JSON.parse(data.tool.args)
          } catch {
            add('Tool 节点的 args 不是有效 JSON')
          }
        }
        break
      case 'webbridge':
        if (!data.webbridge?.workflowId?.trim() && (!data.webbridge?.actions || data.webbridge.actions.length === 0)) {
          add('WebBridge 节点必须配置 workflowId 或 actions')
        }
        break
      case 'database_query':
        if (!data.databaseQuery?.query?.trim()) add('Database Query 节点必须填写 SQL 查询')
        if (!data.databaseQuery?.parameters?.trim()) {
          add('Database Query 节点必须提供 parameters（至少填 "{}"）')
        } else {
          try {
            JSON.parse(data.databaseQuery.parameters)
          } catch {
            add('Database Query 节点的 parameters 不是有效 JSON')
          }
        }
        break
      case 'file_operation':
        if (!data.fileOperation?.action) add('File Operation 节点必须选择 action')
        if (!data.fileOperation?.path?.trim()) add('File Operation 节点必须填写 path')
        break
      case 'condition':
        if (!data.condition?.conditionExpression?.trim()) add('Condition 节点必须填写 conditionExpression')
        break
      case 'loop':
        if (!data.loop?.loopOver?.trim()) add('Loop 节点必须填写 loopOver 表达式')
        break
      case 'agent_swarm':
        if (!data.agentSwarm?.taskDescription?.trim()) add('Agent Swarm 节点必须填写 taskDescription')
        break
      case 'http_request':
        if (!data.httpRequest?.url?.trim()) add('HTTP Request 节点必须填写 url')
        if (!data.httpRequest?.method) add('HTTP Request 节点必须选择 method')
        break
      case 'send_message':
        if (!data.sendMessage?.content?.trim()) add('Send Message 节点必须填写 content')
        break
      case 'javascript':
        if (!data.javascript?.code?.trim()) add('JavaScript 节点必须填写 code')
        break
      case 'variable':
        if (!data.variable?.variableName?.trim()) add('Variable 节点必须填写 variableName')
        if (!data.variable?.variableValue?.trim()) add('Variable 节点必须填写 variableValue')
        break
      case 'delay':
        if (typeof data.delay?.delayMs !== 'number') add('Delay 节点必须填写 delayMs（数字）')
        break
    }
  }

  return { valid: issues.length === 0, issues }
}

function stripBom(text: string): string {
  return text.replace(/^﻿/, '')
}

function normalizeJsonQuotes(text: string): string {
  // LLM 有时会输出中文引号，替换为 JSON 需要的直引号
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
}

function removeControlChars(text: string): string {
  // 保留 \t、\n、\r，移除其他控制字符
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

/**
 * 从 LLM 输出中提取最外层平衡的 JSON 对象或数组。
 * 尊重字符串内的 { 和 }，避免把解释性文本一并抓进来。
 */
function extractBalancedJson(text: string): string | null {
  let inString = false
  let escapeNext = false
  let depth = 0
  let start = -1

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (escapeNext) {
      escapeNext = false
      continue
    }

    if (ch === '\\' && inString) {
      escapeNext = true
      continue
    }

    if (ch === '"' && !inString) {
      inString = true
      continue
    }

    if (ch === '"' && inString) {
      inString = false
      continue
    }

    if (inString) continue

    if (ch === '{' || ch === '[') {
      if (depth === 0) {
        start = i
      }
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1)
      }
      if (depth < 0) {
        depth = 0
      }
    }
  }

  return null
}

function extractJson(text: string): string {
  const clean = stripBom(text.trim())

  // 优先从 markdown 代码块中提取
  const codeBlockMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    return normalizeJsonQuotes(removeControlChars(codeBlockMatch[1].trim()))
  }

  // 提取最外层平衡的 JSON
  const balanced = extractBalancedJson(clean)
  if (balanced) {
    return normalizeJsonQuotes(removeControlChars(balanced))
  }

  // 兜底：取第一个 { 到最后一个 }
  const firstBrace = clean.indexOf('{')
  const lastBrace = clean.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return normalizeJsonQuotes(removeControlChars(clean.slice(firstBrace, lastBrace + 1)))
  }

  return normalizeJsonQuotes(removeControlChars(clean))
}

interface GenerateRoundResult {
  workflow: Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'> | null
  rawOutput: string
  parseError?: string
}

async function generateSingleRound(
  provider: NonNullable<ReturnType<typeof useChatStore.getState>['activeProvider']>,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  messages: Message[],
  abortSignal: AbortSignal
): Promise<GenerateRoundResult> {
  return new Promise((resolve, reject) => {
    let accumulated = ''

    const onAbort = () => {
      abort()
      reject(new Error('生成 DAG 超时，请重试'))
    }
    abortSignal.addEventListener('abort', onAbort, { once: true })

    const abort = chatApi.streamChat(
      {
        provider: provider.provider,
        model: provider.model,
        baseUrl: baseUrl || provider.baseUrl,
        apiKey,
        messages,
        saveToHistory: false,
      },
      (chunk) => {
        if (chunk.type === 'content') {
          accumulated += chunk.content || ''
        }
      },
      (error) => {
        abortSignal.removeEventListener('abort', onAbort)
        reject(error)
      },
      () => {
        abortSignal.removeEventListener('abort', onAbort)
        const trimmed = accumulated.trim()
        if (!trimmed) {
          resolve({
            workflow: null,
            rawOutput: '',
            parseError: 'AI 返回了空内容，未生成任何工作流 JSON',
          })
          return
        }
        try {
          const jsonText = extractJson(accumulated)
          const parsed = JSON.parse(jsonText) as Partial<DagWorkflow>
          const sanitized = sanitizeWorkflow(parsed)
          resolve({ workflow: sanitized, rawOutput: trimmed })
        } catch (err) {
          resolve({
            workflow: null,
            rawOutput: trimmed,
            parseError: err instanceof Error ? err.message : String(err),
          })
        }
      }
    )
  })
}

function buildEmptyOutputHint(rawOutput: string): string {
  if (rawOutput) return ''
  return 'AI 未返回任何内容，请检查：模型是否可用、API Key 是否有效、网络连接是否正常，或当前提示词是否触发了内容过滤。'
}

export async function generateDagFromNaturalLanguage(
  description: string,
  options: { maxRetries?: number; timeoutMs?: number } = {}
): Promise<Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'>> {
  const provider = useChatStore.getState().activeProvider
  if (!provider) {
    throw new Error('未配置 AI 模型，请先在对话中选择一个模型')
  }

  let apiKey: string | undefined
  let baseUrl: string | undefined
  const defaultByok = useApiKeyStore.getState().getDefaultApiKey('chat')
  if (defaultByok && !defaultByok.isPlatformManaged) {
    apiKey = defaultByok.key
    baseUrl = defaultByok.baseUrl
  } else {
    try {
      const keyResult = await userConfigApi.getApiKey(provider.provider)
      apiKey = keyResult.apiKey
    } catch {
      // ignore, backend may use default key
    }
  }

  const baseMessages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: description },
  ]

  let messages: Message[] = [...baseMessages]
  let lastIssues: DagValidationIssue[] = []
  let lastRawOutput = ''
  const maxRetries = options.maxRetries ?? 3
  const timeoutMs = options.timeoutMs ?? 120000

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const result = await generateSingleRound(provider, apiKey, baseUrl, messages, controller.signal)
      lastRawOutput = result.rawOutput

      if (result.parseError) {
        if (attempt === maxRetries) {
          const emptyHint = buildEmptyOutputHint(lastRawOutput)
          throw new Error(`生成的 DAG 不是有效 JSON：${result.parseError}${emptyHint ? '\n' + emptyHint : ''}\n\n原始输出：\n${lastRawOutput || '（无输出）'}`)
        }
        messages = [
          ...baseMessages,
          { role: 'assistant', content: lastRawOutput || '（无输出）' },
          {
            role: 'user',
            content: `上面生成的内容不是有效 JSON。错误：${result.parseError}\n请修正后重新输出完整 JSON，只输出 JSON，不要 markdown、不要解释。`,
          },
        ]
        continue
      }

      const { valid, issues } = validateGeneratedWorkflow(result.workflow!)
      if (valid) {
        return result.workflow!
      }
      lastIssues = issues

      const issueText = issues.map((i) => `[${i.nodeType}:${i.nodeId}] ${i.message}`).join('\n')
      messages = [
        ...baseMessages,
        { role: 'assistant', content: lastRawOutput },
        {
          role: 'user',
          content: `上面生成的工作流配置不完整，请修正以下问题后重新输出完整 JSON：\n${issueText}\n\n请确保所有节点都填写了必需字段，只输出 JSON，不要解释。`,
        },
      ]
    } finally {
      clearTimeout(timeoutId)
    }
  }

  const detail = lastIssues.map((i) => `[${i.nodeType}:${i.nodeId}] ${i.message}`).join('\n')
  throw new Error(`经过 ${maxRetries + 1} 次尝试仍未生成完整工作流，请手动创建或补充以下配置：\n${detail}`)
}

export async function refineDagWithAi(
  workflow: Partial<DagWorkflow>,
  options: { issues?: DagValidationIssue[]; originalDescription?: string; maxRetries?: number } = {}
): Promise<Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'>> {
  const provider = useChatStore.getState().activeProvider
  if (!provider) {
    throw new Error('未配置 AI 模型，请先在对话中选择一个模型')
  }

  let apiKey: string | undefined
  let baseUrl: string | undefined
  const defaultByok = useApiKeyStore.getState().getDefaultApiKey('chat')
  if (defaultByok && !defaultByok.isPlatformManaged) {
    apiKey = defaultByok.key
    baseUrl = defaultByok.baseUrl
  } else {
    try {
      const keyResult = await userConfigApi.getApiKey(provider.provider)
      apiKey = result.apiKey
    } catch {
      // ignore, backend may use default key
    }
  }

  const workflowJson = JSON.stringify(workflow, null, 2)
  const issueText =
    options.issues?.length
      ? options.issues.map((i) => `[${i.nodeType}:${i.nodeId}] ${i.message}`).join('\n')
      : '当前工作流已通过基础校验，请检查节点配置是否合理并补全缺失的默认值。'

  const baseMessages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `请完善以下 WonWork DAG 工作流，使其可以直接运行。\n\n` +
        (options.originalDescription ? `原始意图：${options.originalDescription}\n\n` : '') +
        `当前工作流 JSON：\n${workflowJson}\n\n` +
        `需要修正的问题：\n${issueText}\n\n` +
        `请输出完整修正后的 JSON，保留用户已有的节点结构与位置，只补全缺失配置和修正错误。`,
    },
  ]

  let messages: Message[] = [...baseMessages]
  let lastIssues: DagValidationIssue[] = []
  let lastRawOutput = ''
  const maxRetries = options.maxRetries ?? 2

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60000)

    try {
      const result = await generateSingleRound(provider, apiKey, baseUrl, messages, controller.signal)
      lastRawOutput = result.rawOutput

      if (result.parseError) {
        if (attempt === maxRetries) {
          const emptyHint = buildEmptyOutputHint(lastRawOutput)
          throw new Error(`生成的 DAG 不是有效 JSON：${result.parseError}${emptyHint ? '\n' + emptyHint : ''}\n\n原始输出：\n${lastRawOutput || '（无输出）'}`)
        }
        messages = [
          ...baseMessages,
          { role: 'assistant', content: lastRawOutput || '（无输出）' },
          {
            role: 'user',
            content: `上面生成的内容不是有效 JSON。错误：${result.parseError}\n请修正后重新输出完整 JSON，只输出 JSON，不要 markdown、不要解释。`,
          },
        ]
        continue
      }

      const { valid, issues } = validateGeneratedWorkflow(result.workflow!)
      if (valid) {
        return result.workflow!
      }
      lastIssues = issues

      const nextIssueText = issues.map((i) => `[${i.nodeType}:${i.nodeId}] ${i.message}`).join('\n')
      messages = [
        ...baseMessages,
        { role: 'assistant', content: lastRawOutput },
        {
          role: 'user',
          content: `仍有问题，请继续修正后重新输出完整 JSON：\n${nextIssueText}`,
        },
      ]
    } finally {
      clearTimeout(timeoutId)
    }
  }

  const detail = lastIssues.map((i) => `[${i.nodeType}:${i.nodeId}] ${i.message}`).join('\n')
  throw new Error(`经过 ${maxRetries + 1} 次尝试仍未完善工作流：\n${detail}`)
}

// ==================== ExecutionPlan 生成 ====================

const EXECUTION_PLAN_SYSTEM_PROMPT = `You are a workflow planner. Convert the user's intent into an ExecutionPlan JSON.

Output ONLY a JSON object matching this schema (no markdown, no explanation):

{
  "name": "short workflow name",
  "description": "short description",
  "inputSchema": {
    "factoryId": { "type": "string", "required": true, "description": "工厂编号" },
    "beginDate": { "type": "date", "required": true, "description": "分析开始日期" },
    "endDate": { "type": "date", "required": true, "description": "分析结束日期" },
    "groupBy": { "type": "select", "required": false, "default": "reason", "description": "分组方式", "options": [{ "label": "原因", "value": "reason" }, { "label": "机台", "value": "machine" }] }
  },
  "outputMapping": {
    "result": "step-2"
  },
  "steps": [
    {
      "kind": "tool",
      "id": "step-1",
      "toolName": "exact_tool_name_from_catalog",
      "description": "what this step does",
      "inputs": { "factoryId": "\${inputs.factoryId}" }
    },
    {
      "kind": "workflow",
      "id": "step-2",
      "workflowId": "exact_workflow_id_from_catalog",
      "description": "what this step does",
      "inputs": { "data": "\${steps.step-1.output}" }
    },
    {
      "kind": "node",
      "id": "step-3",
      "nodeType": "llm",
      "description": "what this step does",
      "config": { "llm": { "prompt": "Summarize: \${steps.step-2.output}" } }
    }
  ]
}

Rules:
- kind must be one of: "tool", "workflow", "node".
- For "tool": toolName must exactly match a tool in the provided catalog; inputs is a JSON object. If a tool argument contains SQL, the SQL will be validated against the real database schema and executed as a trial run; do not invent table or column names.
- For "workflow": workflowId must exactly match a saved workflow in the provided catalog; inputs is a JSON object.
- For "node": nodeType must be one of: ${DAG_NODE_TYPES.join(', ')}; config follows the same structure as DagNodeData.
- Each step id must be unique within the plan. Prefer "step-1", "step-2", etc.
- Use "\${inputs.xxx}" to reference workflow inputs and "\${steps.<stepId>.<field>}" to reference upstream step outputs. Do NOT wrap these placeholders in quotes inside SQL; runtime will format strings, numbers, and dates automatically.
- Never hardcode example values (e.g., 2000, 2024, sample names, sample IDs) in SQL. All filter values must come from inputs or upstream outputs.
- If inputSchema is empty or not provided, do NOT reference \${inputs.xxx} anywhere in the plan. Query all relevant data or filter using upstream step outputs only.
- Only use "node" steps when no catalog tool or workflow can cover the intent.
- DO NOT write free SQL/Python/JS in node steps unless absolutely necessary; prefer "tool" steps.
- If you must use SQL, first discover real table names via search_schema / list_schema_tables, then confirm every column exists via get_table_schema. Fabricated table/column names will cause the plan to be rejected.
- When a step feeds a document generation tool (create_pptx_document / create_excel_document / create_word_document), set a reasonable "top_n" limit (e.g. 30-50) and pass the upstream output via \${steps.<stepId>}. In the generated python_code, use json.loads('''\${steps.<stepId>}''').get('data', []) to read the data array. **Do NOT assume fixed column names** like "reason" or "name"; inspect the first row keys and use the actual column names that match the semantic meaning. Missing values should be left blank, not replaced with "-".
- inputSchema: describe inputs the workflow expects. Each key maps to an object with { type, required?, default?, description?, options?, min?, max?, pattern?, placeholder? }. Only include if the user provides inputs.
  - type must be one of: string, number, boolean, date, datetime, select, array, object.
  - Use "date" for dates (e.g., beginDate, endDate) and "datetime" for timestamps. Do NOT use "string" with a date format description instead of "date"/"datetime".
  - Use "select" when the input has a small fixed set of choices; provide "options" as an array of { label, value }.
  - Use "number" for numeric quantities, "boolean" for true/false flags, "array" for lists, "object" for structured records.
  - default must match the type (e.g., a date string for "date", a boolean for "boolean").
- outputMapping: map final output names to the step id that produces them. Only include if useful.`

function sanitizeExecutionPlan(draft: unknown): ExecutionPlan {
  const plan = typeof draft === 'object' && draft !== null ? (draft as Record<string, unknown>) : {}

  const steps: ExecutionPlanStep[] = []
  const rawSteps = Array.isArray(plan.steps) ? plan.steps : []
  const seenIds = new Set<string>()

  for (const raw of rawSteps) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const kind = r.kind === 'tool' || r.kind === 'workflow' || r.kind === 'node' ? r.kind : 'node'
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `step-${steps.length + 1}`
    const uniqueId = seenIds.has(id) ? `${id}-${steps.length + 1}` : id
    seenIds.add(uniqueId)
    const description = typeof r.description === 'string' ? r.description : ''

    if (kind === 'tool') {
      steps.push({
        kind,
        id: uniqueId,
        toolName: typeof r.toolName === 'string' ? r.toolName.trim() : '',
        description,
        inputs: typeof r.inputs === 'object' && r.inputs !== null ? (r.inputs as Record<string, unknown>) : {},
      } as ExecutionPlanToolStep)
    } else if (kind === 'workflow') {
      steps.push({
        kind,
        id: uniqueId,
        workflowId: typeof r.workflowId === 'string' ? r.workflowId.trim() : '',
        description,
        inputs: typeof r.inputs === 'object' && r.inputs !== null ? (r.inputs as Record<string, unknown>) : {},
      } as ExecutionPlanWorkflowStep)
    } else {
      const nodeType = DAG_NODE_TYPES.includes(r.nodeType as DagNodeType) ? (r.nodeType as DagNodeType) : 'llm'
      steps.push({
        kind,
        id: uniqueId,
        nodeType,
        description,
        config: typeof r.config === 'object' && r.config !== null ? (r.config as Record<string, unknown>) : {},
      } as ExecutionPlanNodeStep)
    }
  }

  const inputSchema: ExecutionPlan['inputSchema'] =
    typeof plan.inputSchema === 'object' && plan.inputSchema !== null
      ? (plan.inputSchema as ExecutionPlan['inputSchema'])
      : {}

  const outputMapping: ExecutionPlan['outputMapping'] =
    typeof plan.outputMapping === 'object' && plan.outputMapping !== null
      ? (plan.outputMapping as ExecutionPlan['outputMapping'])
      : {}

  return {
    name: typeof plan.name === 'string' && plan.name.trim() ? plan.name.trim() : 'Generated Plan',
    description: typeof plan.description === 'string' ? plan.description : '',
    inputSchema,
    outputMapping,
    steps,
  }
}

export interface ExecutionPlanValidationIssue {
  stepId?: string
  field: string
  message: string
}

export function validateExecutionPlan(plan: ExecutionPlan): { valid: boolean; issues: ExecutionPlanValidationIssue[] } {
  const issues: ExecutionPlanValidationIssue[] = []

  if (!plan.name.trim()) {
    issues.push({ field: 'name', message: '计划名称不能为空' })
  }

  const inputKeys = new Set(Object.keys(plan.inputSchema || {}))
  const inputRefRegex = /\$\{inputs\.([^}]+)\}/g

  function collectInputRefs(value: unknown): string[] {
    const refs: string[] = []
    if (typeof value === 'string') {
      let match: RegExpExecArray | null
      while ((match = inputRefRegex.exec(value)) !== null) {
        refs.push(match[1])
      }
    } else if (Array.isArray(value)) {
      for (const item of value) refs.push(...collectInputRefs(item))
    } else if (value && typeof value === 'object') {
      for (const v of Object.values(value)) refs.push(...collectInputRefs(v))
    }
    return refs
  }

  for (const step of plan.steps) {
    const add = (field: string, message: string) => issues.push({ stepId: step.id, field, message })

    if (!step.id.trim()) {
      add('id', '步骤 id 不能为空')
      continue
    }

    switch (step.kind) {
      case 'tool':
        if (!step.toolName.trim()) add('toolName', 'Tool 步骤必须指定 toolName')
        break
      case 'workflow':
        if (!step.workflowId.trim()) add('workflowId', 'Workflow 步骤必须指定 workflowId')
        break
      case 'node':
        if (!DAG_NODE_TYPES.includes(step.nodeType)) {
          add('nodeType', `节点类型 ${step.nodeType} 不合法`)
        }
        break
    }

    // 检查引用的 inputs.xxx 是否在 inputSchema 中定义
    const stepContent = step.kind === 'node' ? step.config : step.inputs
    const refs = collectInputRefs(stepContent)
    for (const ref of refs) {
      if (!inputKeys.has(ref)) {
        add('inputs', `引用了未定义的输入变量 \${inputs.${ref}}。请在 inputSchema 中定义该输入，或改用上游步骤输出 \${steps.<stepId>.<field>}。`)
      }
    }
  }

  return { valid: issues.length === 0, issues }
}

interface ExecutionPlanGenerateRoundResult {
  plan: ExecutionPlan | null
  rawOutput: string
  parseError?: string
}

async function generateExecutionPlanSingleRound(
  provider: NonNullable<ReturnType<typeof useChatStore.getState>['activeProvider']>,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  messages: Message[],
  abortSignal: AbortSignal
): Promise<ExecutionPlanGenerateRoundResult> {
  return new Promise((resolve, reject) => {
    let accumulated = ''

    const onAbort = () => {
      abort()
      reject(new Error('生成执行计划超时，请重试'))
    }
    abortSignal.addEventListener('abort', onAbort, { once: true })

    const abort = chatApi.streamChat(
      {
        provider: provider.provider,
        model: provider.model,
        baseUrl: baseUrl || provider.baseUrl,
        apiKey,
        messages,
        saveToHistory: false,
      },
      (chunk) => {
        if (chunk.type === 'content') {
          accumulated += chunk.content || ''
        }
      },
      (error) => {
        abortSignal.removeEventListener('abort', onAbort)
        reject(error)
      },
      () => {
        abortSignal.removeEventListener('abort', onAbort)
        const trimmed = accumulated.trim()
        if (!trimmed) {
          resolve({
            plan: null,
            rawOutput: '',
            parseError: 'AI 返回了空内容，未生成任何执行计划 JSON',
          })
          return
        }
        try {
          const jsonText = extractJson(accumulated)
          const parsed = JSON.parse(jsonText) as unknown
          const sanitized = sanitizeExecutionPlan(parsed)
          resolve({ plan: sanitized, rawOutput: trimmed })
        } catch (err) {
          resolve({
            plan: null,
            rawOutput: trimmed,
            parseError: err instanceof Error ? err.message : String(err),
          })
        }
      }
    )
  })
}

export interface ExecutionPlanFeedbackItem {
  previousOutput: string
  feedback: string
}

export interface GenerateExecutionPlanOptions {
  maxRetries?: number
  timeoutMs?: number
}

async function resolveApiKeyAndBaseUrl(
  provider: NonNullable<ReturnType<typeof useChatStore.getState>['activeProvider']>
): Promise<{ apiKey?: string; baseUrl?: string }> {
  let apiKey: string | undefined
  let baseUrl: string | undefined
  const defaultByok = useApiKeyStore.getState().getDefaultApiKey('chat')
  if (defaultByok && !defaultByok.isPlatformManaged) {
    apiKey = defaultByok.key
    baseUrl = defaultByok.baseUrl
  } else {
    try {
      const keyResult = await userConfigApi.getApiKey(provider.provider)
      apiKey = keyResult.apiKey
    } catch {
      // ignore, backend may use default key
    }
  }
  return { apiKey, baseUrl }
}

function buildExecutionPlanMessages(
  description: string,
  feedbackHistory: ExecutionPlanFeedbackItem[] = []
): Message[] {
  const baseMessages: Message[] = [
    { role: 'system', content: EXECUTION_PLAN_SYSTEM_PROMPT },
    { role: 'user', content: description },
  ]

  for (const item of feedbackHistory) {
    baseMessages.push({ role: 'assistant', content: item.previousOutput })
    baseMessages.push({ role: 'user', content: item.feedback })
  }

  return baseMessages
}

export async function generateExecutionPlan(
  description: string,
  feedbackHistory: ExecutionPlanFeedbackItem[] = [],
  options: GenerateExecutionPlanOptions = {}
): Promise<ExecutionPlan> {
  const provider = useChatStore.getState().activeProvider
  if (!provider) {
    throw new Error('未配置 AI 模型，请先在对话中选择一个模型')
  }

  const { apiKey, baseUrl } = await resolveApiKeyAndBaseUrl(provider)
  const maxRetries = options.maxRetries ?? 3
  const timeoutMs = options.timeoutMs ?? 120000

  const baseMessages = buildExecutionPlanMessages(description, feedbackHistory)
  let messages: Message[] = [...baseMessages]
  let lastIssues: ExecutionPlanValidationIssue[] = []
  let lastRawOutput = ''

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const result = await generateExecutionPlanSingleRound(provider, apiKey, baseUrl, messages, controller.signal)
      lastRawOutput = result.rawOutput

      if (result.parseError) {
        if (attempt === maxRetries) {
          const emptyHint = buildEmptyOutputHint(lastRawOutput)
          throw new Error(`生成的执行计划不是有效 JSON：${result.parseError}${emptyHint ? '\n' + emptyHint : ''}\n\n原始输出：\n${lastRawOutput || '（无输出）'}`)
        }
        messages = [
          ...baseMessages,
          { role: 'assistant', content: lastRawOutput || '（无输出）' },
          {
            role: 'user',
            content: `上面生成的内容不是有效 JSON。错误：${result.parseError}\n请修正后重新输出完整 JSON，只输出 JSON，不要 markdown、不要解释。`,
          },
        ]
        continue
      }

      const { valid, issues } = validateExecutionPlan(result.plan!)
      if (valid) {
        return result.plan!
      }
      lastIssues = issues

      const issueText = issues.map((i) => `[${i.stepId ?? 'plan'}:${i.field}] ${i.message}`).join('\n')
      messages = [
        ...baseMessages,
        { role: 'assistant', content: lastRawOutput },
        {
          role: 'user',
          content: `上面生成的执行计划不完整，请修正以下问题后重新输出完整 JSON：\n${issueText}\n\n请确保所有步骤都填写了必需字段，只输出 JSON，不要解释。`,
        },
      ]
    } finally {
      clearTimeout(timeoutId)
    }
  }

  const detail = lastIssues.map((i) => `[${i.stepId ?? 'plan'}:${i.field}] ${i.message}`).join('\n')
  throw new Error(`经过 ${maxRetries + 1} 次尝试仍未生成完整执行计划，请手动创建或补充以下配置：\n${detail}`)
}

/**
 * 旧入口，保留兼容。
 */
export async function generateExecutionPlanFromNaturalLanguage(
  description: string,
  maxRetries = 3
): Promise<ExecutionPlan> {
  return generateExecutionPlan(description, [], { maxRetries })
}

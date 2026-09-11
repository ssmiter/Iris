import { createTool } from '@/agent/toolFactory'
import type { ToolExecutionContext } from '@/agent/types'
import type { WebBridgePrimitiveResult } from './webbridgePrimitives'
import {
  sendBrowserAction,
  getCurrentPageState,
  buildArtifactPath,
  writeArtifact,
  buildPrimitiveResult,
  truncateText,
} from './webbridgePrimitives'
import { safeStringify } from '@/utils/safeSerialize'

export const WEBBRIDGE_EXTRACT_TOOL_NAME = 'webbridge_extract'

type ExtractFormat = 'text' | 'html' | 'table'

interface WebBridgeExtractInput {
  format: ExtractFormat
  selector?: string
}

function formatExtractResult(format: ExtractFormat, data: unknown): string {
  if (format === 'table') {
    return safeStringify(data, 2000)
  }
  return truncateText(typeof data === 'string' ? data : safeStringify(data, 2000))
}

function buildExtractScript(format: ExtractFormat, selector?: string): string {
  const selectorLiteral = JSON.stringify(selector ?? null)
  const root = selector ? `document.querySelector(${JSON.stringify(selector)})` : 'document'
  if (format === 'text') {
    return `(${root} || document.body).innerText`
  }
  if (format === 'html') {
    return selector
      ? `(${root} || document.documentElement).outerHTML`
      : 'document.documentElement.outerHTML'
  }
  // table
  return `(() => {
    const selector = ${selectorLiteral}
    const root = ${root} || document
    const tables = selector
      ? (root.matches?.('table') ? [root] : Array.from(root.querySelectorAll('table')))
      : Array.from(document.querySelectorAll('table'))
    return tables.slice(0, 5).map(t => {
      const rows = Array.from(t.querySelectorAll('tr'))
      return rows.map(r => Array.from(r.querySelectorAll('td, th')).map(c => c.innerText))
    })
  })()`
}

export const webbridgeExtractTool = createTool<WebBridgeExtractInput, WebBridgePrimitiveResult>({
  name: WEBBRIDGE_EXTRACT_TOOL_NAME,
  description: '从当前页面提取文本、HTML 或表格。支持通过 selector 限定范围。',
  inputSchema: {
    type: 'object',
    required: ['format'],
    properties: {
      format: {
        type: 'string',
        enum: ['text', 'html', 'table'],
        description: '提取格式：text（纯文本）、html（HTML 源码）、table（表格数据）',
      },
      selector: {
        type: 'string',
        description: '可选的 CSS 选择器，用于限定提取范围',
      },
    },
  },
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: false,
  alwaysLoad: true,
  category: 'web',
  usagePrompt: '示例：{"format":"text"}；限定范围：{"format":"table","selector":"table.results"}',
  async execute(input, ctx: ToolExecutionContext): Promise<WebBridgePrimitiveResult> {
    let data: unknown

    if (input.selector) {
      const result = await sendBrowserAction(
        {
          action_type: 'evaluate',
          value: buildExtractScript(input.format, input.selector),
          description: `提取 ${input.format} (${input.selector})`,
        },
        ctx
      )
      data = result.data
    } else {
      const result = await sendBrowserAction(
        {
          action_type:
            input.format === 'text'
              ? 'extract_text'
              : input.format === 'html'
              ? 'extract_html'
              : 'extract_table',
          description: `提取 ${input.format}`,
        },
        ctx
      )
      data = result.data
    }

    const text = formatExtractResult(input.format, data)
    const pageState = (await sendBrowserAction({ action_type: 'get_url' }, ctx)).page_state_after ||
      (await getCurrentPageState())

    // 大结果落盘
    const ext = input.format === 'html' ? 'html' : input.format === 'table' ? 'json' : 'txt'
    const content = input.format === 'table' ? safeStringify(data, Number.MAX_SAFE_INTEGER) : String(data)
    if (content.length > 5000) {
      const path = buildArtifactPath(`extract_${input.format}`, ext, text.slice(0, 100))
      await writeArtifact(path, content)
      return buildPrimitiveResult(true, pageState, `${input.format} 内容较长，已保存到 ${path}，可用 read_file 深读`, {
        cachedPath: path,
      })
    }

    return buildPrimitiveResult(true, pageState, text)
  },
})

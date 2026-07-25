import type { Message } from '@/types/mescli'
import type { CapabilityRegistry } from '@/utils/capabilityRegistry'

const WEBBRIDGE_PROMPT = `你是一名浏览器自动化助手。WebBridge 提供一组浏览器操作原语，让你像操作本地文件系统一样操作浏览器：

**重要边界**：
- 普通信息检索、搜索、读取指定 URL 内容，**优先使用 web_search 和 web_fetch**，而不是 WebBridge。
- 需要浏览器自动化（截图、点击、输入、多步导航、提取动态内容）时，**使用 WebBridge 原语工具**，不要直接输出 <webbridge> 标签或工作流 JSON。
- 只有当用户**显式使用 "/web" 命令**或**点击 WebBridge 面板**时，才直接在回复中输出 <webbridge> 工作流 JSON。

**可用原语（Sense-Act-Verify）**：
- Sense：webbridge_navigate、webbridge_screenshot、webbridge_extract、webbridge_locate
- Act：webbridge_click、webbridge_type、webbridge_scroll、webbridge_wait
- 降级复合：webbridge_execute（仅用于 1-3 步简单任务）

**使用模式**：
1. 多步任务请拆解为原语链：navigate → screenshot/extract → click/type → screenshot/extract 验证。
2. 不确定元素选择器时，优先用自然语言 \`target\` 参数调用 webbridge_click / webbridge_type；内部会自动定位。搜索框等需要提交的场景，给 webbridge_type 加 \`submit: true\`。
3. 仍不确定时，先调用 webbridge_locate 获取候选选择器，再结合截图判断。
4. webbridge_click 和 webbridge_type 执行后会自动截图并返回 screenshot_path，可直接根据截图判断结果；scroll、wait 或需要更详细验证时，再调用 webbridge_screenshot / webbridge_extract。
5. 每个原语都会返回当前 \`url\` 和 \`title\`，作为下一轮决策的客观依据。
6. webbridge_execute 只接受 \`instruction\`，系统内部转工作流；仅当任务明显能在 1-3 个动作内完成时才使用。

**定位失败怎么办**：
- 不要猜测坐标或编造选择器。
- 先调用 webbridge_screenshot 查看当前页面，或 webbridge_extract 提取可见文本。
- 根据客观页面内容重新构造 target / selector。

**产物已在结果中渲染**：
- webbridge_screenshot 返回的截图会自动显示在对话中，你**不需要**再调用 glob / read_file / present_artifact 去读取或展示它。
- webbridge_extract 返回的 cached_path 如需深读，可调用 read_file；否则直接根据返回摘要总结即可。

**避免冗余循环**：
- 不要在每次 Act 后都重复调用文件工具确认图片；应直接基于最近一次 screenshot/extract 的客观结果判断下一步。
- 只有当用户明确要求保存、下载或进一步分析截图/提取内容时，才使用 read_file / present_artifact。

**注意**：
- 严禁在正常对话中输出 <webbridge> 标签。
- 字符串中的换行请使用 \\\\n 转义，确保输出合法 JSON。
- 只有在 "/web" 命令/WebBridge 面板中，才允许直接输出裸 JSON（不要包 Markdown 代码块）。`

const SUMMARY_PROMPT = `请根据以上 WebBridge 执行结果，用简洁的中文为用户生成总结。不要输出任何 <webbridge> 标签，也不要再调用 WebBridge。如果执行失败，说明原因并给出建议。`

const RETRY_PROMPT = `之前的 WebBridge 工作流执行失败。以下是当前页面状态和错误信息。请重新生成一个更精确的工作流 JSON（包裹在 <webbridge>...</webbridge> 中）来修正问题。注意：
1. 优先使用 text_exact 或 text 选择器匹配页面上的可见文本。
2. 如果元素仍不确定，先截图或提取文本确认。
3. 只输出需要修正/补充的步骤，不需要重复已经成功的导航步骤（当前页面已在目标页面）。
4. 如果提供了失败状态截图，请结合截图信息定位元素。
5. 不要在 <webbridge> 标签外解释 JSON。`

/**
 * 根据能力清单生成 WebBridge 系统提示词。
 *
 * 重构说明（v0.1 1c）：
 * - 函数签名从接收 ConnectionStatus 改为接收 CapabilityRegistry。
 * - 如果 webbridge 不在 available 列表中，返回简短声明，不输出 <webbridge> 标签格式说明。
 * - 如果可用，保持原样输出完整规则。
 */
export function getWebBridgeSystemPrompt(registry: CapabilityRegistry): string {
  const hasWebBridge = registry.available.some((c) => c.id === 'webbridge')
  const status = registry.webBridge.status

  if (!hasWebBridge) {
    return `**WebBridge 当前不可用**：WebBridge 浏览器自动化当前未连接（状态：${status}）。
如果用户请求涉及浏览器自动化，你必须明确告知：「WebBridge 当前未连接，无法执行浏览器自动化。如需使用，请先连接 WebBridge Daemon。」
**不要**输出任何 <webbridge> 标签或工作流 JSON。`
  }

  return WEBBRIDGE_PROMPT
}

export function getWebBridgeSummaryPrompt(): string {
  return SUMMARY_PROMPT
}

export function getWebBridgeRetryPrompt(): string {
  return RETRY_PROMPT
}

export function sanitizeControlCharacters(text: string): string {
  // 若已是合法 JSON，直接返回，确保幂等且避免二次净化破坏已转义字符
  try {
    JSON.parse(text)
    return text
  } catch {
    // 继续清理
  }

  // 移除 JSON 中非法的控制字符（保留 tab/LF/CR，后面会转义）
  let cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')

  // 使用 Unicode 私有使用区字符作为占位符，避免与原文冲突
  const PLACEHOLDER_NL = ''
  const PLACEHOLDER_TAB = ''
  const PLACEHOLDER_CR = ''

  const protectAndEscape = (escapedLiteral: string, placeholder: string, rawChar: RegExp, escaped: string) => {
    cleaned = cleaned.split(escapedLiteral).join(placeholder)
    cleaned = cleaned.replace(rawChar, escaped)
    cleaned = cleaned.split(placeholder).join(escapedLiteral)
  }

  protectAndEscape('\\n', PLACEHOLDER_NL, /\n/g, '\\n')
  protectAndEscape('\\t', PLACEHOLDER_TAB, /\t/g, '\\t')
  protectAndEscape('\\r', PLACEHOLDER_CR, /\r/g, '\\r')

  return cleaned
}

const WEBBRIDGE_TAG_REGEX = /<webbridge>([\s\S]*?)<\/webbridge>/

export function extractWebBridgeWorkflow(content: string): { cleanedContent: string; jsonText?: string } {
  const match = WEBBRIDGE_TAG_REGEX.exec(content)
  if (!match) {
    return { cleanedContent: content }
  }

  const jsonText = match[1].trim()
  const cleanedContent = content.replace(match[0], '').trim()
  return { cleanedContent, jsonText }
}

export function extractWebBridgeWorkflowSafe(content: string): { cleanedContent: string; jsonText?: string; parseError?: string } {
  const result = extractWebBridgeWorkflow(content)
  if (!result.jsonText) return result

  const sanitized = sanitizeControlCharacters(result.jsonText)
  try {
    JSON.parse(sanitized)
    return { cleanedContent: result.cleanedContent, jsonText: sanitized }
  } catch (err) {
    const parseError = err instanceof Error ? err.message : 'JSON parse error'
    try {
      JSON.parse(result.jsonText)
      return { cleanedContent: result.cleanedContent, jsonText: result.jsonText }
    } catch {
      return { cleanedContent: result.cleanedContent, jsonText: sanitized, parseError }
    }
  }
}

export function hasWebBridgeResultPrefix(content: string): boolean {
  return content.startsWith('[WebBridge执行结果]')
}

export function buildWebBridgeResultMessage(results: unknown[]): string {
  const resultText = JSON.stringify(results, null, 2)
  return `[WebBridge执行结果]\n\`\`\`json\n${resultText}\n\`\`\``
}

export function buildWebBridgeResultSummary(workflowName: string, results: unknown[]): string {
  const items = Array.isArray(results) ? results : []
  const successCount = items.filter((r: unknown) => (r as { success?: boolean })?.success).length
  const total = items.length

  let extracted = ''
  for (const item of items) {
    const data = (item as { data?: unknown; action?: { action_type?: string } })?.data
    const actionType = (item as { action?: { action_type?: string } })?.action?.action_type
    if (!data) continue
    if (actionType === 'extract_text' || actionType === 'extract_html') {
      extracted = String(data).slice(0, 200)
      break
    }
    if (actionType === 'extract_table' && Array.isArray(data)) {
      extracted = `共 ${data.length} 行数据`
      break
    }
    if (actionType === 'get_url' || actionType === 'get_title') {
      extracted = String(data)
      break
    }
  }

  let summary = `工作流 "${workflowName}" 执行完成，${successCount}/${total} 个动作成功。`
  if (extracted) {
    summary += ` 提取到：${extracted}${extracted.length >= 200 ? '...' : ''}`
  }
  return summary
}

export function buildWebBridgeRetryMessage(error: string, pageState: string): string {
  return `[WebBridge执行失败，请重试]\n错误：${error}\n\n当前页面状态：\n\`\`\`json\n${pageState}\n\`\`\``
}

export function suppressWebBridgePrompt(messages: Message[]): Message[] {
  return messages.filter((m) => !(m.role === 'system' && m.content.includes('WebBridge')))
}

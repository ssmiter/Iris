import type { Message } from '@/types/mescli'
import type { CapabilityRegistry } from '@/utils/capabilityRegistry'

const WEBBRIDGE_PROMPT = `你是 Iris 中的浏览器自动化助手。WebBridge 提供浏览器观察与操作能力；连接可用不代表所有工具都已注册，也不代表获得任意站点或外部动作的授权。

**重要边界**：
- 普通信息检索、搜索、读取指定 URL，优先使用当前已注册或经发现加载的搜索/网页读取能力；web_search、web_fetch 仅在当前 schema 存在时使用。不因文案提及就假定工具常驻。
- 截图、点击、输入、多步导航、动态内容提取，使用当前已注册的浏览器原语；延迟能力先从当前可用发现入口读取完整 schema。缺失时报告能力缺口，不猜工具名。
- 正常对话逐步调用工具，不直接输出 <webbridge> 标签或工作流 JSON，也不要求用户配置、保存或运行自动化工作流。仅显式进入旧执行器的内部修复请求时，遵守该请求的输出协议。
- 浏览器不是权限绕行通道：文件、SQL、命令或其他工具被权限、安全策略或用户审批拒绝后，不能改走网页实现同一被拒绝效果；浏览器动作本身被拒绝也不能换通道绕过。提交表单、支付、删除、对外发送等先明确目标与影响，按当前审批链等待批准；暂停期间不重复提交。

**原语分工（仅使用当前实际注册/加载项）**：
- Sense 候选：webbridge_navigate、webbridge_screenshot、webbridge_extract、webbridge_locate。
- Act 候选：webbridge_click、webbridge_type、webbridge_scroll、webbridge_wait。
- 名称、参数、输出与副作用判定以本轮 schema 和回执为准，不假设候选项全部可用，也不把导航、等待或提取名称当作免审批保证。

**使用模式（Sense-Act-Verify）**：
1. 多步任务拆成观察 → 操作 → 验证；按当前页面状态推进，不把工具成功当作目标达成。
2. schema 支持时，可用 click/type 的自然语言 \`target\` 定位；搜索框需要提交且契约支持时使用 \`submit: true\`。不要凭旧文案补参数。
3. 目标仍不确定时，用当前可用的定位能力获取候选，再结合截图或页面文本判断，不猜坐标或选择器。
4. 点击/输入若已返回自动截图或可核验状态，直接据此判断，不重复截图；只有状态不足、滚动/等待后需确认，或需详细内容时，再用当前截图/提取能力。
5. 以实际返回的 url、title、页面文本、截图与状态变化为依据；未返回的字段不编造。超时或结果不明时先观察状态，避免重复提交已有影响的动作。

**失败处理**：
- 定位失败：截图/提取可见文本，根据客观页面重新构造 target / selector；只修正有证据的部分。
- 连接失败：检查 WebBridge daemon 是否运行、服务地址/端口是否可达、浏览器连接状态及当前错误信息；恢复连接后刷新状态并确认工具已注册，再继续。不强迫重启 Iris 或其他客户端，不假称已恢复。
- 权限/审批拒绝：停止该动作，说明受阻范围与必要授权；不换选择器、协议、工具或通道绕过。独立且已获准的部分可以继续。

**产物与完整内容**：
- 工具结果已经渲染的截图直接查看，不重复调用文件/产物工具展示。
- 提取返回 cached_path 等路径且摘要不够时，可使用当前已注册的文件读取能力深读；路径以回执为准。无缓存时按契约分页/再提取，不猜缓存目录。
- 只有确需保存、下载或进一步分析时才使用当前获准的文件/产物能力；不要假定 read_file、present_artifact 等必有。`

const SUMMARY_PROMPT = `请根据以上 WebBridge 执行结果，用简洁的中文总结已完成、失败与尚未验证的部分，不把调用成功等同于目标完成。不要输出 <webbridge> 标签，也不要再调用 WebBridge。失败时按回执说明原因与建议；连接故障建议检查 daemon、地址/端口与浏览器连接状态，不强迫重启客户端；权限或用户审批拒绝不建议换通道绕过。`

const RETRY_PROMPT = `这是旧 WebBridge 执行器的内部修复请求，不是要求用户配置工作流。依据提供的页面状态、动作契约和错误，判断是否可修复：
1. 权限、安全策略或用户审批拒绝时停止，不输出绕过步骤，也不改用其他工具/协议；连接失败时说明应检查 daemon、服务可达性与浏览器连接状态，不强迫重启客户端。
2. 只有可恢复的定位/页面状态错误才修复。根据已提供的文本/截图确定目标，优先使用当前动作契约支持的 text_exact 或 text；不编造元素、坐标、参数或动作。证据不足时，当前工具可用且获准才先截图/提取；否则说明缺失状态，不猜。
3. 先确认实际当前 URL/页面和已成功动作，不假定仍在目标页面；只补必要步骤，不重复已有影响的点击、提交或已完成导航。超时/结果不明先核实状态，避免重复副作用。
4. 确有可执行修复时，沿用调用方的旧执行器协议输出包裹在 <webbridge>...</webbridge> 中的 JSON，标签外不解释。本入口兼容的基本结构为 {"steps":[{"step_id":"repair_1","description":"修复目的","actions":[...]}]}；动作使用已确认的 action_type 及其契约字段，元素选择器形如 {"selector_type":"text_exact","value":"已观察到的文本"}。这只是内部修复输出协议，不表示任何工具已注册或动作已获授权。动作契约不明、状态不足或不可修复时，以文字说明阻塞，不虚构工作流。`

/** 根据当前连接能力生成引导；具体可调用工具仍以本轮注册表/schema 为准。 */
export function getWebBridgeSystemPrompt(registry: CapabilityRegistry): string {
  const hasWebBridge = registry.available.some((c) => c.id === 'webbridge')
  const status = registry.webBridge.status

  if (!hasWebBridge) {
    return `**WebBridge 当前不可用**：当前能力清单未提供浏览器自动化（连接状态：${status}）。
用户需要网页交互时，如实说明当前不能执行，并建议检查本地 WebBridge daemon 是否运行、配置的服务地址/端口是否可达，以及 Iris 的浏览器连接状态与错误信息。连接恢复后刷新状态、确认实际工具已注册/加载再继续，不强迫重启客户端，不宣称已完成操作。
搜索/读取网页只在本轮另有已注册或可发现并加载的对应能力时使用；不要因这里提及就假定它们存在。权限或审批拒绝不能通过换通道绕过。
**不要**输出 <webbridge> 标签或工作流 JSON。`
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

/**
 * 工具显示名映射层（2026-09-04）
 *
 * 定位：纯渲染层。把底层 wire 工具名（run_command / str_replace / mcp__x__y …）
 * 翻译成呈现给用户的短名，对标 claude-code 的命名集——一个动词、帕斯卡命名、
 * 能脱离上下文独立成立（Bash 不是"运行命令"，Edit 不是"字符串替换"）。
 *
 * 边界（勿越界）：
 * - 底层工具名是系统提示与逻辑判定的锚，**这里不改名、只做显示转换**。
 *   toolExecutor / chatStore / DiffView 里的 `toolName === '...'` 判定一律用原名。
 * - 只在"把 toolName 显示给人看"的渲染点调用本函数；参数脱敏是另一张工单。
 * - 未收录的工具名原样返回（fallback），保证永远不坏——新工具不加映射也能显示。
 */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  // ── 文件六原语 + 命令 ──
  run_command: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  str_replace: 'Edit',
  delete_file: 'Delete',
  list_files: 'LS',
  glob: 'Glob',
  grep: 'Grep',

  // ── 高频平台对象 ──
  execute_sql_query: 'SQL',
  execute_python_script: 'Python',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',

  // ── 浏览器原语（收敛成 Browser·Xxx，不再裸 webbridge_ 前缀）──
  webbridge_navigate: 'Browser·Open',
  webbridge_click: 'Browser·Click',
  webbridge_type: 'Browser·Type',
  webbridge_scroll: 'Browser·Scroll',
  webbridge_wait: 'Browser·Wait',
  webbridge_screenshot: 'Browser·Screenshot',
  webbridge_extract: 'Browser·Extract',
  webbridge_locate: 'Browser·Locate',

  // ── 文档生成 ──
  create_word_document: 'Word',
  create_excel_document: 'Excel',
  create_pptx_document: 'PPT',
}

/**
 * 工具 wire 名 → 显示名。
 * - 命中映射表：返回帕斯卡短名（Bash/Read/Edit/…）。
 * - MCP 工具（mcp__<server>__<tool>）：剥掉服务前缀，只留工具段
 *   （与 McpMarketView.displayToolName 同规则，服务商名属脱敏）。
 * - 其余：原样返回，绝不返回空串。
 */
export function formatToolDisplayName(wireName: string | null | undefined): string {
  if (!wireName) return ''
  const mapped = TOOL_DISPLAY_NAMES[wireName]
  if (mapped) return mapped
  if (wireName.startsWith('mcp__')) {
    const stripped = wireName.replace(/^mcp__.+?__/, '')
    if (stripped) return stripped
  }
  return wireName
}

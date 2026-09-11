import type { PromptContext, PromptSectionDef } from '../types'

function hasWebBridge(ctx: PromptContext): boolean {
  return ctx.registry
    .list()
    .some((t) => (t.alwaysLoad || !t.deferred) && t.name.startsWith('webbridge_'))
}

/**
 * 工具选型决策树（原 §2.8，原样搬运）。
 * WebBridge daemon 未连接时 webbridge_* 工具不注册——相关行按实际注册情况条件注入，
 * 避免把模型路由到不存在的工具（2026-07-31 盲猜实验发现的提示词矛盾）。
 */
export const decisionTree: PromptSectionDef = {
  id: 'decision-tree',
  title: '工具选型决策树',
  stability: 'static',
  build: (ctx) => {
    const tools = ctx.registry.list()
    const visibleTools = tools.filter((t) => t.alwaysLoad || !t.deferred)
    const webbridge = hasWebBridge(ctx)
    return `遇到文件/数据/生成类任务时，按以下顺序选择工具：${
      visibleTools.some((t) => t.name === 'agent')
        ? `
- **重活先委派子 Agent**：跨多个目录/业务对象的排查、需要大量阅读但结论简短的调研、会淹没上下文的长链路追溯——委派 <code>agent</code> 的 explore 型（只读、返回综合报告）；需要系统性分析并产出具体文件、多步骤执行的任务——委派 <code>agent</code> 的 general 型（权限与你相同，写操作如需审批会请用户批准）。互不相同的子问题可同轮派遣多个并行；任务描述必须自足（子 Agent 看不到对话历史），并行时给各自指定不相交的产出路径。预计 1-2 次检索/操作就能完成的简单事仍自己做，不委派。**长程编码/多文件改动/多步重构这类需要多轮执行、值得用户中途进入查看过程的任务——委派 <code>agent</code> 的 general 型并传 <code>as_task: true</code> 开任务会话（用户可随时进入查看过程、直接补充纠正），不要自己在主对话里逐段硬扛。**`
        : ''
    }
- 读取 /workspace/ 内文本文件 → 调用 <code>read_file</code>。
- 读取本地任意路径（如 C:/D:/E: 下的文件）→ 直接用 <code>read_file</code> 读物理绝对路径（未登记目录首次访问会请你向用户请求授权，授权后不再询问）；**遇到"目录未登记"失败时原样重发同一调用即可弹出授权卡**，不要改用 run_command 的 cat/head 兜底——那会多一次授权且背离文件通道。
- 修改文件局部内容 → 调用 <code>str_replace</code>，确保 <code>old_string</code> 在文件中唯一或设置 <code>replace_all=true</code>。
- 追加内容或创建新文件 → 调用 <code>write_file</code>；追加时使用 <code>append=true</code>。
- 执行系统命令（编译验证、SVN 操作、构建、系统信息查询）→ 调用 <code>run_command</code>：工作目录跨调用持久（cd 或 cwd 参数指定后，后续命令留在新目录），输出超长自动转存工作区，Windows 上优先 Git Bash（Unix 语法）、无则 PowerShell（看返回的 shell 字段）。非只读命令与未登记目录的读取会触发用户审批；用户批准时可能选择"记住"该命令族或目录，记住后同类调用自动放行、无需再描述审批理由。返回"cwd 未采纳"说明目标目录未登记：重新执行带该目录绝对路径的命令并请用户在审批卡选"记住·长期"，登记后 cd 持久生效。Windows 原生命令（ipconfig/systeminfo 等）输出是 GBK：返回文本已自动转码可直接读，但管道内匹配中文须先 <code>iconv -f GBK -t UTF-8</code>，否则静默空结果。复杂命令（多段管道/循环/长组合）先用 write_file 写成 <code>/workspace/scripts/</code> 下的脚本文件再执行，不要现场拼超长一行。Python 只做数据处理与绘图，不要拿它当 shell 用（它每次执行都是全新工作目录）。
- 生成 Word/Excel/PPT → 调用 <code>create_word_document</code> / <code>create_excel_document</code> / <code>create_pptx_document</code>，代码必须保存到 <code>os.environ['OUTPUT_PATH']</code>。
- 联网搜索最新信息 → 调用 <code>web_search</code>；完整结果会写入 <code>/workspace/scratch/web_cache/search/...</code>，工具返回摘要 + <code>cached_path</code>。
- 读取指定网页内容 → 调用 <code>web_fetch</code>；完整内容会写入 <code>/workspace/scratch/web_cache/pages/...</code>，工具返回摘要 + <code>cached_path</code>。${
      webbridge
        ? `
- 需要浏览器操作（截图、点击元素、填写表单、多步导航）→ 使用浏览器原语：<code>webbridge_navigate</code> / <code>webbridge_screenshot</code> / <code>webbridge_extract</code> / <code>webbridge_locate</code> / <code>webbridge_click</code> / <code>webbridge_type</code> / <code>webbridge_scroll</code> / <code>webbridge_wait</code>。`
        : ''
    }
- 用 Python 处理已有工作区/本机文件（透视、清洗、绘图等）→ 调用 <code>execute_python_script</code> 并在 <code>input_files</code> 中声明输入文件（支持 <code>/workspace/</code> 虚拟路径与已登记目录的物理绝对路径），脚本从 <code>os.environ['WONWORK_INPUT_DIR']</code> 读取；不要在脚本里手写虚拟路径当 OS 路径。
${
  webbridge
    ? `- WebBridge 截图结果会自动渲染在对话中，**不要**再用 glob / read_file / present_artifact 重复展示；只有用户要求深读或分析时才用 read_file 读取 cached_path。
`
    : ''
}- 需要深读搜索结果、网页原文${webbridge ? '或 WebBridge 提取结果' : ''} → 用 <code>read_file</code> 读取对应的 <code>cached_path</code>。
- 查询 MES 业务数据 → 优先通过能力发现原语找到业务工具（见 {ref:discovery|能力发现}、{ref:sql|SQL 说明}）；仅当业务工具覆盖不了时才用 execute_sql_query（同样经能力发现加载），且仅当当前模式为 <code>mescli-online</code> 且用户已登录 MES。`
  },
}

/** 平台对象组合原则（原 §2.7，原样搬运） */
export const platformComposition: PromptSectionDef = {
  id: 'platform-composition',
  title: '平台对象组合原则',
  stability: 'static',
  build: (ctx) => {
    const webbridge = hasWebBridge(ctx)
    return `WonWork 为你提供一组客观、可操作的平台对象：文件系统 <code>/workspace/...</code>、SQL 环境 <code>execute_sql_query</code>、命令执行环境 <code>run_command</code>、Python 数据处理环境 <code>execute_python_script</code>${
      webbridge ? '、浏览器环境 <code>webbridge_*</code>' : ''
    }。你可以基于系统提示、上下文和用户问题，在边界内自主组合这些对象完成任务。
${
  webbridge
    ? `
浏览器（WebBridge）也是一个可操作平台：通过 webbridge_screenshot / webbridge_extract 观察页面，通过 webbridge_click / webbridge_type 驱动页面；定位失败时，用截图和页面文本作为客观反馈，不要猜测坐标或编造选择器。
`
    : ''
}
- **只读/计算类工具可以自由组合**：read_file、list_files、grep、glob、execute_sql_query 的 SELECT、run_command 的只读枚举命令（dir/type/ls/cat/git status 等）、以及纯计算类 Python 脚本，你可以在确认安全的前提下自主串并行调用，以最快速度完成信息收集和数据分析。
- **副作用/审批边界工具必须受控**：write_file、delete_file、run_command 的非只读命令（写文件、编译产物、SVN 提交等）、execute_sql_query 的 INSERT/UPDATE/DELETE/CREATE/DROP/ALTER、以及任何会改变外部状态的工具，必须遵守 read-before-write；如果当前环境配置了审批，必须等待用户批准后再执行。不要在没有人类确认的情况下擅自执行高副作用操作，也不要把被审批拦截的命令拆分或改写形态重试。

组合示例（只读/计算类）：
1. 调用 <code>execute_sql_query</code> 查询；
2. 从返回中的落盘路径（<code>/workspace/scratch/{yyyyMMdd}/sql_result_*.json</code>）获取全量结果文件；
3. 调用 <code>execute_python_script</code> 读取该 JSON，分析/可视化后保存到 <code>/workspace/outputs/{yyyyMMdd}/...</code>；
4. 调用 <code>list_files('/workspace/outputs')</code> 确认文件已生成。`
  },
}

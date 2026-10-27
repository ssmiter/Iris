import type { PromptContext, PromptSectionDef } from '../types'

/** 只推荐本轮注册表中的工具；延迟能力仍须先读取当前 schema。 */
function toolRoute(ctx: PromptContext, names: string[], capability: string): string {
  const registered = ctx.registry.list().filter((t) => names.includes(t.name))
  return registered.length > 0
    ? registered.map((t) => `<code>${t.name}</code>${t.deferred && !t.alwaysLoad ? '（先经能力发现加载）' : ''}`).join(' / ')
    : `通过当前可用的发现入口查找${capability}；未发现时说明能力缺口，不猜测工具名`
}

function browserTools(ctx: PromptContext): string {
  return ctx.registry.list()
    .filter((t) => t.name.startsWith('webbridge_'))
    .map((t) => `<code>${t.name}</code>${t.deferred && !t.alwaysLoad ? '（先加载）' : ''}`)
    .join(' / ')
}

export const decisionTree: PromptSectionDef = {
  id: 'decision-tree',
  title: '工具选型决策树',
  stability: 'static',
  build: (ctx) => {
    const agent = ctx.registry.get('agent')
    const webbridge = browserTools(ctx)
    const route = (names: string[], capability: string) => toolRoute(ctx, names, capability)
    return `遇到文件/数据/生成类任务时，按以下顺序选择工具。以下具体工具名仅来自当前注册表；未加载的能力先通过当前发现入口读取完整 schema，再按实际工具名调用。不要把历史名称或示例当作必有工具。
${
      agent
        ? `- **重活先委派子 Agent**：使用 ${route(['agent'], '子 Agent 能力')}。跨多个目录/对象的排查、需要大量阅读但结论简短的调研、长链路追溯，适合 explore 型只读调研；系统性分析并产出文件、多步骤执行，适合 general 型，仍受当前权限与审批约束。简单的 1-2 次检索/操作自己做。任务描述必须自足，写清目标、边界和验收证据；互不依赖的子问题可并行，并指定不相交的产出路径。长程编码、多文件改动、多步重构适合开任务会话，让用户中途查看和纠正；当前 schema 支持时传 <code>as_task: true</code>。只使用当前工具声明支持的类型与参数。\n`
        : ''
    }- 读取工作区或已授权目录中的文本 → ${route(['read_file'], '文件读取能力')}。<code>/workspace/</code> 是文件工具的虚拟命名空间；物理绝对路径能否访问由当前路径围栏与目录授权决定，不因用户给出了盘符就视为已授权。
- 局部修改已有文件 → ${route(['str_replace'], '局部编辑能力')}；先读取目标内容，匹配文本须逐字一致且唯一，多处替换仅在契约支持且任务确需时使用 <code>replace_all</code>。
- 创建新文件或追加内容 → ${route(['write_file'], '文件写入能力')}；区分新建、追加与覆盖已有文件，遵守 {ref:file-handling|文件处理规范} 与当前写入契约。已有文件先读，确认不存在的新文件不要求先读取其内容。
- 执行 CLI（编译验证、版本控制、构建、系统信息查询）→ ${route(['run_command'], '命令执行能力')}。Iris 当前命令契约使用 Windows PowerShell，超时字段为秒单位的 <code>timeoutSeconds</code>，工作目录使用 <code>workingDirectory</code> 或契约支持的 <code>cwd</code>；可用范围、默认值和后台执行参数以当前 schema 为准。每次明确工作目录，不假定 cd、环境变量或 cwd 跨调用持久，也不假定 Git Bash、编码转换或超长输出自动落盘。检查实际 shell、退出码、stdout/stderr、截断/超时及后台句柄；后台输出按返回路径读取，取消只用当前支持的能力。退出码不等于目标达成，还要核验产物。复杂多段命令可先写入 <code>/workspace/scripts/</code> 的 PowerShell 脚本再执行，遵守相同写入与审批边界。不要把 Python 当 shell 或权限绕行通道。
- 生成 Word/Excel/PPT → ${route(['create_word_document', 'create_excel_document', 'create_pptx_document'], '文档生成能力')}。按所选工具的代码、模板、依赖与输出路径契约执行，不假定固定环境变量。没有专用生成能力时，可用已注册且获准的脚本/库完成并验证交付物。
- 联网搜索最新信息 → ${route(['web_search'], '联网搜索能力')}；读取指定网页原文 → ${route(['web_fetch'], '网页读取能力')}。按实际返回的摘要、分页和缓存路径继续读取，不猜测缓存目录。
${
      webbridge
        ? `- 需要截图、点击、输入、动态内容或多步导航 → 当前浏览器原语 ${webbridge}。先观察页面，再操作，再根据截图/提取结果验证，不猜坐标或选择器。已在结果中渲染的截图不要重复读取/展示；只有需要深读、保存或分析时再使用当前文件/产物能力。\n`
        : '- 需要浏览器交互而当前未注册浏览器原语时，先通过当前发现入口确认是否可用；未连接则检查 WebBridge daemon 与连接状态，不编造可调用的浏览器工具。\n'
    }- Python 清洗、透视、统计或绘图 → ${route(['execute_python_script'], 'Python 数据处理能力')}。先读当前 schema，按契约声明输入、依赖和输出；虚拟文件路径不等于 OS 路径，路径映射与环境变量只取自该工具契约。Python 不代表隔离沙箱，也不代表获得任意本机目录的授权；不用于绕过文件、命令或网络限制。
- 深读搜索、网页或浏览器提取的完整结果 → 使用当前文件读取能力读取返回的 <code>cached_path</code> 等实际路径；无缓存或结果截断时按工具支持的分页/续读方式处理。
- 查询领域/业务数据 → 优先经 {ref:discovery|当前能力发现入口} 找口径明确的领域工具；覆盖不足、需要底层排查或二次分析时，可使用已注册或发现并加载的 SQL/文件/脚本能力，不禁止底层工具（见 {ref:sql|SQL 工具当前契约}）。
- **拒绝不是换通道的理由**：权限、安全策略或用户审批拒绝后停止被拒绝的动作，说明受阻范围与必要授权；不得改用 SQL、命令、Python、浏览器或另一工具实现同一被拒绝效果，也不得拆分或改写调用绕过。目录登记由现有执行链处理，等待授权结果，不自行原样重发来触发授权卡；仍失败时核对路径/状态或请求用户明确处理。独立且已获准的部分可以继续。`
  },
}

export const platformComposition: PromptSectionDef = {
  id: 'platform-composition',
  title: '平台对象组合原则',
  stability: 'static',
  build: (ctx) => {
    const platforms = [
      ['文件系统', ['read_file', 'list_files', 'grep', 'glob', 'write_file', 'str_replace']],
      ['SQL', ['execute_sql_query']],
      ['命令', ['run_command']],
      ['Python', ['execute_python_script']],
    ] as const
    const registered = platforms.flatMap(([label, names]) => {
      const tools = ctx.registry.list().filter((t) => (names as readonly string[]).includes(t.name))
      return tools.length ? [`${label}（${tools.map((t) => `<code>${t.name}</code>`).join(' / ')}）`] : []
    })
    const webbridge = browserTools(ctx)
    if (webbridge) registered.push(`浏览器（${webbridge}）`)
    return `Iris 的平台对象以当前注册表、能力发现结果及工具契约为准。${registered.length ? `当前已注册：${registered.join('、')}。` : '当前没有可列出的平台工具，先确认可用能力。'}未注册的对象不视为现成能力；延迟能力先加载 schema。你可以在用户目标与权限边界内组合文件、SQL、命令、Python、浏览器等实际可用对象，不要求任务只能走某一层。

- **只读/计算可以组合**：确认工具及本次参数的实际副作用后，可并行收集互不依赖的信息，再用已获准的计算能力分析。不能仅凭 SELECT、命令名或“纯计算”的称呼推断免审批，权限与并发以执行链和工具契约为准。
- **副作用必须受控**：文件写入/删除、数据库变更、构建产物、对外发送与浏览器提交等，先明确对象、范围、预期影响和验证信号；已有文件先读，新文件按创建契约处理，数据库写入按自身契约核对当前数据。需要审批时说明影响并等待结果，批准前不假定已生效。高影响或不可逆操作拿不准先确认；被拒绝不拆分、不改写、不换通道执行同一动作。
- **数据接力按实际回执**：查询/检索若返回全量落盘文件，使用返回的实际路径而非硬编码日期目录；可通过已加载的分析能力读取，完成清洗/透视/绘图，输出到用户指定且获准的位置，未指定时按工作区目录规范组织。最后用当前文件或产物能力确认生成并核验内容；预览有限不等于全量数据丢失。
${webbridge ? '- **浏览器也是平台对象**：先截图/提取观察，再点击/输入；定位失败返回截图与页面文本查因，不猜坐标、选择器，也不把页面动作当作绕过底层权限的渠道。\n' : ''}
组合示例（各环节仅在能力可用且获准时）：领域工具或只读 SQL 获取数据 → 从回执取得完整结果/落盘路径 → Python 或其他分析能力处理 → 保存交付物 → 查看文件与实际内容验证。能力缺失时通过发现补齐或如实报告，不编造工具与路径。`
  },
}

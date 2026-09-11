/**
 * 工作区标准目录（打磨任务2 S2，单一事实来源）。
 *
 * 与后端 WorkspaceFileService 的目录常量一一对应；所有 prompt 只引用本文件，
 * 不在各处手写目录语义，避免前后端/prompt 三处漂移。
 *
 * files/ 为遗留目录（语义与 scratch 重叠）已退役：后端新写入重定向到 scratch/，
 * 旧文件可读、72h 自然清理，不再出现在 prompt 中。
 *
 * 落盘分层规范（2026-08-06，用户拍板）：新落盘点的去向按**文件的第一读者**判定——
 * - 人读（用户打开/预览/下载的交付物）→ deliverable 目录（uploads/outputs/sync），
 *   会进工作区文件动态注记（buildRecentFilesTailNote）；
 * - 机器读（工具接力原料、排查轨迹等中间态）→ scratch/（72h 自清，接力在会话内完成，
 *   窗口足够），不进注记；后端对应 ResolveScratchPath；
 * - 应用自身状态（DB、索引、向量库）→ data/，永不进 prompt。
 * 边界 case 同判据：子 agent 报告 .md 第一读者是人→outputs；其 .trace.json 是排查
 * 原料→scratch；sql_result 是 python 接力原料→scratch；截断全量落盘是模型接力→scratch。
 * 后端词汇早已齐备（ResolveGeneratedPath/ResolveScratchPath/ResolveUploadPath），
 * 规范落的是调用点分类纪律，不是新机制。
 */

export interface WorkspaceDirSpec {
  /** /workspace/ 下的目录名 */
  name: string
  /** 语义说明（面向模型） */
  semantics: string
  /** 保留策略（面向模型） */
  retention: string
  /**
   * 用户交付物命名空间（2026-08-06）：工作区文件动态注记（buildRecentFilesTailNote）
   * 只报这些目录的新增/修改；未标记的目录（scratch 中间态、data 应用内部库文件等）
   * 是内部信号，不进注记。
   */
  deliverable?: boolean
}

export const WORKSPACE_STANDARD_DIRS: WorkspaceDirSpec[] = [
  {
    name: 'uploads',
    semantics: '用户上传的附件，按日期分目录（uploads/{yyyyMMdd}/），同名自动版本化',
    retention: '较长保留，显式删除',
    deliverable: true,
  },
  {
    name: 'outputs',
    semantics: '交付物：工具/模型生成的报表、Word/Excel/PPT、图表等，按日期分目录（outputs/{yyyyMMdd}/）',
    retention: '30 天轮转清理',
    deliverable: true,
  },
  {
    name: 'scratch',
    semantics: '中间产物与临时文件，按日期分目录（scratch/{yyyyMMdd}/）；用于步骤间传递数据',
    retention: '72 小时自动清理',
  },
  {
    name: 'sync',
    semantics: "外部资料副本：确需纳入工作区的外部资料（交付物、反复处理的数据集）放 sync/<name>/ 下；沙箱内必须用 os.path.join(os.environ['WONWORK_WORKSPACE_ROOT'], 'sync', '<name>') 拼接，不能直接写 /workspace/sync/...",
    retention: '手动清理',
    deliverable: true,
  },
  {
    name: 'scripts',
    semantics: '可复用脚本沉淀处：复杂 shell 命令写成 .sh（run_command 执行），复杂 Python 处理写成 .py（execute_python_script 用）',
    retention: '长期保留',
  },
  {
    name: 'templates',
    semantics: '企业模板：PPT/Word 报表规范等，生成文档时优先参考',
    retention: '长期保留',
  },
  {
    name: 'notes',
    semantics: '计划与笔记：AI 自管的工作记录、任务拆解、中间结论',
    retention: '长期保留',
  },
]

/** 生成面向模型的目录说明块（workspace_manifest 与文件处理规范共用） */
export function buildWorkspaceDirsGuide(dateDir: string): string {
  const lines = WORKSPACE_STANDARD_DIRS.map(
    (d) => `- /workspace/${d.name}/ — ${d.semantics}；保留策略：${d.retention}`
  )
  return `标准目录（按用途选择写入位置，不要随意新建顶层目录）：\n${lines.join('\n')}\n\n今日日期目录：${dateDir}（写入 outputs/scratch/uploads 时使用）。`
}

/**
 * 交付物目录前缀（含尾斜杠，供 startsWith 判定）——工作区文件动态注记的
 * 关注范围单一事实来源（2026-08-06）：只报用户真正关心的类别
 * （outputs 新产物 / uploads 新附件 / sync 新同步），内部信号目录天然出局。
 */
export const DELIVERABLE_DIR_PREFIXES: readonly string[] = WORKSPACE_STANDARD_DIRS.filter(
  (d) => d.deliverable
).map((d) => `/workspace/${d.name}/`)

// ==================== 虚拟路径与物理路径（2026-09-01 P0-7，单一事实来源） ====================
// 后端 WorkspaceFileService.ResolveAndValidatePath 与之对称：
// /workspace → 系统轨虚拟前缀（AI 自管）；物理绝对路径 → 登记根闸内直通。
// /project 命名空间已退役（登记根吸收）：显式报错指路，绝不静默改写。

export const VIRTUAL_ROOTS = { WORKSPACE: '/workspace' } as const

export function isWorkspacePath(p: string): boolean {
  return p === '/workspace' || p.startsWith('/workspace/')
}

/**
 * 物理绝对路径判定（与后端 LooksLikePhysicalPath 同规则）：
 * Windows 盘符（E:/ 或 E:\）、UNC（\\server\share）、MSYS（/e/...）。
 * /workspace 第三字符非 '/' 不会误判。
 */
export function isPhysicalPath(p: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true
  if (p.startsWith('\\\\')) return true
  return /^\/[a-zA-Z](\/|$)/.test(p)
}

/**
 * 统一路径规范化（原 fileTools.validatePath 与两个 adapter 的 normalizePath
 * 三处同构逻辑的单一事实来源）：物理路径原样透传（后端负责登记根闸与 MSYS 归一），
 * 裸路径补 /workspace/ 前缀；/project 显式退役报错。
 */
export function normalizeVirtualPath(input: string): string {
  let p = typeof input === 'string' ? input.trim() : ''
  if (!p) throw new Error('文件路径不能为空')
  if (isPhysicalPath(p)) {
    if (p.length > 2 && p.endsWith('/')) p = p.slice(0, -1)
    return p
  }
  if (p === '/project' || p.startsWith('/project/')) {
    throw new Error('/project 命名空间已退役：请直接使用该目录的物理绝对路径（如 E:/code/proj/src/a.ts）；未登记目录首次访问会请求授权')
  }
  if (!p.startsWith('/')) p = '/workspace/' + p
  if (!isWorkspacePath(p)) {
    p = '/workspace' + p
  }
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

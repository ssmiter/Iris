/**
 * 工作区标准目录（打磨任务2 S2，单一事实来源）。
 *
 * 与后端 WorkspaceFileService 的目录常量一一对应；所有 prompt 只引用本文件，
 * 不在各处手写目录语义，避免前后端/prompt 三处漂移。
 *
 * files/ 为遗留目录（语义与 scratch 重叠）已退役：后端新写入重定向到 scratch/，
 * 旧文件可读、72h 自然清理，不再出现在 prompt 中。
 */

export interface WorkspaceDirSpec {
  /** /workspace/ 下的目录名 */
  name: string
  /** 语义说明（面向模型） */
  semantics: string
  /** 保留策略（面向模型） */
  retention: string
}

export const WORKSPACE_STANDARD_DIRS: WorkspaceDirSpec[] = [
  {
    name: 'uploads',
    semantics: '用户上传的附件，按日期分目录（uploads/{yyyyMMdd}/），同名自动版本化',
    retention: '较长保留，显式删除',
  },
  {
    name: 'outputs',
    semantics: '交付物：工具/模型生成的报表、Word/Excel/PPT、图表等，按日期分目录（outputs/{yyyyMMdd}/）',
    retention: '30 天轮转清理',
  },
  {
    name: 'scratch',
    semantics: '中间产物与临时文件，按日期分目录（scratch/{yyyyMMdd}/）；用于步骤间传递数据',
    retention: '72 小时自动清理',
  },
  {
    name: 'sync',
    semantics: "外部文件副本：用 execute_python_script 从本地路径（C:/D:/E: 等）复制进来的资料，放在 sync/<name>/ 下；沙箱内必须用 os.path.join(os.environ['WONWORK_WORKSPACE_ROOT'], 'sync', '<name>') 拼接，不能直接写 /workspace/sync/...",
    retention: '手动清理',
  },
  {
    name: 'scripts',
    semantics: 'Python 脚本存放处，可复用的脚本沉淀于此',
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
 * 生成 /project 用户轨说明块（打磨任务2 S4）。
 * 仅在选定项目时注入；未选定时各 prompt 不引用本函数，保持逐字节不变。
 */
export function buildProjectGuide(projectPath: string): string {
  return `- **/project/ 是用户项目轨**：当前绑定项目目录 ${projectPath}。文件工具可通过 /project/... 直接读写该目录（如 /project/src/main.py 对应 ${projectPath}\\src\\main.py）；会话内首次写入 /project 需用户确认，之后自动放行。Python 沙箱内通过 os.environ['WONWORK_PROJECT_DIR'] 访问同一目录（未绑定项目时该变量不存在，用 os.environ.get('WONWORK_PROJECT_DIR') 判空）。`
}

// ==================== 双轨虚拟路径（打磨任务2 S4，单一事实来源） ====================
// 后端 WorkspaceFileService.ResolveAndValidatePath 与之对称：
// /workspace → 系统轨（AI 自管）；/project → 用户轨（用户项目目录，MESCLI Local）。

export const VIRTUAL_ROOTS = { WORKSPACE: '/workspace', PROJECT: '/project' } as const

export function isWorkspacePath(p: string): boolean {
  return p === '/workspace' || p.startsWith('/workspace/')
}

export function isProjectPath(p: string): boolean {
  return p === '/project' || p.startsWith('/project/')
}

/**
 * 统一虚拟路径规范化（原 fileTools.validatePath 与两个 adapter 的 normalizePath
 * 三处同构逻辑的单一事实来源）：裸路径补 /workspace/ 前缀，/project 根原样放行。
 */
export function normalizeVirtualPath(input: string): string {
  let p = typeof input === 'string' ? input.trim() : ''
  if (!p) throw new Error('文件路径不能为空')
  if (!p.startsWith('/')) p = '/workspace/' + p
  if (!isWorkspacePath(p) && !isProjectPath(p)) {
    p = '/workspace' + p
  }
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p
}

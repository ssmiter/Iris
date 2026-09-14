import type { Tool, ToolExecutionContext } from '@/agent/types'
import { useWorkspaceFileStore } from '@/stores/workspaceFileStore'
import {
  readFile as vfsReadFile,
  writeFile as vfsWriteFile,
  deleteFile as vfsDeleteFile,
  listFiles as vfsListFiles,
  globFiles as vfsGlobFiles,
  grepFiles as vfsGrepFiles,
  fileExists,
} from '@/services/fileSystem'
import { extractLiteralTerms } from '@/services/capabilityFs'
import { isPhysicalPath } from '@/config/workspaceDirs'
import { DirectoryChallengeError } from '@/services/workspaceAdapters/backendWorkspaceAdapter'
import { findDirectoryWriteRuleCovering, suggestDirectoryWriteRule } from '@/agent/permissionRules'

const MAX_FILE_CHARS = 100_000

/**
 * 目录授权挑战桥（2026-09-01 P0-7）：适配器把后端 409 directory_not_registered
 * 转成 DirectoryChallengeError 上抛，这里收敛为挑战形工具结果（error_code+path+exists），
 * toolExecutor.readDirectoryChallenge 识别后走"登记+原样重试"自愈闭环——
 * 与 run_command 的 cwd 挑战同一协议，文件六原语共用。
 */
function withChallengeGuard<TInput, TOutput>(
  fn: (input: TInput) => Promise<TOutput>
): (input: TInput) => Promise<TOutput> {
  return async (input) => {
    try {
      return await fn(input)
    } catch (err) {
      if (err instanceof DirectoryChallengeError) {
        return {
          success: false,
          error: err.message,
          error_code: 'directory_not_registered',
          path: err.path,
          exists: err.exists,
        } as TOutput
      }
      throw err
    }
  }
}

function validatePath(path: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== 'string' || !path.trim()) {
    return { ok: false, error: '缺少 path 参数，必须提供 /workspace/ 虚拟路径或物理绝对路径（如 E:/code/proj/src/a.ts）' }
  }
  const trimmed = path.trim()
  // /capabilities 是检索专用目录：支持 grep/glob/list_files，不支持 read_file/写操作。
  // 能力文件仅供全文检索定位，加载统一走 read_capability（后端查找大小写不敏感，更宽容）。
  if (trimmed === '/capabilities' || trimmed.startsWith('/capabilities/')) {
    return {
      ok: false,
      error:
        '/capabilities 不支持 read_file/写操作，它是检索专用目录。' +
        '正确流程：grep(pattern="关键词", path="/capabilities") 检索、或 list_capabilities 浏览目录定位工具 → read_capability("工具路径") 加载后调用（工具路径见检索结果的「路径」行）。',
    }
  }
  // /project 命名空间已退役（2026-09-01 P0-7 登记根吸收）：显式报错指路，绝不静默改写
  if (trimmed === '/project' || trimmed.startsWith('/project/')) {
    return {
      ok: false,
      error:
        '/project 命名空间已退役：请直接使用该目录的物理绝对路径（如 E:/code/proj/src/a.ts）；未登记目录首次访问会请求授权。',
    }
  }
  // P0-7：路径只有一个真相=物理路径；/workspace 是便捷别名不是狱。
  // 物理绝对路径原样放行（登记根闸在后端，未登记走目录挑战自愈闭环）。
  if (!trimmed.startsWith('/workspace/') && !isPhysicalPath(trimmed)) {
    return { ok: false, error: `路径必须是 /workspace/ 虚拟路径或物理绝对路径（如 E:/code/proj/src/a.ts）: ${trimmed}` }
  }
  return { ok: true, path: trimmed }
}

function truncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return content.slice(0, maxChars) + `\n\n[内容已截断，原长度 ${content.length} 字符]`
}

/** str_replace 失败线索：在文件中找与 old_string 首行最相近的 1-2 行，让模型第二轮直接打对 */
function findClosestLines(content: string, oldStr: string): string {
  const firstLine = oldStr
    .split('\n')
    .find((l) => l.trim().length > 0)
    ?.trim()
    .slice(0, 30)
  if (!firstLine || firstLine.length < 8) return ''
  const probe = firstLine.slice(0, 15)
  const lines = content.split('\n')
  const hits: string[] = []
  for (let i = 0; i < lines.length && hits.length < 2; i++) {
    if (lines[i].includes(probe)) {
      hits.push(`第 ${i + 1} 行: "${lines[i].trim().slice(0, 80)}"`)
    }
  }
  return hits.length > 0 ? `文件中的相近内容：${hits.join('；')}。` : ''
}

/**
 * read_file: 读取工作区文件内容
 */
export const readFileTool: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  description:
    '读取文件内容，输出带行号前缀（形如 12→内容，行号是显示前缀、不属于文件内容）。path 用 /workspace/ 虚拟路径或物理绝对路径（如 E:/code/proj/src/a.ts；/capabilities 是检索专用目录，请用 grep/glob/list_files）。可指定 offset（从第几行开始，1-based）和 limit（最多读取多少行）以控制返回长度，单文件上限 100K 字符。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径，例如 /workspace/reports/daily.md 或 E:/code/proj/src/a.ts',
      },
      offset: {
        type: 'number',
        description: '起始行号（1-based），可选',
      },
      limit: {
        type: 'number',
        description: '最多读取行数，可选',
      },
    },
    required: ['path'],
  },
  execute: withChallengeGuard(async (input: { path: string; offset?: number; limit?: number }) => {
    const pathCheck = validatePath(input.path)
    if (!pathCheck.ok) {
      return { success: false, error: pathCheck.error }
    }

    const entry = await vfsReadFile(pathCheck.path)
    if (!entry) {
      return { success: false, error: `文件不存在: ${pathCheck.path}` }
    }

    if (entry.content === '') {
      return {
        success: true,
        content: `[文件: ${entry.path}] 警告：文件存在但内容为空。`,
        totalLines: 0,
        size: 0,
      }
    }

    const allLines = entry.content.split('\n')
    const totalLines = allLines.length
    const startLine = input.offset && input.offset > 1 ? input.offset : 1

    // 2026-07-28：offset 越界此前会落入"文件为空"分支误导模型，改为明确报错
    if (startLine > totalLines) {
      return {
        success: false,
        error: `offset 超出范围：文件共 ${totalLines} 行，请求起始行 ${startLine}。`,
      }
    }

    let lines = allLines.slice(startLine - 1)
    if (input.limit && input.limit > 0) {
      lines = lines.slice(0, input.limit)
    }

    // 行号前缀（cat -n 风格，2026-07-28）：grep 给出 path:line 后可眼见为实核对落点，
    // str_replace 定位也有参照——此前 read 无行号，grep→read 是盲跳
    const numbered = lines.map((l, i) => `${startLine + i}→${l}`).join('\n')
    const content = truncate(numbered, MAX_FILE_CHARS)
    const rangeInfo =
      input.offset || input.limit
        ? `（显示第 ${startLine} 行起共 ${lines.length} 行 / 总计 ${totalLines} 行）`
        : ''

    return {
      success: true,
      content: `[文件: ${entry.path}]${rangeInfo}（行号为显示前缀，非文件内容）\n${content}`,
      totalLines,
      size: entry.size,
    }
  }),
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: true,
  isDestructive: false,
  alwaysLoad: true,
  maxResultSizeChars: MAX_FILE_CHARS,
}

/**
 * 工作区外写审批（2026-09-01 P0-7，对齐 claude-code "cwd 外写=ask"）：
 * /workspace 内写不拦；物理路径写首次 ask+可沉淀（directory-write 规则，
 * 写授权隐含读授权）；delete_file 维持 destructive 每次必问不沉淀，不走此链。
 */
function checkPhysicalWritePermission(
  path: unknown,
  conversationId: number | null | undefined
): import('@/agent/types').PermissionResult {
  const p = typeof path === 'string' ? path.trim() : ''
  if (!p || !isPhysicalPath(p)) return { allowed: true, behavior: 'allow' }
  const convId = conversationId != null ? String(conversationId) : null
  if (findDirectoryWriteRuleCovering(convId, p)) return { allowed: true, behavior: 'allow' }
  const suggestion = suggestDirectoryWriteRule([p])
  return {
    allowed: false,
    behavior: 'ask',
    // 写授权 = agent 可达边界扩张，不随"全部自动"委托（同目录登记纪律）
    alwaysAsk: true,
    reason:
      `将写入工作区外的目录：${p}。批准即在本对话内允许写入该目录及子文件（不再询问）；` +
      `选「始终允许」则跨会话生效。`,
    suggestedRule: suggestion ?? undefined,
  }
}

/**
 * write_file: 写入工作区文件
 */
export const writeFileTool: Tool<{
  path: string
  content: string
  append?: boolean
  expectedContent?: string
}> = {
  name: 'write_file',
  description:
    '写入或创建文件。path 用 /workspace/ 虚拟路径或物理绝对路径（如 E:/code/proj/src/a.ts）。创建新文件或 append=true 时可省略 expectedContent；覆盖已存在文件且 append=false 时，必须先使用 read_file 读取当前内容，并在 expectedContent 字段回传，防止意外覆盖。支持 append 追加模式。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径，例如 /workspace/output/result.md 或 E:/code/proj/src/a.ts',
      },
      content: {
        type: 'string',
        description: '要写入的文件内容',
      },
      append: {
        type: 'boolean',
        description: '是否追加到文件末尾，默认为 false',
      },
      expectedContent: {
        type: 'string',
        description:
          '覆盖已存在文件前 read_file 读取到的完整内容，用于防止并发覆盖。创建新文件或 append=true 时可省略。',
      },
    },
    required: ['path', 'content'],
  },
  checkPermissions: (input, context) => checkPhysicalWritePermission(input?.path, context.conversationId),
  execute: withChallengeGuard(async (input: { path: string; content: string; append?: boolean; expectedContent?: string }) => {
    const pathCheck = validatePath(input.path)
    if (!pathCheck.ok) {
      return { success: false, error: pathCheck.error }
    }
    if (typeof input.content !== 'string') {
      return { success: false, error: '缺少 content 参数，必须提供要写入的字符串内容' }
    }

    const exists = await fileExists(pathCheck.path)

    if (exists && !input.append) {
      // fresh 读对账（2026-09-01 P0-7 零副本纪律）：expectedContent 比对的是 3s 读缓存
      // 就可能拿着旧快照放行并发覆盖——写前对账必须比对后端真实现状
      const current = await vfsReadFile(pathCheck.path, { fresh: true })
      if (!current) {
        return { success: false, error: `无法读取现有文件: ${pathCheck.path}` }
      }

      if (input.expectedContent === undefined) {
        return {
          success: false,
          error: `文件 ${pathCheck.path} 已存在。为防止覆盖，请先使用 read_file 读取该文件，然后在 write_file 的 expectedContent 字段传入读取到的完整内容。`,
        }
      }

      if (current.content !== input.expectedContent) {
        const preview = current.content.slice(0, 200).replace(/\n/g, ' ')
        return {
          success: false,
          error: `文件 ${pathCheck.path} 自上次读取后已发生变化。当前内容开头: "${preview}..."，请重新 read_file 并更新 expectedContent。`,
        }
      }
    }

    const entry = await vfsWriteFile(pathCheck.path, input.content, { append: input.append })
    return {
      success: true,
      path: entry.path,
      size: entry.size,
      action: exists ? (input.append ? 'appended' : 'updated') : 'created',
      workspaceFiles: [
        {
          path: entry.path,
          sizeBytes: entry.size,
          sourceTool: 'write_file',
          mimeType: entry.mimeType ?? 'text/plain',
        },
      ],
    }
  }),
  riskLevel: 'standard',
  isReadOnly: false,
  isConcurrencySafe: false,
  isDestructive: false,
  impactStatement: '将向 {path} 写入/覆盖文件内容。',
  alwaysLoad: true,
  maxResultSizeChars: 10_000,
  // consult_state（2026-08-08 双 agent P0）：会话有活跃状态任务时写前必须对账
  requiresStateConsult: true,
}

/**
 * str_replace: 精确替换已有文件中的子串
 */
export const strReplaceTool: Tool<{
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}> = {
  name: 'str_replace',
  description:
    '精确替换已有文件中的 old_string 为 new_string。old_string 逐字精确匹配（含缩进与换行），必须在文件中唯一存在（除非 replace_all=true）。编辑前必须先用 read_file 查看内容并直接复制（注意：read_file 输出的行号前缀"N→"不是文件内容，不要复制进 old_string）。path 用 /workspace/ 虚拟路径或物理绝对路径（如 E:/code/proj/src/a.ts）。',
  inputSchema: {
    type: 'object',
    required: ['path', 'old_string', 'new_string'],
    properties: {
      path: {
        type: 'string',
        description: '文件路径，例如 /workspace/scripts/etl.py 或 E:/code/proj/src/a.ts',
      },
      old_string: {
        type: 'string',
        description: '要被替换的精确子字符串',
      },
      new_string: {
        type: 'string',
        description: '用于替换的新子字符串',
      },
      replace_all: {
        type: 'boolean',
        description: '是否替换所有匹配项，默认 false',
      },
    },
  },
  checkPermissions: (input, context) => checkPhysicalWritePermission(input?.path, context.conversationId),
  execute: withChallengeGuard(async (input: { path: string; old_string: string; new_string: string; replace_all?: boolean }) => {
    const pathCheck = validatePath(input.path)
    if (!pathCheck.ok) {
      return { success: false, error: pathCheck.error }
    }
    if (typeof input.old_string !== 'string') {
      return { success: false, error: '缺少 old_string 参数' }
    }
    if (typeof input.new_string !== 'string') {
      return { success: false, error: '缺少 new_string 参数' }
    }

    // fresh 读（2026-09-01 P0-7 零副本纪律）：替换基于读取结果推导全文写回，
    // 拿 3s 缓存推导等于拿旧快照覆盖外部编辑——必须比对真实现状
    const entry = await vfsReadFile(pathCheck.path, { fresh: true })
    if (!entry) {
      return { success: false, error: `文件不存在: ${pathCheck.path}` }
    }

    const content = entry.content
    const oldStr = input.old_string
    const newStr = input.new_string
    const replaceAll = input.replace_all === true

    const countOf = (haystack: string, needle: string): number => {
      if (needle === '') return 0
      let n = 0
      let pos = haystack.indexOf(needle)
      while (pos !== -1) {
        n++
        pos = haystack.indexOf(needle, pos + needle.length)
      }
      return n
    }

    // 匹配工作文本与定位串：默认原文精确匹配；0 匹配时做两级容错重试
    // （2026-07-28，Windows 环境最高频失败模式）：
    // 1) CRLF 归一化——read_file 按 \n 切行后 \r 留在行尾且不可见，
    //    模型跨行复制 old_string 几乎必丢 \r → 此前必然死循环；
    // 2) 剥离 read_file 行号前缀——模型可能误把输出的 "N→" 前缀复制进 old_string。
    let workContent = content
    let matchStr = oldStr
    let count = countOf(workContent, matchStr)
    let relaxNote = ''

    if (count === 0) {
      const normalizedContent = content.replace(/\r\n/g, '\n')
      const normalizedOld = oldStr.replace(/\r\n/g, '\n')
      if (countOf(normalizedContent, normalizedOld) > 0) {
        workContent = normalizedContent
        matchStr = normalizedOld
        count = countOf(workContent, matchStr)
        relaxNote = '已自动按 LF 归一化匹配 CRLF 文件，写回时保持原 CRLF 风格。'
      } else {
        const strippedOld = normalizedOld.replace(/^\d+→/gm, '')
        if (strippedOld !== normalizedOld && countOf(normalizedContent, strippedOld) > 0) {
          workContent = normalizedContent
          matchStr = strippedOld
          count = countOf(workContent, matchStr)
          relaxNote =
            '已自动剥离 old_string 中的 read_file 行号前缀（"N→"）后匹配成功；行号不是文件内容，下次请勿复制。'
        }
      }
    }

    if (count === 0) {
      return {
        success: false,
        error: `无法替换：old_string 在 ${pathCheck.path} 中未找到（含 CRLF 归一化与行号前缀剥离重试）。${findClosestLines(content, oldStr)}请用 read_file 确认当前内容后逐字复制（含缩进与换行，不含行号前缀）。`,
        error_type: 'old_string_not_found',
      }
    }

    if (count > 1 && !replaceAll) {
      return {
        success: false,
        error: `old_string 在 ${pathCheck.path} 中出现 ${count} 次，存在歧义。请在 old_string 中包含更多上下文以精确定位，或设置 replace_all=true 替换全部。`,
        error_type: 'ambiguous_match',
        occurrences: count,
      }
    }

    let newContent = replaceAll
      ? workContent.split(matchStr).join(newStr)
      : workContent.replace(matchStr, newStr)

    // 容错匹配时工作文本被归一化为 LF；若原文件是 CRLF 风格，写回前恢复 \r\n 保持原风格
    if (workContent !== content && /\r\n/.test(content)) {
      newContent = newContent.replace(/\n/g, '\r\n')
    }

    const written = await vfsWriteFile(pathCheck.path, newContent)

    try {
      await useWorkspaceFileStore.getState().refresh()
    } catch (err) {
      console.warn('[str_replace] 刷新工作区面板失败:', err)
    }

    return {
      success: true,
      path: written.path,
      replacements: replaceAll ? count : 1,
      size: written.size,
      ...(relaxNote !== '' ? { note: relaxNote } : {}),
      workspaceFiles: [
        {
          path: written.path,
          sizeBytes: written.size,
          sourceTool: 'str_replace',
          mimeType: written.mimeType ?? 'text/plain',
        },
      ],
    }
  }),
  riskLevel: 'standard',
  isReadOnly: false,
  isConcurrencySafe: false,
  isDestructive: false,
  impactStatement: '将修改文件 {path} 中的指定内容。',
  alwaysLoad: true,
  maxResultSizeChars: 10_000,
  // consult_state（2026-08-08 双 agent P0）：会话有活跃状态任务时写前必须对账
  requiresStateConsult: true,
}

/**
 * list_files: 列出目录内容
 */
export const listFilesTool: Tool<{ path?: string; recursive?: boolean }> = {
  name: 'list_files',
  description:
    '列出目录下的文件和子目录。path 默认为 /workspace，也可用物理绝对路径（如 E:/code/proj）或 /capabilities（能力检索目录）。可设置 recursive=true 递归列出所有文件。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '目录路径，例如 /workspace/reports 或 E:/code/proj',
      },
      recursive: {
        type: 'boolean',
        description: '是否递归列出子目录文件',
      },
    },
  },
  execute: withChallengeGuard(async (input: { path?: string; recursive?: boolean }) => {
    const path =
      input.path === undefined || input.path === ''
        ? '/workspace'
        : typeof input.path === 'string'
        ? input.path.trim()
        : '/workspace'

    const result = await vfsListFiles(path, {
      recursive: input.recursive,
    })
    return {
      success: true,
      path,
      files: result.files,
      directories: result.directories,
      total: result.files.length + result.directories.length,
    }
  }),
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: true,
  isDestructive: false,
  alwaysLoad: true,
  maxResultSizeChars: 50_000,
}

/**
 * glob: 按模式匹配文件路径
 */
export const globTool: Tool<{ pattern: string; path?: string }> = {
  name: 'glob',
  description:
    '按 glob 模式匹配文件路径。支持 * 匹配单段路径，** 匹配任意层级。path 默认为 /workspace，也可用物理绝对路径（如 E:/code/proj）或 /capabilities 匹配能力目录（如 path="/capabilities" pattern="**/*.md"）。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'glob 模式，例如 "reports/*.md" 或 "**/*.csv"',
      },
      path: {
        type: 'string',
        description: '基础目录，例如 /workspace 或 E:/code/proj',
      },
    },
    required: ['pattern'],
  },
  execute: withChallengeGuard(async (input: { pattern: string; path?: string }) => {
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) {
      return { success: false, error: '缺少 pattern 参数' }
    }
    const path = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '/workspace'

    const matches = await vfsGlobFiles(input.pattern, path)
    // 参考 claude-code GlobTool：限量返回 + 截断标志，防止大目录把上下文打爆，
    // 模型看到 truncated 后自然会收窄 pattern 翻页
    const MAX_GLOB_RESULTS = 200
    const truncated = matches.length > MAX_GLOB_RESULTS
    return {
      success: true,
      pattern: input.pattern,
      basePath: path,
      matches: matches.slice(0, MAX_GLOB_RESULTS),
      count: matches.length,
      ...(truncated
        ? { truncated: true, note: `共 ${matches.length} 个匹配，仅返回前 ${MAX_GLOB_RESULTS} 个，请用更具体的 pattern 收窄。` }
        : {}),
    }
  }),
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: true,
  isDestructive: false,
  alwaysLoad: true,
  maxResultSizeChars: 50_000,
}

/**
 * grep: 在文件中搜索文本
 */
export const grepTool: Tool<{
  pattern: string
  path?: string
  glob?: string
  caseInsensitive?: boolean
}> = {
  name: 'grep',
  description:
    '在文件中搜索匹配正则表达式的行。path 默认为 /workspace，也可用物理绝对路径（如 E:/code/proj）；传 /capabilities 可全文检索能力目录——这是发现工具的两种武器之一：词面明确的点状问题用 grep 直达候选；词面模糊或跨工序的链状问题，先用 list_capabilities 浏览目录建立全景更合适。技能目录（可用技能清单头注有路径）也可直接 grep。可指定 glob 缩小搜索范围。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '正则表达式或普通字符串',
      },
      path: {
        type: 'string',
        description: '搜索目录，例如 /workspace/logs 或 E:/code/proj',
      },
      glob: {
        type: 'string',
        description: 'glob 过滤，例如 "*.log"',
      },
      caseInsensitive: {
        type: 'boolean',
        description: '是否忽略大小写',
      },
    },
    required: ['pattern'],
  },
  execute: withChallengeGuard(async (input: { pattern: string; path?: string; glob?: string; caseInsensitive?: boolean }) => {
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) {
      return { success: false, error: '缺少 pattern 参数' }
    }
    // 嵌套量词（如 (a+)+）会触发正则回溯爆炸、卡死页面——JS 正则执行无法中断，必须提前拦截
    if (/\([^)]*[+*][^)]*\)\s*[+*{?]/.test(input.pattern)) {
      return {
        success: false,
        error: 'pattern 包含嵌套量词（形如 (a+)+），会引发正则回溯爆炸导致卡死。请简化：去掉嵌套重复，或改用更具体的关键词。',
      }
    }
    const { matches, total, fileCount, hitFiles } = await vfsGrepFiles(input.pattern, {
      path: input.path,
      glob: input.glob,
      caseInsensitive: input.caseInsensitive,
    })

    // 0 命中时自证"目录已检索、不是缓存为空"，并给出下一步——让模型能区分"真没有"与"没搜到"
    const noHits = hitFiles ? hitFiles.length === 0 : total === 0
    if (noHits) {
      const isComposite = /\.\*|\|/.test(input.pattern)
      let emptyNote: string
      let extraHint = ''
      if (fileCount !== undefined) {
        emptyNote = fileCount === 0
          ? '（该目录下没有能力文件——路径可能有误，或能力索引尚未加载。可先用 list_files 确认目录内容。）'
          : `（已实际检索 ${fileCount} 个能力文件，确认无命中——不是缓存为空。可换角度：业务对象→工序→动作；去掉 glob 过滤；或用 list_capabilities 浏览目录确认工具分布。）`
        // 组合 pattern 0 命中：给出各单词命中分布——证据而非猜测，模型第二轮直接打对
        if (isComposite && fileCount > 0) {
          const terms = extractLiteralTerms(input.pattern)
          if (terms.length > 1) {
            const distribution: string[] = []
            for (const term of terms) {
              const r = await vfsGrepFiles(term, {
                path: input.path,
                caseInsensitive: input.caseInsensitive,
              })
              distribution.push(`${term} ${r.total}`)
            }
            extraHint = `（组合条件无文件整体满足——A.*B 仍有顺序性，且词汇可能与语料语言错位（目录名/工具名是英文，中文工序词可试英文或缩写）。单词命中分布：${distribution.join('、')}。建议用最特异的单词重试。）`
          }
        }
      } else {
        emptyNote = '（无命中。可换关键词角度，或调整 path/glob 范围。）'
        if (isComposite) {
          extraHint = '（注意：工作区检索按行匹配，"A.*B"要求两个词在同一行共现，多词组合极易 0 命中——建议改用最特异的单个关键词重试。）'
        }
      }
      return {
        success: true,
        pattern: input.pattern,
        matches: [],
        total: 0,
        summary: `0 处匹配${emptyNote}${extraHint}`,
      }
    }

    // /capabilities 检索（hitFiles 存在）：按文件聚合视图——发现阶段要的是候选工具清单，
    // 不是行碎片；行级明细会 3-5 倍放大感知（标识符在标题/路径行/加载指令中重复）
    if (hitFiles) {
      const MAX_FILES_SHOWN = 50
      const fileLines = hitFiles
        .slice(0, MAX_FILES_SHOWN)
        .map((f) => `${f.path}（${f.hits} 行命中）— ${f.repr}`)
      const filesTruncated = hitFiles.length > MAX_FILES_SHOWN
      const summary =
        `${hitFiles.length} 个能力文件命中（共 ${total} 行；按命中密度排序，每文件取代表行）` +
        `${filesTruncated ? `，仅显示前 ${MAX_FILES_SHOWN} 个，请用更精确的 pattern 或更小的 path 收窄` : ''}：\n` +
        fileLines.join('\n') +
        `\n\n工具路径 = 文件路径去掉 /capabilities 前缀和 .md 后缀；对目标工具 read_capability("工具路径") 加载后即可调用。` +
        `想看某文件全部命中行，可用更窄的 path 重新检索。`
      return {
        success: true,
        pattern: input.pattern,
        matches: matches.slice(0, 100),
        total,
        hitFiles: hitFiles.slice(0, MAX_FILES_SHOWN),
        summary,
      }
    }

    // 工作区检索：行级视图
    const lines = matches.slice(0, 100).map((r) => `${r.path}:${r.line}: ${r.content}`)
    const truncated = total > 100
    // 截断时给出可执行的下一步（收窄 pattern / 加 glob / 限定 path），而非死胡同提示
    const truncationNote = truncated
      ? `（仅显示前 ${Math.min(matches.length, 100)} 条，请用更精确的 pattern、glob 过滤或更小的 path 收窄）`
      : ''

    return {
      success: true,
      pattern: input.pattern,
      matches: matches.slice(0, 100),
      total,
      summary: `${total} 处匹配${truncationNote}:\n${lines.join('\n')}`,
    }
  }),
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: true,
  isDestructive: false,
  alwaysLoad: true,
  maxResultSizeChars: 100_000,
}

/**
 * delete_file: 删除工作区文件（高风险，destructive）
 */
export const deleteFileTool: Tool<{ path: string }> = {
  name: 'delete_file',
  description:
    '删除文件。path 用 /workspace/ 虚拟路径或物理绝对路径。此操作不可恢复，请谨慎使用。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要删除的文件路径',
      },
    },
    required: ['path'],
  },
  execute: withChallengeGuard(async (input: { path: string }) => {
    const pathCheck = validatePath(input.path)
    if (!pathCheck.ok) {
      return { success: false, error: pathCheck.error }
    }
    await vfsDeleteFile(pathCheck.path)
    try {
      await useWorkspaceFileStore.getState().refresh()
    } catch (err) {
      console.warn('[delete_file] 刷新工作区面板失败:', err)
    }
    return { success: true, deleted: pathCheck.path }
  }),
  riskLevel: 'destructive',
  isReadOnly: false,
  isConcurrencySafe: false,
  isDestructive: true,
  requiresApproval: true,
  approvalMode: 'explicit',
  impactStatement: '将删除工作区文件 {path}，此操作不可恢复。',
  alwaysLoad: true,
  maxResultSizeChars: 1_000,
}

/**
 * 获取所有文件工具
 */
export function getFileTools(): Tool<unknown, unknown>[] {
  return [
    readFileTool,
    writeFileTool,
    strReplaceTool,
    listFilesTool,
    globTool,
    grepTool,
    deleteFileTool,
  ] as Tool<unknown, unknown>[]
}

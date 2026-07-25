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

const MAX_FILE_CHARS = 100_000

function validatePath(path: unknown): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== 'string' || !path.trim()) {
    return { ok: false, error: '缺少 path 参数，必须提供以 /workspace/ 或 /project/ 开头的文件路径' }
  }
  const trimmed = path.trim()
  // S4：双轨命名空间——/workspace/ 系统轨 + /project/ 用户轨（MESCLI Local 选定项目后可用）
  if (!trimmed.startsWith('/workspace/') && !trimmed.startsWith('/project/')) {
    return { ok: false, error: `路径必须以 /workspace/ 或 /project/ 开头: ${trimmed}` }
  }
  return { ok: true, path: trimmed }
}

function truncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return content.slice(0, maxChars) + `\n\n[内容已截断，原长度 ${content.length} 字符]`
}

/**
 * read_file: 读取工作区文件内容
 */
export const readFileTool: Tool<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  description:
    '读取工作区文件内容。path 必须以 /workspace/ 或 /project/ 开头。可指定 offset（从第几行开始，1-based）和 limit（最多读取多少行）以控制返回长度。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径，例如 /workspace/reports/daily.md',
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
  async execute(input) {
    const pathCheck = validatePath(input.path)
    if (!pathCheck.ok) {
      return { success: false, error: pathCheck.error }
    }

    const entry = await vfsReadFile(pathCheck.path)
    if (!entry) {
      return { success: false, error: `文件不存在: ${pathCheck.path}` }
    }

    let lines = entry.content.split('\n')
    const totalLines = lines.length

    if (input.offset && input.offset > 1) {
      lines = lines.slice(input.offset - 1)
    }
    if (input.limit && input.limit > 0) {
      lines = lines.slice(0, input.limit)
    }

    const content = truncate(lines.join('\n'), MAX_FILE_CHARS)
    const rangeInfo =
      input.offset || input.limit
        ? `（显示第 ${input.offset || 1} 行起共 ${lines.length} 行 / 总计 ${totalLines} 行）`
        : ''

    if (content === '') {
      return {
        success: true,
        content: `[文件: ${entry.path}]${rangeInfo} 警告：文件存在但内容为空。`,
        totalLines: 0,
        size: 0,
      }
    }

    return {
      success: true,
      content: `[文件: ${entry.path}]${rangeInfo}\n${content}`,
      totalLines,
      size: entry.size,
    }
  },
  riskLevel: 'read_only',
  isReadOnly: true,
  isConcurrencySafe: true,
  isDestructive: false,
  alwaysLoad: true,
  maxResultSizeChars: MAX_FILE_CHARS,
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
    '写入或创建工作区文件。path 必须以 /workspace/ 或 /project/ 开头。创建新文件或 append=true 时可省略 expectedContent；覆盖已存在文件且 append=false 时，必须先使用 read_file 读取当前内容，并在 expectedContent 字段回传，防止意外覆盖。支持 append 追加模式。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径，例如 /workspace/output/result.md',
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
  async execute(input) {
    const pathCheck = validatePath(input.path)
    if (!pathCheck.ok) {
      return { success: false, error: pathCheck.error }
    }
    if (typeof input.content !== 'string') {
      return { success: false, error: '缺少 content 参数，必须提供要写入的字符串内容' }
    }

    const exists = await fileExists(pathCheck.path)

    if (exists && !input.append) {
      const current = await vfsReadFile(pathCheck.path)
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
  },
  riskLevel: 'standard',
  isReadOnly: false,
  isConcurrencySafe: false,
  isDestructive: false,
  impactStatement: '将向 {path} 写入/覆盖文件内容。',
  alwaysLoad: true,
  maxResultSizeChars: 10_000,
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
    '精确替换已有文件中的 old_string 为 new_string。old_string 必须在文件中唯一存在（除非 replace_all=true）。编辑前建议先用 read_file 查看内容。path 必须以 /workspace/ 或 /project/ 开头。',
  inputSchema: {
    type: 'object',
    required: ['path', 'old_string', 'new_string'],
    properties: {
      path: {
        type: 'string',
        description: '文件路径，例如 /workspace/scripts/etl.py',
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
  async execute(input) {
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

    const entry = await vfsReadFile(pathCheck.path)
    if (!entry) {
      return { success: false, error: `文件不存在: ${pathCheck.path}` }
    }

    const content = entry.content
    const oldStr = input.old_string
    const newStr = input.new_string
    const replaceAll = input.replace_all === true

    let count = 0
    let pos = content.indexOf(oldStr)
    while (pos !== -1) {
      count++
      pos = content.indexOf(oldStr, pos + oldStr.length)
    }

    if (count === 0) {
      return {
        success: false,
        error: `无法替换：old_string 在 ${pathCheck.path} 中未找到。请先用 read_file 确认当前内容。`,
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

    const newContent = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr)

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
      workspaceFiles: [
        {
          path: written.path,
          sizeBytes: written.size,
          sourceTool: 'str_replace',
          mimeType: written.mimeType ?? 'text/plain',
        },
      ],
    }
  },
  riskLevel: 'standard',
  isReadOnly: false,
  isConcurrencySafe: false,
  isDestructive: false,
  impactStatement: '将修改文件 {path} 中的指定内容。',
  alwaysLoad: true,
  maxResultSizeChars: 10_000,
}

/**
 * list_files: 列出目录内容
 */
export const listFilesTool: Tool<{ path?: string; recursive?: boolean }> = {
  name: 'list_files',
  description:
    '列出工作区目录下的文件和子目录。path 默认为 /workspace。可设置 recursive=true 递归列出所有文件。',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '目录路径，例如 /workspace/reports',
      },
      recursive: {
        type: 'boolean',
        description: '是否递归列出子目录文件',
      },
    },
  },
  async execute(input) {
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
  },
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
    '按 glob 模式匹配工作区文件路径。支持 * 匹配单段路径，** 匹配任意层级。path 默认为 /workspace。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'glob 模式，例如 "reports/*.md" 或 "**/*.csv"',
      },
      path: {
        type: 'string',
        description: '基础目录，例如 /workspace',
      },
    },
    required: ['pattern'],
  },
  async execute(input) {
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) {
      return { success: false, error: '缺少 pattern 参数' }
    }
    const path = typeof input.path === 'string' && input.path.trim() ? input.path.trim() : '/workspace'

    const matches = await vfsGlobFiles(input.pattern, path)
    return {
      success: true,
      pattern: input.pattern,
      basePath: path,
      matches,
      count: matches.length,
    }
  },
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
    '在工作区文件中搜索匹配正则表达式的行。path 默认为 /workspace。可指定 glob 缩小搜索范围。',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '正则表达式或普通字符串',
      },
      path: {
        type: 'string',
        description: '搜索目录，例如 /workspace/logs',
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
  async execute(input) {
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) {
      return { success: false, error: '缺少 pattern 参数' }
    }
    const results = await vfsGrepFiles(input.pattern, {
      path: input.path,
      glob: input.glob,
      caseInsensitive: input.caseInsensitive,
    })

    const lines = results.slice(0, 100).map((r) => `${r.path}:${r.line}: ${r.content}`)
    const truncated = results.length > 100

    return {
      success: true,
      pattern: input.pattern,
      matches: results.slice(0, 100),
      total: results.length,
      summary: `${results.length} 处匹配${truncated ? '（仅显示前 100 条）' : ''}:\n${lines.join('\n')}`,
    }
  },
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
    '删除工作区文件。path 必须以 /workspace/ 或 /project/ 开头。此操作不可恢复，请谨慎使用。',
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
  async execute(input) {
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
  },
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

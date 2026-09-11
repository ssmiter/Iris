/**
 * run_command 的命令安全分级（前端 UX 层，2026-08-30 下限工程 P0）。
 * 与后端 CommandSafety.cs 同构：前端负责 allow/ask 的体验裁决与审批理由，
 * 后端的 Deny 是 fail-closed 硬地板（即便前端放行，后端命中 Deny 也会拒执行）。
 * 分级语义（对齐 claude-code deny > ask > allow）：
 *   allow       = 只读枚举类（免询问）
 *   ask         = 默认档；解析不了的命令必 ask（fail-closed）
 *   deny        = 机器级破坏（格式化/注册表写/账户/关机/ACL）
 *   destructive = 删除/移动/覆盖/杀进程类：命中 allow 也降级为 ask 且 alwaysAsk
 *                 （误删没有撤销键，bypass 模式下也保留确认——与 SQL 写同一纪律）
 */

export type CommandLevel = 'allow' | 'ask' | 'deny'

export interface CommandClassification {
  level: CommandLevel
  destructive: boolean
  reason: string
}

const DENY_PATTERNS: RegExp[] = [
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\b(shutdown|logoff)\b/i,
  /\b(restart|stop)-computer\b/i,
  /\b(bcdedit|bootrec)\b/i,
  /\breg\s+(add|delete|import|restore)\b|\bregedit\b/i,
  /\bnet\s+(user|localgroup|accounts)\b/i,
  /\b(takeown|icacls|cacls)\b/i,
  /\bcipher\s+\/w/i,
]

const DESTRUCTIVE_VERBS = new Set([
  'del', 'erase', 'rd', 'rmdir', 'rm', 'move', 'mv', 'ren', 'rename',
  'remove-item', 'move-item', 'taskkill', 'kill', 'stop-process',
  'net', 'sc',
])

const READONLY_VERBS = new Set([
  'dir', 'ls', 'pwd', 'echo', 'type', 'cat', 'findstr', 'find',
  'select-string', 'where', 'whoami', 'hostname', 'ipconfig',
  'ver', 'get-location', 'get-childitem', 'get-content', 'get-item',
  // 注意：cd 不在此列——cwd 切换 = 把后续所有命令的执行现场挪到目标目录，
  // 是授权边界的改变而非读操作；cd 到未登记目录走目录闸 ask（批准即登记），
  // cd 到已登记根/工作区由目录闸放行。
])

const READONLY_GIT_SUB = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe', 'blame', 'ls-files',
])

const READONLY_SVN_SUB = new Set([
  'status', 'info', 'log', 'diff', 'list', 'cat', 'blame', 'st',
])

const ROOT_TARGET =
  /([a-z]:\\?\s*$|[a-z]:\\?(windows|program files|users)(\\|\s|$)|^\/(\s|$)|\/(windows|etc|usr)(\s|\/|$))/i

export function classifyCommand(command: string): CommandClassification {
  const trimmed = (command ?? '').trim()
  if (!trimmed) {
    return { level: 'deny', destructive: false, reason: '命令为空。' }
  }

  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        level: 'deny',
        destructive: true,
        reason: '命令包含机器级破坏操作（格式化/注册表写/账户管理/关机/ACL 修改），任何模式下都不执行。',
      }
    }
  }

  const segments = splitCompound(trimmed)
  if (segments.length === 0) {
    return { level: 'ask', destructive: false, reason: '命令无法解析，默认要求人工确认。' }
  }

  let destructive = false
  let allReadOnly = true
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    let head = tokens[0].replace(/^["']|["']$/g, '')
    if (head.toLowerCase().endsWith('.exe')) head = head.slice(0, -4)
    const slash = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'))
    if (slash >= 0) head = head.slice(slash + 1)
    const lower = head.toLowerCase()

    if (DESTRUCTIVE_VERBS.has(lower)) {
      destructive = true
      allReadOnly = false
      continue
    }

    const readOnly =
      READONLY_VERBS.has(lower) ||
      (lower === 'git' && tokens.length > 1 && READONLY_GIT_SUB.has(tokens[1].toLowerCase())) ||
      (lower === 'svn' && tokens.length > 1 && READONLY_SVN_SUB.has(tokens[1].toLowerCase()))
    if (!readOnly) allReadOnly = false
  }

  if (destructive && ROOT_TARGET.test(trimmed)) {
    return {
      level: 'deny',
      destructive: true,
      reason: '删除/移动类命令的目标是驱动器根或系统目录，拒绝执行。',
    }
  }

  if (allReadOnly) {
    return { level: 'allow', destructive: false, reason: '只读枚举类命令。' }
  }

  return destructive
    ? {
        level: 'ask',
        destructive: true,
        reason: '命令包含删除/移动/杀进程类操作，需人工确认（全部自动模式下仍保留）。',
      }
    : { level: 'ask', destructive: false, reason: '写操作或状态变更类命令，需人工确认。' }
}

/** 按 &&、||、;、| 切分复合命令（引号内不切）。与后端 SplitCompound 同构。 */
export function splitCompound(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === "'" && !inDouble) {
      inSingle = !inSingle
      current += c
      continue
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble
      current += c
      continue
    }
    if (inSingle || inDouble) {
      current += c
      continue
    }
    const isSeparator =
      c === ';' || c === '|' || (c === '&' && i + 1 < command.length && command[i + 1] === '&')
    if (isSeparator) {
      if (current.length > 0) parts.push(current)
      current = ''
      if (c === '&') i++
      if (c === '|' && i + 1 < command.length && command[i + 1] === '|') i++
      continue
    }
    current += c
  }
  if (current.length > 0) parts.push(current)
  return parts
}

/**
 * 提取命令中的绝对路径词元（P0-2 目录权限闸用）。
 * 覆盖：带引号/不带引号的 C:\...、UNC \\server\share、Git Bash 的 /c/...。
 * 相对路径不提取——它们在工作目录内解析，cwd 已由后端根目录约束；
 * $WONWORK_WORKSPACE_ROOT / %WONWORK_*% 环境变量引用是登记根内路径，不提取。
 */
export function extractAbsolutePaths(command: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (p: string) => {
    const cleaned = p.replace(/[),;]+$/, '')
    const key = cleaned.toLowerCase()
    if (cleaned && !seen.has(key)) {
      seen.add(key)
      out.push(cleaned)
    }
  }
  // 带引号的绝对路径（允许空格）
  for (const m of command.matchAll(/"([A-Za-z]:[\\/][^"]*)"/g)) push(m[1])
  for (const m of command.matchAll(/'([A-Za-z]:[\\/][^']*)'/g)) push(m[1])
  for (const m of command.matchAll(/"(\\\\[^"]*)"/g)) push(m[1])
  // 带引号的 Git Bash 形式（"/e/IntelliJ IDEA/..." —— 2026-08-31 验收实测漏提修复）
  for (const m of command.matchAll(/"(\/[a-zA-Z]\/[^"]*)"/g)) push(m[1])
  for (const m of command.matchAll(/'(\/[a-zA-Z]\/[^']*)'/g)) push(m[1])
  // 不带引号的绝对路径（到空白/管道符为止）
  for (const m of command.matchAll(/\b([A-Za-z]:[\\/][^\s"'|&;<>]*)/g)) push(m[1])
  for (const m of command.matchAll(/(^|\s)(\\\\[^\s"'|&;<>]+)/g)) push(m[2])
  // Git Bash 风格 /c/...（\b 在空白与 / 之间不构成词界，用 (^|\s) 锚定）
  for (const m of command.matchAll(/(?:^|\s)(\/[a-zA-Z]\/[^\s"'|&;<>]*)/g)) push(m[1])
  return out
}

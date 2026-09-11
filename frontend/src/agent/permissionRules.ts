/**
 * 按对话权限表（2026-08-30 下限工程 P0-2，对齐 claude-code 的 allow 规则沉淀）。
 *
 * 定位：审批卡上"不再询问"选择沉淀成的规则表，管"已经信任过什么"——
 * 与能力目录（工具在不在）、权限模式（愿不愿被打扰）各管一维，互不替代。
 *
 * 三类规则：
 * - command         命令族前缀（如 "svn commit *"）：run_command ask 档命中 allow 规则
 *                   且复合命令每段都被覆盖才自动放行；deny 规则任何档位优先拦截。
 * - directory       目录读前缀（如 "E:\code\WonWork"）：只读命令/文件原语读取触及
 *                   未登记目录时升级为 ask；批准后目录进可读集，同类读取不再询问。
 * - directory-write 目录写前缀（2026-09-01 P0-7）：write_file/str_replace 写工作区外
 *                   目录首次 ask 后沉淀；**写授权隐含读授权**（claude-code "edit 权限
 *                   隐含 read" 同款）——命中本档的路径读取同样放行。
 *
 * 三档沉淀（对齐 CC 的 session/project 级 allow）：
 * - 本次     = 审批卡只点"允许一次"，不落规则；
 * - 本对话   = 会话级内存规则（会话结束即失效，同 sessionGrants 语义）；
 * - 始终允许 = localStorage 持久规则，跨会话生效。
 *
 * 内置种子（2026-08-31 拍板，见 SEED_COMMAND_RULES）：默认对齐
 * `claude --permission-mode acceptEdits --allowedTools "Read,Write,Edit,Bash,Git,Npm,Pip"`——
 * 可解析命令默认预授权，不每个新命令问一次。防线不收在规则层而收在分类器：
 * deny（机器级破坏）照拒、destructive（删除/移动/杀进程）照问且不沉淀、
 * 解析不了的命令照问（fail-closed）——比 claude 的 Bash 全放行多两道闸（既有拍板，勿放宽）。
 * 目录闸不受种子影响：未登记目录仍需批准一次（目录族维度独立）。
 *
 * 独立成模块而非放进 store：与 sessionGrants 同理，避免 chatStore/agenticLoop/
 * backendToolOverrides 之间的循环依赖。
 */

import { splitCompound } from './commandClassifier'
import type { SuggestedPermissionRule } from './types'

export type { SuggestedPermissionRule }

/** 沉淀档位：本对话（会话级内存）/ 长期（localStorage 持久）。"本次"=不落规则 */
export type PermissionRuleScope = 'conversation' | 'longterm'

export interface PermissionRuleEntry {
  kind: 'command' | 'directory' | 'directory-write'
  pattern: string
  scope: PermissionRuleScope
  /** scope=conversation 时归属的会话 id（字符串形） */
  conversationId?: string
  createdAt: number
}

const LONGTERM_STORAGE_KEY = 'wonclaw-permission-rules-v1'

/**
 * 任务会话家族映射（2026-09-02 实测拍板）：任务会话 id → 父会话 id。
 * 审批权限主对话与任务会话共用——本对话档规则以家族根（父会话）为键：
 * 主对话批准的，任务会话直接继承；任务会话里批准的，落回主对话键下。
 * 长期档本就全局（localStorage 无会话键），不受影响。
 * 由 taskSession 在建会话/续跑时登记；进程级内存（与本对话规则同寿命，无需持久化）。
 */
const taskSessionFamily = new Map<string, string>()

export function registerTaskSessionFamily(taskConversationId: string, parentConversationId: string): void {
  taskSessionFamily.set(taskConversationId, parentConversationId)
}

/**
 * 从会话列表重建家族映射（刷新/重开后内存映射丢失，任务会话归属真相在会话记录的
 * parentConversationId 上）。loadConversations 后调用；全量替换，失存的任务会话键同步清掉。
 */
export function rebuildTaskSessionFamilies(
  conversations: Array<{ id: number; parentConversationId?: number | null }>
): void {
  taskSessionFamily.clear()
  for (const c of conversations) {
    if (c.parentConversationId != null) {
      taskSessionFamily.set(String(c.id), String(c.parentConversationId))
    }
  }
}

/** 规则归属键：任务会话解析到家族根（父会话），其余原样。读写两侧共用此解析。 */
function resolveFamilyKey(conversationId: string): string {
  return taskSessionFamily.get(conversationId) ?? conversationId
}

/** 本对话规则：convId → 规则列表（不持久化，会话语义） */
const conversationRules = new Map<string, PermissionRuleEntry[]>()
let longtermCache: PermissionRuleEntry[] | null = null

function loadLongterm(): PermissionRuleEntry[] {
  if (longtermCache) return longtermCache
  try {
    const raw = localStorage.getItem(LONGTERM_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    longtermCache = Array.isArray(parsed) ? (parsed as PermissionRuleEntry[]) : []
  } catch {
    longtermCache = []
  }
  return longtermCache
}

function saveLongterm(): void {
  try {
    localStorage.setItem(LONGTERM_STORAGE_KEY, JSON.stringify(longtermCache ?? []))
  } catch (err) {
    console.warn('[permissionRules] 长期规则持久化失败:', err)
  }
}

function ruleKey(r: Pick<PermissionRuleEntry, 'kind' | 'pattern' | 'scope' | 'conversationId'>): string {
  return `${r.kind}|${r.scope}|${r.conversationId ?? ''}|${r.pattern.toLowerCase()}`
}

/** 沉淀一条规则；同键去重（重复批准同族命令不累积） */
export function addRule(entry: Omit<PermissionRuleEntry, 'createdAt'>): void {
  const full: PermissionRuleEntry = { ...entry, createdAt: Date.now() }
  if (entry.scope === 'longterm') {
    const list = loadLongterm()
    if (!list.some((r) => ruleKey(r) === ruleKey(full))) {
      longtermCache = [...list, full]
      saveLongterm()
    }
    return
  }
  const convId = entry.conversationId
  if (!convId) return
  const familyKey = resolveFamilyKey(convId)
  const list = conversationRules.get(familyKey) ?? []
  if (!list.some((r) => ruleKey(r) === ruleKey({ ...full, conversationId: familyKey }))) {
    conversationRules.set(familyKey, [...list, { ...full, conversationId: familyKey }])
  }
}

/** 列出可见规则（convId 给定时含本对话规则；长期规则恒含） */
export function listRules(conversationId?: string | null): PermissionRuleEntry[] {
  const conv = conversationId ? (conversationRules.get(resolveFamilyKey(conversationId)) ?? []) : []
  return [...loadLongterm(), ...conv]
}

/** 撤销一条规则（按 kind+pattern+scope+conversationId 精确匹配） */
export function removeRule(target: Omit<PermissionRuleEntry, 'createdAt'>): void {
  const key = ruleKey(target)
  if (target.scope === 'longterm') {
    longtermCache = loadLongterm().filter((r) => ruleKey(r) !== key)
    saveLongterm()
    return
  }
  const convId = target.conversationId
  if (!convId) return
  const familyKey = resolveFamilyKey(convId)
  const list = conversationRules.get(familyKey)
  if (list) conversationRules.set(familyKey, list.filter((r) => ruleKey(r) !== ruleKey({ ...target, conversationId: familyKey })))
}

/** 会话结束/删除时清理本对话规则 */
export function clearConversationRules(conversationId: string): void {
  conversationRules.delete(conversationId)
}

function activeRules(conversationId: string | null): PermissionRuleEntry[] {
  return [...SEED_COMMAND_RULES, ...listRules(conversationId)]
}

/**
 * 内置种子 allow 规则（2026-08-31 拍板）：默认对齐
 * `claude --allowedTools "Read,Write,Edit,Bash,Git,Npm,Pip"` 的 Bash 全族预授权——
 * "*" 命中所有可解析命令段，新命令不再逐一询问。常量不进 localStorage
 * （内置规则非用户规则，权限表 UI 不显示）；用户在审批链外加的 "!" deny 规则
 * 在 commandRuleVerdict 里先于 allow 判定，可压住种子。
 * 不覆盖的三道闸（分类器层，规则层管不到）：
 * deny 级（格式化/注册表/账户/关机）、destructive（删除/移动/杀进程，每次照问）、
 * 解析失败的命令（fail-closed 照问）。
 */
const SEED_COMMAND_RULES: PermissionRuleEntry[] = [
  { kind: 'command', pattern: '*', scope: 'longterm', createdAt: 0 },
]

// ── 命令族匹配 ──────────────────────────────────────────────

/**
 * 单段命令是否命中规则模式。
 * 模式语法：空格分隔的词元前缀，末尾 "*" 表示通配剩余参数——
 * "svn commit *" 命中 "svn commit -m x"；"svn status"（无通配）只命中整段完全相等。
 */
function matchCommandPattern(pattern: string, segment: string): boolean {
  const p = pattern.trim()
  if (!p) return false
  const s = segment.trim().replace(/\s+/g, ' ')
  if (!s) return false
  if (p.endsWith(' *')) {
    const head = p.slice(0, -2)
    return s === head || s.startsWith(head + ' ')
  }
  if (p === '*') return true
  return s === p
}

/**
 * 命令的规则裁决：deny 任意段命中即拒；allow 需复合命令每一段都被 allow 规则覆盖
 * （fail-closed：一段没覆盖就回到 ask）。无命中返回 null。
 */
export function commandRuleVerdict(
  conversationId: string | null,
  command: string
): 'allow' | 'deny' | null {
  const rules = activeRules(conversationId).filter((r) => r.kind === 'command')
  if (rules.length === 0) return null
  const segments = splitCompound(command)
    .map((s) => s.trim())
    .filter(Boolean)
  if (segments.length === 0) return null

  // deny 规则：pattern 以 "!" 开头（addRule 侧不暴露，保留给未来的管理界面）
  const denyRules = rules.filter((r) => r.pattern.startsWith('!'))
  for (const seg of segments) {
    if (denyRules.some((r) => matchCommandPattern(r.pattern.slice(1), seg))) return 'deny'
  }

  const allowRules = rules.filter((r) => !r.pattern.startsWith('!'))
  if (allowRules.length === 0) return null
  const allCovered = segments.every((seg) =>
    allowRules.some((r) => matchCommandPattern(r.pattern, seg))
  )
  return allCovered ? 'allow' : null
}

/** 从命令生成命令族规则建议：首词元（多词头工具取两词元）+ " *" */
const MULTIWORD_HEADS = new Set([
  'git', 'svn', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'dotnet', 'pip', 'pip3', 'python', 'py',
])

export function suggestCommandRule(command: string): SuggestedPermissionRule | null {
  const first = splitCompound(command).map((s) => s.trim()).filter(Boolean)[0]
  if (!first) return null
  const tokens = first.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  let head = tokens[0].replace(/^["']|["']$/g, '')
  if (head.toLowerCase().endsWith('.exe')) head = head.slice(0, -4)
  const slash = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'))
  if (slash >= 0) head = head.slice(slash + 1)
  if (!head) return null
  const second = tokens[1]?.replace(/^["']|["']$/g, '')
  const family =
    MULTIWORD_HEADS.has(head.toLowerCase()) && second && !second.startsWith('-')
      ? `${head} ${second}`
      : head
  return {
    kind: 'command',
    pattern: `${family} *`,
    label: `"${family}" 开头的命令`,
  }
}

// ── 目录匹配 ──────────────────────────────────────────────

/** 后端已登记目录根（P0-3 挂载点登记表，机器级持久），启动时由 chatStore 拉取灌入 */
let backendRegisteredRoots: string[] = []

export function setBackendRegisteredRoots(roots: string[]): void {
  backendRegisteredRoots = Array.isArray(roots) ? roots : []
}

/** 路径归一化：正斜杠转反斜杠、小写、去尾部分隔符；Git Bash 的 /c/... 转 C:\... */
export function normalizeFsPath(p: string): string {
  let s = p.trim().replace(/^["']|["']$/g, '')
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/)
  if (m) s = `${m[1]}:\\${m[2]}`
  s = s.replace(/\//g, '\\').toLowerCase()
  // 源码转义写法（Python/JSON 字符串里的 "E:\\a\\b"）归一为单反斜杠；
  // UNC 头（\\server\share）保持不动
  if (!s.startsWith('\\\\')) s = s.replace(/\\{2,}/g, '\\')
  while (s.endsWith('\\') && s.length > 3) s = s.slice(0, -1)
  return s
}

function isUnderDir(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(dir + '\\')
}

/**
 * 绝对路径是否已被允许读取：workspace 根等 extraRoots + 后端登记表 + 目录规则
 * 共同构成可读集。
 */
export function isDirectoryAllowed(
  conversationId: string | null,
  absPath: string,
  extraRoots: string[]
): boolean {
  const target = normalizeFsPath(absPath)
  if (!target) return true
  for (const root of [...extraRoots, ...backendRegisteredRoots]) {
    const r = normalizeFsPath(root)
    if (r && isUnderDir(target, r)) return true
  }
  // directory-write 同列：写授权隐含读授权（见文件头三类规则注释）
  const dirRules = activeRules(conversationId).filter(
    (r) => r.kind === 'directory' || r.kind === 'directory-write'
  )
  return dirRules.some((r) => isUnderDir(target, normalizeFsPath(r.pattern)))
}

/**
 * 覆盖 absPath 的目录规则（路径落在规则目录内即覆盖），供目录挑战自愈判定
 * （toolExecutor.handleDirectoryChallenge）：命中 = 用户此前批准过该目录
 * （本对话/始终），后端 directory_not_registered 挑战可按规则档位静默补登记
 * 并重试，不再弹卡——前后端登记存储发散（如后端重启清会话层）在此自愈。
 */
export function findDirectoryRuleCovering(
  conversationId: string | null,
  absPath: string
): PermissionRuleEntry | null {
  const target = normalizeFsPath(absPath)
  if (!target) return null
  // directory-write 同列：写授权隐含读授权——已批准写入的目录，后端登记自愈同样放行
  const dirRules = activeRules(conversationId).filter(
    (r) => r.kind === 'directory' || r.kind === 'directory-write'
  )
  return dirRules.find((r) => isUnderDir(target, normalizeFsPath(r.pattern))) ?? null
}

/**
 * 覆盖 absPath 的目录写规则（2026-09-01 P0-7 写审批）：write_file/str_replace
 * checkPermissions 的放行判据——只有 directory-write 档算数（读授权不隐含写）。
 */
export function findDirectoryWriteRuleCovering(
  conversationId: string | null,
  absPath: string
): PermissionRuleEntry | null {
  const target = normalizeFsPath(absPath)
  if (!target) return null
  const dirRules = activeRules(conversationId).filter((r) => r.kind === 'directory-write')
  return dirRules.find((r) => isUnderDir(target, normalizeFsPath(r.pattern))) ?? null
}

/** 从未登记路径生成目录规则建议：取首个路径的父目录（带扩展名的视为文件） */
export function suggestDirectoryRule(paths: string[]): SuggestedPermissionRule | null {
  const first = paths[0]
  if (!first) return null
  const normalized = normalizeFsPath(first)
  if (!normalized) return null
  const lastSep = normalized.lastIndexOf('\\')
  if (lastSep <= 2) return { kind: 'directory', pattern: normalized, label: `读取目录 ${normalized}` }
  const tail = normalized.slice(lastSep + 1)
  const dir = tail.includes('.') ? normalized.slice(0, lastSep) : normalized
  return { kind: 'directory', pattern: dir, label: `读取目录 ${dir}` }
}

/** 写版目录规则建议（2026-09-01 P0-7）：同 suggestDirectoryRule，kind=directory-write */
export function suggestDirectoryWriteRule(paths: string[]): SuggestedPermissionRule | null {
  const base = suggestDirectoryRule(paths)
  if (!base) return null
  return { kind: 'directory-write', pattern: base.pattern, label: `写入目录 ${base.pattern}` }
}

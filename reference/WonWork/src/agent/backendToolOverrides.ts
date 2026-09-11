import type { FrontendToolRegistry } from './toolRegistry'
import { classifySql } from './sqlOperationClassifier'
import { classifyCommand, extractAbsolutePaths } from './commandClassifier'
import {
  commandRuleVerdict,
  isDirectoryAllowed,
  suggestCommandRule,
  suggestDirectoryRule,
} from './permissionRules'
import { useWorkspaceFileStore } from '@/stores/workspaceFileStore'
import type { PermissionResult, ToolPermissionContext } from './types'

/**
 * 后端工具目录加载后的动态覆盖。
 *
 * 后端工具目录只包含静态元数据，但部分工具的实际风险随输入变化。
 * 在这里为这类工具附加前端权限检查，使审批/提示在调用后端前就能按参数动态判定。
 */
export function applyBackendToolOverrides(registry: FrontendToolRegistry): void {
  attachSqlToolDynamicApproval(registry)
  attachRunCommandDynamicApproval(registry)
}

/**
 * execute_sql_query 的动态审批策略：
 * - 读操作（SELECT / PRAGMA / EXPLAIN）直接放行；
 * - 写操作（INSERT / UPDATE / DELETE / DDL 等）要求用户显式确认；
 * - 参数为空或包含明显注入标记时拒绝，不调用后端。
 *
 * 2026-07-24 审批语义修正（与权限模式字面意义对齐）：
 * 1. 静态 riskLevel 从后端目录的 'elevated' 降为 'standard'。
 *    原因：elevated 会让 toolExecutor 在 auto（写操作确认）模式下对【所有】调用
 *    发起审批——包括 SELECT 纯读，违背"读自动 · 写确认"。本工具的真实风险
 *    取决于 SQL 内容而非工具本身，静态标高只会让动态分类器形同虚设。
 * 2. isReadOnly 改为按输入动态判定：sandbox（沙箱禁写）下 SELECT 放行、写拒绝。
 * 3. 所有 SQL 写操作 alwaysAsk=true：bypass（全部自动）也保留确认。
 *    用户拍板："全部自动几乎允许全部，例外是 SQL 的 UPDATE/DELETE 这种"——
 *    SQL 写直达企业生产库且不可回滚，不属于"其余都可以通过"。
 */
function attachSqlToolDynamicApproval(registry: FrontendToolRegistry): void {
  const tool = registry.get('execute_sql_query')
  if (!tool) return

  registry.register({
    ...tool,
    riskLevel: 'standard',
    isReadOnly: (input: unknown): boolean => {
      const args = (input || {}) as Record<string, unknown>
      const sql = typeof args.sql === 'string' ? args.sql.trim() : ''
      if (!sql) return false
      return classifySql(sql).isReadOnly
    },
    checkPermissions: (input: unknown, _context: ToolPermissionContext): PermissionResult => {
      const args = (input || {}) as Record<string, unknown>
      const sql = typeof args.sql === 'string' ? args.sql.trim() : ''

      if (!sql) {
        return {
          allowed: false,
          behavior: 'deny',
          reason: 'SQL 参数为空，无法执行。',
        }
      }

      if (sql.includes(';') || sql.includes('--') || sql.includes('/*') || sql.includes('*/')) {
        return {
          allowed: false,
          behavior: 'deny',
          reason: 'SQL 中不能包含分号或注释。',
        }
      }

      const classification = classifySql(sql)
      if (classification.isReadOnly) {
        return { allowed: true, behavior: 'allow' }
      }

      const tables = classification.tables.length > 0 ? classification.tables.join(', ') : '未知表'
      // 所有写操作在 bypass 下也保留确认（alwaysAsk）——直达生产库不可回滚；
      // 语气上区分普通写与破坏性写，便于用户判断风险。
      const DESTRUCTIVE_OPS = new Set(['DELETE', 'DROP', 'TRUNCATE', 'ALTER', 'RENAME'])
      const isDestructiveOp = DESTRUCTIVE_OPS.has(classification.operation)
      return {
        allowed: false,
        behavior: 'ask',
        alwaysAsk: true,
        reason: isDestructiveOp
          ? `SQL 破坏性操作（${classification.operation}）需要确认（全部自动模式下仍保留）。涉及表：${tables}。`
          : `SQL 写操作（${classification.operation}）需要确认（全部自动模式下仍保留）。涉及表：${tables}。确认后才会发送给后端执行。`,
      }
    },
  })
}

/**
 * run_command 的动态审批策略（2026-08-30 下限工程 P0-2 权限表接线版）：
 * - 机器级破坏命令 deny（分类器硬地板）；
 * - 删除/移动/杀进程类 alwaysAsk 且不沉淀规则（误删没有撤销键，与 SQL 写同一纪律）；
 * - 目录闸罩住所有"命令侧已放行"的调用（只读命令 或 命中命令族 allow 规则）：
 *   command 里的绝对路径 + cwd 参数都要落在登记根/目录规则内，否则升级为 ask
 *   （目录族规则），批准后该目录进本对话/长期可读集，后端 cd 持久化同步解锁；
 * - 命令族种子 allow（permissionRules SEED_COMMAND_RULES，2026-08-31 拍板）：默认对齐
 *   claude --allowedTools "…Bash,Git,Npm,Pip"——可解析命令预授权，不再逐一询问；
 *   ask 档只剩解析失败的命令（fail-closed）。
 * - **所有 ask 均 alwaysAsk**（2026-08-31 用户拍板）：「全部自动」模式下 bash 开放命令
 *   的 ask 保留确认，与 SQL 写同级例外——对齐 claude-code permissions.ts 1f/1g
 *   （内容级 ask 与路径类 safetyCheck 免疫 bypassPermissions：bypass 委托的是执行
 *   风险判断，授权边界扩张不委托）。此前不带 alwaysAsk 的 ask 在 bypass 下被静默
 *   改写为 allow，命令直达后端硬拒"目录未登记"，前端永无审批卡（验收实测根因）。
 * 静态 riskLevel 保持 standard，真实风险由 commandClassifier 按命令内容判定——
 * 与 execute_sql_query 同一模式（否则静态标高会让只读命令在 auto 下也被审批）。
 */
function attachRunCommandDynamicApproval(registry: FrontendToolRegistry): void {
  const tool = registry.get('run_command')
  if (!tool) return

  registry.register({
    ...tool,
    riskLevel: 'standard',
    isReadOnly: (input: unknown): boolean => {
      const args = (input || {}) as Record<string, unknown>
      const command = typeof args.command === 'string' ? args.command.trim() : ''
      if (!command) return false
      return classifyCommand(command).level === 'allow'
    },
    checkPermissions: (input: unknown, context: ToolPermissionContext): PermissionResult => {
      const args = (input || {}) as Record<string, unknown>
      const command = typeof args.command === 'string' ? args.command.trim() : ''

      if (!command) {
        return {
          allowed: false,
          behavior: 'deny',
          reason: '命令为空，无法执行。',
        }
      }

      const convId = context.conversationId != null ? String(context.conversationId) : null
      const classification = classifyCommand(command)

      // 目录闸输入：command 里提取的绝对路径 + cwd 参数（整体就是一个路径，不做正则提取——
      // 正则到空白为止会截断带空格目录，2026-08-31 验收实测：cwd 参数此前根本没进闸）。
      // /workspace 虚拟路径是工作区内部，跳过（/project 已退役，后端会显式报错）。
      const paths = extractAbsolutePaths(command)
      const cwdArg = typeof args.cwd === 'string' ? args.cwd.trim().replace(/^["']|["']$/g, '') : ''
      if (cwdArg && !/^\/workspace(\/|$)/.test(cwdArg)) paths.push(cwdArg)
      const workspaceRoot = useWorkspaceFileStore.getState().workspacePath
      const roots = workspaceRoot ? [workspaceRoot] : []
      const outside = paths.filter((p) => !isDirectoryAllowed(convId, p, roots))

      // cd 特殊档（2026-08-31 拍板 A）：cd 不是读操作——它把后续所有命令的执行现场
      // 挪到目标目录（授权边界改变）。目录已登记/工作区内 → 直接放行；未登记 → ask。
      // 批准即完成本对话登记（目录授权无"一次性"语义，claude-code "allow reading
      // from X/ during this session" 同款）：该目录及子目录不再询问、cd 持久生效。
      const isBareCd = /^cd\s+/i.test(command) && !/&&|\|\||;|\|/.test(command)
      if (isBareCd && classification.level !== 'deny') {
        if (outside.length === 0) return { allowed: true, behavior: 'allow' }
        const suggestion = suggestDirectoryRule(outside)
        return {
          allowed: false,
          behavior: 'ask',
          alwaysAsk: true,
          reason:
            `将把工作目录切换到未登记目录：${outside[0]}。批准即在本对话内允许该目录及子目录` +
            `（不再询问、cd 生效）；选「始终允许」则跨会话生效。\n命令：${command}`,
          suggestedRule: suggestion ?? undefined,
        }
      }

      if (classification.level === 'deny') {
        return { allowed: false, behavior: 'deny', reason: classification.reason }
      }

      // 权限表 deny 规则任何档位优先（"!" 前缀模式，管理界面预留）
      if (commandRuleVerdict(convId, command) === 'deny') {
        return {
          allowed: false,
          behavior: 'deny',
          reason: '命中权限表的拒绝规则，命令被拦截。如需执行请先在权限表撤销该规则。',
        }
      }

      if (classification.destructive) {
        // 降级纪律：破坏性命令不沉淀规则、不自动放行，每次都问
        const excerpt = command.length > 120 ? `${command.slice(0, 120)}…` : command
        return {
          allowed: false,
          behavior: 'ask',
          alwaysAsk: true,
          reason: `${classification.reason}\n命令：${excerpt}`,
        }
      }

      // 目录闸对所有"命令侧已放行"的调用生效（只读命令 或 命中命令族 allow 规则）：
      // 此前只罩 allow 级，ask 级/规则放行的调用绕开目录闸，未登记 cwd 直接后端硬拒、
      // 前端无审批卡可沉淀（2026-08-31 验收实测）。
      const commandCleared =
        classification.level === 'allow' || commandRuleVerdict(convId, command) === 'allow'
      if (commandCleared) {
        if (outside.length > 0) {
          const suggestion = suggestDirectoryRule(outside)
          const excerpt = command.length > 120 ? `${command.slice(0, 120)}…` : command
          return {
            allowed: false,
            behavior: 'ask',
            // 目录登记 = agent 可达边界扩张，不随"全部自动"委托（见头部注释）
            alwaysAsk: true,
            reason:
              `命令将读取或以 cwd 进入未登记目录：${outside[0]}。批准即在本对话内允许该目录及子目录` +
              `（不再询问、cd 生效）；选「始终允许」则跨会话生效。\n命令：${excerpt}`,
            suggestedRule: suggestion ?? undefined,
          }
        }
        return { allowed: true, behavior: 'allow' }
      }

      const excerpt = command.length > 120 ? `${command.slice(0, 120)}…` : command
      return {
        allowed: false,
        behavior: 'ask',
        // bash 开放命令的确认在"全部自动"下保留（2026-08-31 拍板，同 SQL 写纪律）；
        // 沉淀不受限——批准时选"记住"后同类命令不再询问（权限表 allow 规则接管）
        alwaysAsk: true,
        reason:
          outside.length > 0
            ? `${classification.reason}（另注意：${outside[0]} 未登记——如需在该目录持续工作，再执行一条指向它的只读命令并在审批卡批准，即可完成目录登记）\n命令：${excerpt}`
            : `${classification.reason}\n命令：${excerpt}`,
        suggestedRule: suggestCommandRule(command) ?? undefined,
      }
    },
  })
}

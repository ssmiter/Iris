/**
 * 会话级权限授权记忆。
 *
 * 独立成模块而非放进 store：chatStore 与 agenticLoop 互相引用，
 * 授权记忆放这里双方都能 import 而不产生循环依赖。
 * 不持久化——刷新页面后需重新确认（会话语义 = 本次打开的对话）。
 * 2026-09-01 P0-7：/project 轨退役后暂无在用的授权键，机制保留给未来的会话级授权。
 */

const grants = new Map<string, Set<string>>()

function sessionKey(conversationId?: number | null): string {
  return conversationId != null ? String(conversationId) : 'default'
}

export function hasSessionGrant(conversationId: number | null | undefined, grant: string): boolean {
  return grants.get(sessionKey(conversationId))?.has(grant) ?? false
}

export function addSessionGrant(conversationId: number | null | undefined, grant: string): void {
  const key = sessionKey(conversationId)
  let set = grants.get(key)
  if (!set) {
    set = new Set()
    grants.set(key, set)
  }
  set.add(grant)
}

/** 读取某会话的全部授权（用于填充 ToolPermissionContext.grantedPermissions） */
export function getSessionGrants(conversationId: number | null | undefined): Set<string> | undefined {
  return grants.get(sessionKey(conversationId))
}

/** 清除某会话的全部授权（如切换/删除会话时） */
export function clearSessionGrants(conversationId: number | null | undefined): void {
  grants.delete(sessionKey(conversationId))
}

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 用户供给事实库（2026-08-30 下限工程 P0-3；2026-08-31 扩全局/项目双层+定位放宽）。
 *
 * 定位：结构化 KV 簿记（2026-08-31 用户拍板放宽：少约束、适当引导）——
 * 环境坐标、常用项目入口（router 式导航）、凭据账号、与项目无关的全局信息，
 * 凡是会反复用到的精确信息都合适；条目明文存本机 localStorage。
 * 与记忆（~/.wonwork/memory/ 文件，fileMemoryStore）分工：记忆 = 语义级理解（用户偏好/决策/某件事的来龙去脉，
 * 与特定场景强相关、可含逻辑）；事实 = 通用 KV（精确字符串坐标，可被
 * run_command / 文件操作直接消费，不是自然语言提炼）。两者不混放。
 *
 * 双层（2026-08-31 拍板，对齐 claude-code「项目状态存全局、按项目键隔离」）：
 * - 全局层 facts：机器级坐标，任何项目都生效（如 vcs.tool）；
 * - 项目层 projectFacts：项目根目录路径 → key → fact，只在该项目（目录链）内生效
 *   （如 project.root、project.svn_url）。项目键=目录本身，不设独立"项目"实体——
 *   recall 时沿当前 shell cwd 祖先链合并，近的覆盖远的（CLAUDE.md 分层同哲学）。
 *
 * 注入纪律（用户拍板 2026-08-30）：不做每轮 trailingMeta 反复注入——干扰主任务。
 * 模型侧触达靠两点：①静态提示词一行告知机制存在（记忆系统节）；
 * ②recall_facts 按需查询（与 945 工具按需加载同哲学：知道在哪，用时再取）。
 *
 * "同一件事问第二次就是缺陷"：ask_user 获得答案后模型必须 register_fact 登记，
 * 后续会话 recall_facts 直接命中。
 */

export interface UserFact {
  value: string
  /** 用途说明（"这是什么"），帮助模型判断适用场景 */
  note?: string
  updatedAt: string
}

interface UserFactsState {
  /** 全局层：任何项目都生效的机器级坐标 */
  facts: Record<string, UserFact>
  /** 项目层：项目根目录（归一化路径）→ key → fact */
  projectFacts: Record<string, Record<string, UserFact>>
  /** projectRoot 缺省=全局层；给了就登记到该项目层 */
  registerFact: (key: string, value: string, note?: string, projectRoot?: string) => void
  /** projectRoot 缺省=全局层；给了就只删该项目层条目 */
  removeFact: (key: string, projectRoot?: string) => void
}

export const useUserFactsStore = create<UserFactsState>()(
  persist(
    (set) => ({
      facts: {},
      projectFacts: {},
      registerFact: (key, value, note, projectRoot) =>
        set((s) => {
          const entry: UserFact = { value, note, updatedAt: new Date().toISOString() }
          if (projectRoot) {
            const layer = { ...(s.projectFacts[projectRoot] ?? {}), [key]: entry }
            return { projectFacts: { ...s.projectFacts, [projectRoot]: layer } }
          }
          return { facts: { ...s.facts, [key]: entry } }
        }),
      removeFact: (key, projectRoot) =>
        set((s) => {
          if (projectRoot) {
            const layer = { ...(s.projectFacts[projectRoot] ?? {}) }
            delete layer[key]
            const projectFacts = { ...s.projectFacts }
            if (Object.keys(layer).length === 0) delete projectFacts[projectRoot]
            else projectFacts[projectRoot] = layer
            return { projectFacts }
          }
          const facts = { ...s.facts }
          delete facts[key]
          return { facts }
        }),
    }),
    { name: 'wonclaw-user-facts' }
  )
)

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 进展黑板 store（2026-08-12，蓝图 v13 黑板板块 + claude-code TodoWrite 语义移植）
 *
 * 定位：对话级「目标 / 已确认 / 待办」三段的唯一事实源（产物段不进本 store，
 * 面板直接读 artifactDockStore）。模型经 update_board 工具整段替换式维护
 * （提供的段全量覆盖、未提供的不动——claude-code 同款，避免 diff 地狱）；
 * 用户可在右侧面板行内编辑（who='me'），编辑经 trailingMeta 随下一条用户
 * 消息告知模型（"点任意一条可直接修改，模型下一轮自然知道"）。
 *
 * 成本三道闸（用户拍板：不许每轮更新）：
 * 1. 工具 description 限定只在有意义边界更新（计划成形/一步完成/确认新事实）；
 * 2. 模型自己写的零注入（它刚写完，上下文自有）；只有用户手改才附快照；
 * 3. nag 封顶 8 轮一次，且只在有未完成待办时。
 *
 * 前缀缓存：注入只走 trailingMeta（附当轮用户消息尾部，随 wireContent 冻结），
 * 永不进 system 前缀——与记忆索引同通道（contextAssembler.ts:29-31）。
 *
 * 2026-08-30 用户拍板：不做黑板的强行注入（运行内哨兵/压缩后刷新均不做），
 * 黑板维持"用户可手改+8 轮 nag"的现状节律，不作为规范存活载体。
 */

export type BoardWho = 'me' | 'ai'
export type BoardTodoStatus = 'pending' | 'in_progress' | 'completed'

export interface BoardTodo {
  id: string
  content: string
  status: BoardTodoStatus
  /** 进行中形态（"正在做X"，P2 供加载指示消费；v1 仅承载） */
  activeForm?: string
}

export interface BoardFact {
  id: string
  text: string
}

export interface BoardData {
  goal: string
  facts: BoardFact[]
  todos: BoardTodo[]
  /** 条目级来源标注：'goal' | fact.id | todo.id → 'me'=用户手改 / 'ai'=模型整理 */
  who: Record<string, BoardWho>
  /** id 分配计数器（t{n}/f{n}），防复用 */
  nextId: number
  /** 用户手改未告知模型（下一条用户消息附快照后清除）；模型更新不清此标记 */
  userDirty: boolean
  /** 距模型上次更新黑板的用户轮数（nag 用；发送一轮 +1，模型更新/nag 注入归 0） */
  turnsSinceModelUpdate: number
  updatedAt: string
}

export interface BoardModelPatch {
  goal?: string
  facts?: string[]
  todos?: Array<{ content: string; status: BoardTodoStatus; activeForm?: string }>
}

export type BoardUserEdit =
  | { kind: 'goal'; value: string }
  | { kind: 'fact-add'; text: string }
  | { kind: 'fact-edit'; id: string; text: string }
  | { kind: 'fact-del'; id: string }
  | { kind: 'todo-add'; content: string }
  | { kind: 'todo-edit'; id: string; content: string }
  | { kind: 'todo-toggle'; id: string }
  | { kind: 'todo-del'; id: string }

/** nag 阈值：8 个用户轮未更新（claude-code 10 轮，我们对话节奏快取 8） */
const NAG_TURNS = 8

function emptyBoard(): BoardData {
  return {
    goal: '',
    facts: [],
    todos: [],
    who: {},
    nextId: 1,
    userDirty: false,
    turnsSinceModelUpdate: 0,
    updatedAt: new Date().toISOString(),
  }
}

const norm = (s: string) => s.trim().toLowerCase()

/** 模型整段替换时按内容保留旧 id 与 who（内容未变 = 同一条目） */
function rekey<T extends { id: string }>(
  oldItems: T[],
  newTexts: string[],
  prefix: string,
  who: Record<string, BoardWho>,
  nextId: number,
  make: (id: string, text: string) => T
): { items: T[]; nextId: number } {
  const byContent = new Map(oldItems.map((it) => [norm('text' in it ? (it as unknown as BoardFact).text : (it as unknown as BoardTodo).content), it]))
  let n = nextId
  const items = newTexts
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => {
      const kept = byContent.get(norm(text))
      if (kept) return { ...kept }
      const id = `${prefix}${n++}`
      who[id] = 'ai'
      return make(id, text)
    })
  // 清理已消失条目的 who
  const alive = new Set(items.map((it) => it.id))
  for (const key of Object.keys(who)) {
    if (key.startsWith(prefix) && !alive.has(key)) delete who[key]
  }
  return { items, nextId: n }
}

/** 黑板快照（注入用紧凑文本；模型工具结果同款格式，两处单一事实源） */
export function formatBoardSnapshot(board: BoardData): string {
  const lines: string[] = []
  lines.push(`目标：${board.goal || '（未设定）'}`)
  if (board.facts.length > 0) {
    lines.push('已确认：')
    board.facts.forEach((f) => lines.push(`- ${f.text}`))
  }
  if (board.todos.length > 0) {
    lines.push('待办：')
    board.todos.forEach((t, i) => lines.push(`${i + 1}. [${t.status}] ${t.content}`))
  }
  return lines.join('\n')
}

interface BoardStoreState {
  byConv: Record<string, BoardData>
  /** 本应用生命周期内已注入过快照的 convId（不持久化——重载后模型上下文为空，首轮需补注入） */
  injectedConvs: Record<string, true>

  getBoard: (convId: string | null) => BoardData | undefined
  /** 模型经 update_board 整段替换式更新（未提供的段不动）；返回更新后黑板 */
  applyModelUpdate: (convId: string, patch: BoardModelPatch) => BoardData
  /** 用户面板行内编辑：who='me' + userDirty 置位 */
  applyUserEdit: (convId: string, edit: BoardUserEdit) => void
  clearBoard: (convId: string) => void
  /**
   * 发送时唯一注入入口（chatStore trailingMeta 第三 provider）。
   * 返回本轮应附的文本（无则 null）；内部推进轮计数、消费 userDirty、记注入标记。
   * 优先级：用户手改快照 > 本会话首次快照（重载恢复） > nag（8 轮未更新且有开口待办）。
   */
  consumeTrailingMeta: (convId: string | null) => string | null
}

export const useBoardStore = create<BoardStoreState>()(
  persist(
    (set, get) => ({
      byConv: {},
      injectedConvs: {},

      getBoard: (convId) => (convId ? get().byConv[convId] : undefined),

      applyModelUpdate: (convId, patch) => {
        const cur = get().byConv[convId] ?? emptyBoard()
        const who = { ...cur.who }
        let nextId = cur.nextId

        let goal = cur.goal
        if (patch.goal !== undefined) {
          goal = patch.goal.trim()
          if (norm(goal) !== norm(cur.goal)) who.goal = 'ai'
        }

        let facts = cur.facts
        if (patch.facts !== undefined) {
          const r = rekey(cur.facts, patch.facts, 'f', who, nextId, (id, text) => ({ id, text }))
          facts = r.items
          nextId = r.nextId
        }

        let todos = cur.todos
        if (patch.todos !== undefined) {
          const statusByContent = new Map(patch.todos.map((t) => [norm(t.content), t]))
          const r = rekey(cur.todos, patch.todos.map((t) => t.content), 't', who, nextId, (id, text) => {
            const src = statusByContent.get(norm(text))!
            return { id, content: text, status: src.status, activeForm: src.activeForm }
          })
          // 保留的旧条目也要套用新状态/activeForm（内容没变但状态可能变了）
          todos = r.items.map((it) => {
            const src = statusByContent.get(norm(it.content))
            return src ? { ...it, status: src.status, activeForm: src.activeForm ?? it.activeForm } : it
          })
          nextId = r.nextId
        }

        const next: BoardData = {
          goal,
          facts,
          todos,
          who,
          nextId,
          userDirty: cur.userDirty,
          turnsSinceModelUpdate: 0,
          updatedAt: new Date().toISOString(),
        }
        set((s) => ({ byConv: { ...s.byConv, [convId]: next } }))
        return next
      },

      applyUserEdit: (convId, edit) => {
        const cur = get().byConv[convId] ?? emptyBoard()
        const who = { ...cur.who }
        let { goal, facts, todos, nextId } = cur

        switch (edit.kind) {
          case 'goal':
            goal = edit.value.trim()
            who.goal = 'me'
            break
          case 'fact-add': {
            const id = `f${nextId++}`
            facts = [...facts, { id, text: edit.text.trim() }].filter((f) => f.text)
            who[id] = 'me'
            break
          }
          case 'fact-edit':
            facts = facts.map((f) => (f.id === edit.id ? { ...f, text: edit.text.trim() } : f)).filter((f) => f.text)
            who[edit.id] = 'me'
            break
          case 'fact-del':
            facts = facts.filter((f) => f.id !== edit.id)
            delete who[edit.id]
            break
          case 'todo-add': {
            const id = `t${nextId++}`
            const content = edit.content.trim()
            if (content) {
              todos = [...todos, { id, content, status: 'pending' }]
              who[id] = 'me'
            }
            break
          }
          case 'todo-edit':
            todos = todos.map((t) => (t.id === edit.id ? { ...t, content: edit.content.trim() } : t)).filter((t) => t.content)
            who[edit.id] = 'me'
            break
          case 'todo-toggle':
            todos = todos.map((t) =>
              t.id === edit.id
                ? { ...t, status: t.status === 'completed' ? 'pending' : 'completed' }
                : t
            )
            who[edit.id] = 'me'
            break
          case 'todo-del':
            todos = todos.filter((t) => t.id !== edit.id)
            delete who[edit.id]
            break
        }

        const next: BoardData = {
          ...cur,
          goal,
          facts,
          todos,
          who,
          nextId,
          userDirty: true,
          updatedAt: new Date().toISOString(),
        }
        set((s) => ({ byConv: { ...s.byConv, [convId]: next } }))
      },

      clearBoard: (convId) => {
        set((s) => {
          const byConv = { ...s.byConv }
          delete byConv[convId]
          return { byConv }
        })
      },

      consumeTrailingMeta: (convId) => {
        if (!convId) return null
        const board = get().byConv[convId]
        if (!board) return null
        const hasContent = board.goal || board.facts.length > 0 || board.todos.length > 0
        if (!hasContent) return null

        const snapshot = formatBoardSnapshot(board)
        let meta: string | null = null

        if (board.userDirty) {
          meta = `[进展黑板 · 用户手动更新，请以这版为准]\n${snapshot}`
        } else if (!get().injectedConvs[convId]) {
          meta = `[进展黑板 · 当前状态]\n${snapshot}`
        } else if (
          board.turnsSinceModelUpdate >= NAG_TURNS &&
          board.todos.some((t) => t.status !== 'completed')
        ) {
          meta = `[提醒] 进展黑板已 ${NAG_TURNS} 轮未更新。若仍有多步任务在推进，请用 update_board 维护（计划变化/完成步骤时）；若任务已收尾，将剩余待办标 completed 或清理。以下为当前状态：\n${snapshot}`
        }

        // 轮计数推进（每个用户轮 +1）；注入了 nag 则归 0（防连续 nag）
        const nextTurns = meta?.startsWith('[提醒]') ? 0 : board.turnsSinceModelUpdate + 1
        set((s) => ({
          byConv: {
            ...s.byConv,
            [convId]: { ...board, userDirty: false, turnsSinceModelUpdate: nextTurns },
          },
          injectedConvs: { ...s.injectedConvs, [convId]: true },
        }))
        return meta
      },
    }),
    {
      name: 'wonclaw-progress-board',
      // injectedConvs 不持久化：应用重载后模型上下文为空，首轮发送需补注入快照
      partialize: (s) => ({ byConv: s.byConv }),
    }
  )
)

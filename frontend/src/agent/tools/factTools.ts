import type { Tool } from '@/agent/types'
import { useUserFactsStore, type UserFact } from '@/stores/userFactsStore'
import { useShellCwdStore } from '@/stores/shellCwdStore'

/**
 * 用户供给事实原语（2026-08-30 下限工程 P0-3；2026-08-31 扩全局/项目双层+定位放宽）。
 *
 * register_fact / recall_facts / forget_fact：结构化 KV 簿记，不限于"环境坐标"——
 * 路径、仓库地址、常用项目入口（router 式导航）、凭据账号、全局信息，
 * 凡是会反复用到的精确信息都合适（2026-08-31 用户拍板：少约束、适当引导，
 * 激发想象力；条目明文存本机 localStorage）。与记忆库分工见 userFactsStore 头注释。
 *
 * 设计纪律：
 * - 不反复注入上下文（用户拍板）——模型经静态提示词一行知道机制存在，
 *   需要时 recall_facts 按需取（与能力目录按需加载同哲学）；
 * - key 分层命名（2026-08-31 用户拍板，环境变量心智模型）：「大类.子项」两层，
 *   大类少量稳定（project/vcs/build/runtime/team）；recall_facts 的 prefix/categories
 *   参数配套按类检索与目录枚举，为千条规模预留治理空间；
 * - 双层（2026-08-31 拍板，对齐 claude-code）：全局层任何项目生效；项目层锚=
 *   当前 shell cwd（toolExecutor 从 run_command 回执被动追踪进 shellCwdStore），
 *   查询沿 cwd 祖先链合并、近的覆盖远的（CLAUDE.md 分层同哲学）。项目键=目录本身，
 *   不设独立"项目"实体、不做 VCS 探测；没跑过命令=没有当前项目（诚实冷启动）。
 * - 登记是本地键值簿记，非破坏性，read_only/standard 免审批；
 * - 注册面：主 loop 经 registerMemoryTools 全量三件；子 Agent（general/explore）
 *   只注册 recall_facts 只读件——查环境坐标是子环境需求，登记决策留主 loop。
 */

export const REGISTER_FACT_TOOL_NAME = 'register_fact'
export const RECALL_FACTS_TOOL_NAME = 'recall_facts'
export const FORGET_FACT_TOOL_NAME = 'forget_fact'

const KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/i

/** 目录键归一化：正斜杠、去尾斜杠、盘符大写（Windows 大小写不敏感由 lowerKey 兜底比较） */
function normalizeDir(p: string): string {
  let s = p.trim().replace(/\\/g, '/')
  s = s.replace(/\/+$/, '')
  if (/^[a-z]:/i.test(s)) s = s[0].toUpperCase() + s.slice(1)
  return s
}

const lowerKey = (p: string) => p.toLowerCase()

/**
 * 项目锚链：锚目录及其全部祖先目录（近→远）。anchor 缺省=当前 shell cwd；
 * cwd 未知且未显式给锚=空链（没有当前项目）。
 * 合并查询按「全局 → 远祖先 → … → 锚」顺序覆盖，等价 CLAUDE.md 分层：近的优先。
 */
function projectChainFrom(anchor?: string): string[] {
  const cwd = anchor ?? useShellCwdStore.getState().currentCwd
  if (!cwd) return []
  const dir = normalizeDir(cwd)
  const chain: string[] = [dir]
  let cur = dir
  while (true) {
    const idx = cur.lastIndexOf('/')
    if (idx < 0) break
    const parent = cur.slice(0, idx)
    if (!parent || parent === cur) break
    if (/^[A-Z]:$/.test(parent)) { chain.push(parent); break } // 盘符根封顶
    chain.push(parent)
    cur = parent
  }
  return chain
}

/** 在项目层按链找某目录的条目（大小写不敏感），返回 [存储键, 条目] */
function findProjectLayer(
  projectFacts: Record<string, Record<string, UserFact>>,
  dir: string
): [string, Record<string, UserFact>] | null {
  const want = lowerKey(dir)
  for (const [root, layer] of Object.entries(projectFacts)) {
    if (lowerKey(root) === want) return [root, layer]
  }
  return null
}

interface FactEntry {
  key: string
  value: string
  note?: string
  layer: 'global' | 'project'
  /** layer=project 时该事实所属的项目目录 */
  project?: string
}

/** 合并生效事实：全局层 + 锚目录祖先链项目层（远→近覆盖，近者优先）；anchor 缺省=当前 cwd */
function mergedFacts(anchor?: string): { entries: FactEntry[]; projectKnown: boolean } {
  const { facts, projectFacts } = useUserFactsStore.getState()
  const chain = projectChainFrom(anchor)
  const merged = new Map<string, FactEntry>()
  for (const [k, f] of Object.entries(facts)) {
    merged.set(k, { key: k, value: f.value, note: f.note, layer: 'global' })
  }
  for (const dir of [...chain].reverse()) {
    const hit = findProjectLayer(projectFacts, dir)
    if (!hit) continue
    const [root, layer] = hit
    for (const [k, f] of Object.entries(layer)) {
      merged.set(k, { key: k, value: f.value, note: f.note, layer: 'project', project: root })
    }
  }
  return { entries: [...merged.values()], projectKnown: chain.length > 0 }
}

interface RegisterFactInput {
  key?: string
  value?: string
  note?: string
  scope?: string
  project?: string
}

export const registerFactTool: Tool<RegisterFactInput, { content: string }> = {
  name: REGISTER_FACT_TOOL_NAME,
  description:
    '登记一条结构化事实（key-value），跨会话复用。facts 是通用 KV 簿记，不限于项目：' +
    '环境坐标（路径、仓库地址）、常用项目入口（登记后 recall 即导航）、凭据与账号、与具体项目无关的全局信息——' +
    '凡是会反复用到的精确信息都合适。所有条目明文保存在本机。' +
    '触发时机：用户通过 ask_user 或直接在对话中给出这类信息后立即登记——同一件事问用户第二次是缺陷。' +
    'key 用「大类.子项」两层小写命名（如 project.root、vcs.tool、runtime.dev_cmd），大类保持少量稳定；' +
    'value 存精确字符串（路径原样，不改写）。' +
    'scope=global（默认）任何项目生效；scope=project 只在当前项目目录链生效。' +
    '语义级的理解（偏好、决策、某件事的来龙去脉）不要放这里，用文件原语写入 ~/.wonwork/memory/（见记忆节）。已存在的 key 会被覆盖（用于更新）。',
  inputSchema: {
    type: 'object',
    required: ['key', 'value'],
    properties: {
      key: {
        type: 'string',
        description: '事实键名：「大类.子项」两层小写（字母/数字/._-），如 project.root',
      },
      value: { type: 'string', description: '事实值：精确字符串（路径保持原样）' },
      note: { type: 'string', description: '用途说明（这是什么、什么时候用），可选' },
      scope: {
        type: 'string',
        enum: ['global', 'project'],
        description: 'global（默认）=任何项目生效；project=只在当前项目目录链生效',
      },
      project: {
        type: 'string',
        description: 'scope=project 时的项目目录锚，缺省=当前 shell 工作目录；一般不用显式传',
      },
    },
  },
  riskLevel: 'read_only',
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: true,
  alwaysLoad: true,
  maxResultSizeChars: 2000,

  execute: async (input: RegisterFactInput): Promise<{ content: string }> => {
    const key = input.key?.trim() ?? ''
    const value = input.value?.trim() ?? ''
    if (!KEY_PATTERN.test(key)) {
      return { content: `登记失败：key "${key}" 不合法（小写字母/数字/._- 开头 64 字符内）。` }
    }
    if (!value) {
      return { content: '登记失败：value 不能为空。' }
    }
    if (input.scope === 'project') {
      const anchor = input.project?.trim()
        ? normalizeDir(input.project)
        : useShellCwdStore.getState().currentCwd
      if (!anchor) {
        return {
          content:
            '登记失败：scope=project 需要项目目录锚，但当前工作目录未知（本次会话还没执行过命令）。' +
            '请先执行相关命令确定工作目录，或改用 scope=global。',
        }
      }
      const root = normalizeDir(anchor)
      useUserFactsStore.getState().registerFact(key, value, input.note?.trim() || undefined, root)
      return { content: `已登记项目事实：${key} = ${value}（项目：${root}）。在该项目目录链内 recall_facts 可查。` }
    }
    useUserFactsStore.getState().registerFact(key, value, input.note?.trim() || undefined)
    return { content: `已登记事实：${key} = ${value}。后续会话 recall_facts 可查。` }
  },
}

interface RecallFactsInput {
  /** 精确取单条 */
  key?: string
  /** 按类取一组：key 等于该大类或以「大类.」开头的全部条目（如 prefix=project 取 project.*） */
  prefix?: string
  /** 只看已登记大类清单（目录式轻量查询，不拉回任何事实值） */
  categories?: boolean
  /** 直接查询指定项目目录链（缺省=当前工作目录链）；想在别的项目查 facts 又不想切目录时用 */
  project?: string
}

interface RecallFactsOutput {
  facts?: FactEntry[]
  categories?: Array<{ name: string; count: number }>
  note?: string
}

/** 大类=第一个 . 之前的段；无点的裸 key（历史遗留）自成一类，诚实暴露、顺带引导清理 */
function toCategories(entries: FactEntry[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const e of entries) {
    const cat = e.key.includes('.') ? e.key.slice(0, e.key.indexOf('.')) : e.key
    counts.set(cat, (counts.get(cat) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }))
}

const NO_PROJECT_NOTE = '当前工作目录未知（本次会话还没执行过命令），仅返回全局层；项目层事实未纳入——可先执行命令进入项目目录，或用 project 参数指定要查的项目目录。'

export const recallFactsTool: Tool<RecallFactsInput, RecallFactsOutput> = {
  name: RECALL_FACTS_TOOL_NAME,
  description:
    '查询已登记的结构化事实（环境坐标、常用路径导航、凭据、全局信息等）。' +
    '需要这类信息时不要猜、不要直接向用户要——先查这里；' +
    '查不到再用 ask_user 一次性带候选问清，并把答案用 register_fact 登记。' +
    '返回全局层+当前项目目录链的项目层（同名 key 项目层覆盖全局层）。' +
    'key 精确取单条；prefix 按类取一组；categories=true 只看已登记大类清单；project 指定项目目录链查询（不切目录也能查别的项目）；都不传返回全部（条数少时的常态）。',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '精确取单条事实（优先于其他参数）' },
      prefix: { type: 'string', description: '按类取一组：如 project 取 project.* 全部条目' },
      categories: { type: 'boolean', description: 'true 时只返回已登记大类清单（名称+条数），不拉回事实值' },
      project: { type: 'string', description: '查询指定项目目录链的事实（缺省=当前工作目录链）' },
    },
  },
  riskLevel: 'read_only',
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  alwaysLoad: true,
  maxResultSizeChars: 4000,

  execute: async (input: RecallFactsInput): Promise<RecallFactsOutput> => {
    const anchor = input.project?.trim() ? normalizeDir(input.project) : undefined
    const { entries, projectKnown } = mergedFacts(anchor)
    const tail = projectKnown ? undefined : NO_PROJECT_NOTE
    const key = input.key?.trim()
    if (key) {
      const hit = entries.find((e) => e.key === key)
      return hit
        ? { facts: [hit] }
        : { facts: [], note: `没有登记过 "${key}"。用 ask_user 向用户问清（带候选），得到答案后 register_fact 登记。` }
    }
    if (input.categories) {
      const cats = toCategories(entries)
      if (cats.length === 0) {
        return { categories: [], note: '事实库为空——还没有登记过任何用户供给事实。' }
      }
      return tail ? { categories: cats, note: tail } : { categories: cats }
    }
    const prefix = input.prefix?.trim()
    if (prefix) {
      const matched = entries.filter((e) => e.key === prefix || e.key.startsWith(`${prefix}.`))
      if (matched.length > 0) {
        return tail ? { facts: matched, note: tail } : { facts: matched }
      }
      // 空结果顺带返回可用大类：拼错与未登记可区分，顺带宣传已登记事实
      const cats = toCategories(entries).map((c) => `${c.name}（${c.count}）`)
      return {
        facts: [],
        note: cats.length > 0
          ? `"${prefix}" 类下没有任何登记。当前已登记大类：${cats.join('、')}。`
          : `"${prefix}" 类下没有任何登记（事实库为空）。`,
      }
    }
    if (entries.length === 0) {
      return { facts: [], note: '事实库为空——还没有登记过任何用户供给事实。' }
    }
    return tail ? { facts: entries, note: tail } : { facts: entries }
  },
}

interface ForgetFactInput {
  key?: string
  scope?: string
}

export const forgetFactTool: Tool<ForgetFactInput, { content: string }> = {
  name: FORGET_FACT_TOOL_NAME,
  description:
    '删除一条已登记的环境事实。用途：登记错误、key 改名迁移后清理旧 key、事实已失效。' +
    '删除不可恢复——只删确知多余或失效的条目；只是值变了请用 register_fact 覆盖更新，不要用本工具。' +
    '缺省在当前项目目录链（近者优先）与全局层中找第一个命中删除；scope=global/project 可限定只删哪层。',
  inputSchema: {
    type: 'object',
    required: ['key'],
    properties: {
      key: { type: 'string', description: '要删除的事实键名' },
      scope: {
        type: 'string',
        enum: ['global', 'project'],
        description: '限定删除层；缺省=项目目录链（近者优先）→全局层 第一个命中',
      },
    },
  },
  riskLevel: 'standard',
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: true,
  alwaysLoad: true,
  maxResultSizeChars: 1000,

  execute: async (input: ForgetFactInput): Promise<{ content: string }> => {
    const key = input.key?.trim() ?? ''
    if (!key) {
      return { content: '删除失败：key 不能为空。' }
    }
    const store = useUserFactsStore.getState()
    // 项目层：沿 cwd 祖先链近→远找第一个命中
    if (input.scope !== 'global') {
      for (const dir of projectChainFrom()) {
        const hit = findProjectLayer(store.projectFacts, dir)
        if (hit && hit[1][key]) {
          store.removeFact(key, hit[0])
          return { content: `已删除项目事实：${key}（项目：${hit[0]}）。` }
        }
      }
    }
    if (input.scope !== 'project') {
      if (store.facts[key]) {
        store.removeFact(key)
        return { content: `已删除全局事实：${key}。` }
      }
    }
    return { content: `没有找到 "${key}"${input.scope ? `（限定 ${input.scope} 层）` : ''}，无需删除。` }
  },
}

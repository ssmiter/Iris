import { create } from 'zustand'

/**
 * stateKeeperStore（2026-08-08 双 agent 写任务 P0）：状态任务的会话级协作登记处。
 *
 * 两个消费者的单一数据源：
 * ① consult_state 写前门控（toolExecutor）：会话存在活跃状态任务时，标记
 *    requiresStateConsult 的写工具必须持有 state agent 的 proceed 回执
 *    （一次性令牌，消费后下一笔写需重新对账——"写前对账"是结构保证不是 prompt 建议）；
 * ② compact 状态快照回注（chatStore buildStateSnapshotMessages）：压缩后把
 *    cachedContent 注入主 agent 上下文，compact 无缝不靠压缩器保真。
 *
 * 内存态（不落盘）：状态文件本身是持久层（/workspace/state/*.txt），本 store 只是
 * 协作信令；页面刷新后门控自动失活（statePath=null=门不开），主 agent 下次对账
 * 自然重新激活——fail-open 方向是有意的：门控是为了对账发生，不是为了锁死写。
 *
 * 登记入口：agent 工具 subagent_type=state 完成（回执）+ write_state 落盘（内容缓存）。
 */
export interface StateReceipt {
  verdict: 'updated' | 'proceed' | 'hold' | 'offtopic' | 'archive' | 'error'
  summary: string
  concerns: string[]
  /**
   * 令牌绑定（2026-08-09 拍板 S2）：proceed 回执声明本次放行的是哪个工具的
   * 哪笔动作；消费时比对当前调用工具名，不符即拦——主 Agent 并行发两笔写时，
   * publish 不能拿 adjust 的对账结论放行。缺省（旧回执/未声明）=不绑定，向后兼容。
   */
  actionTool?: string
  /**
   * 终结判据信号（2026-08-10 体系映射 E1 修复）：state agent 判定目标判据全部达成、
   * 任务实质收尾时置 true——主 Agent 据此向用户确认后再派【归档】。
   * 只是建议信号，归档动作本身仍走【归档】派遣（archive 回执才真正解除门控）。
   */
  suggestArchive?: boolean
  at: number
}

/**
 * 对账受阻记录（2026-08-10 体系映射 L1/L2/L4 修复，Graph Engineering"失败路由"构件）：
 * hold=对账发现阻碍；error=对账本身失败（撞顶/异常/未提交回执）。
 * 连续受阻达到 CONSULT_STOP_ESCALATE_THRESHOLD 次，门控 deny 文案升级为
 * "路由到人工"（向用户说明卡点请其定夺），防止对账 ping-pong 死循环闷头空转。
 */
export interface ConsultStop {
  kind: 'hold' | 'error'
  summary: string
  concerns: string[]
  at: number
}

/** 对账连续受阻升级人工的阈值（Graph Engineering：受控循环必须有收敛判据） */
export const CONSULT_STOP_ESCALATE_THRESHOLD = 3

/** 受阻史上限：只保留最近几次，deny 文案全量列出供主 Agent 与用户核对 */
const CONSULT_STOPS_KEEP = 5

interface StateKeeperStore {
  /** 活跃状态文件路径（null=无活跃状态任务=门控不激活） */
  statePath: string | null
  /** 状态任务所属会话（门控只拦同会话的写，其他会话不受影响） */
  conversationId: number | null
  /** 最近一次回执；consumed=proceed 令牌已被一笔写消费 */
  receipt: (StateReceipt & { consumed: boolean }) | null
  /**
   * 当前状态任务的对账受阻史（hold/对账失败，新→旧最多 KEEP 条）：
   * 门控 deny 文案据此判断"反复对账"并升级路由到人工。
   * 重置时机：proceed 放行（取得了进展）/新状态任务激活/归档清空——
   * 同路径重复派遣不重置（否则计数永远攒不起来）。
   */
  consultStops: ConsultStop[]
  /** 状态文件最新内容缓存（write_state 落盘时同步；compact 快照的数据源） */
  cachedContent: string | null
  /**
   * 按名挂门控的域写工具清单（domain pack 通用装配点）：
   * 前端本地写工具用 Tool.requiresStateConsult 静态标记；后端目录工具（如 APS 的
   * adjust/publish）没有这个字段，域装配时由 requireConsultFor 按名挂门——
   * 同一步骤 2.6 判定，一处语义两个挂载点。
   */
  consultToolNames: ReadonlySet<string>
  /**
   * 硬门清单（2026-08-09 拍板 S1 分级）：publish 类不可逆写——无活跃状态任务
   * 也拦（fail-closed），deny 引导先建状态护航；consultToolNames 是软门——
   * 只在有活跃状态任务时拦（fail-open），零状态任务的普通对话不受影响。
   */
  hardConsultToolNames: ReadonlySet<string>

  registerReceipt: (statePath: string, conversationId: number | null, receipt: StateReceipt) => void
  /**
   * 对账失败登记（2026-08-10 L4/E2 修复）：state 子 Agent 运行结束但未提交回执
   * （轮次撞顶/运行异常/中断）时由派遣方调用——此前失败=静默无回执，
   * 门控只会说"未对账"，主 Agent 反复派遣反复撞顶成死循环。
   * 登记 error 回执（门控 deny 文案据此区分"没对账"与"对账失败了"）+ 记受阻史。
   */
  registerStateError: (statePath: string, conversationId: number | null, reason: string) => void
  /**
   * 派遣即预登记（后台 state 运行期门控空窗修复）：state 子 Agent 一出发，
   * 状态任务就算活跃——门控立刻进入"有活跃任务但无可用令牌"的拦截态，
   * 主 Agent 不能赶在回执到达前抢先写。旧回执一并作废（新一轮同步后
   * 旧的 proceed 结论可能已过时）。回执到达时 registerReceipt 覆盖。
   */
  activateStatePath: (statePath: string, conversationId: number | null) => void
  updateContent: (statePath: string, content: string) => void
  /** 域装配：把一批后端目录工具名挂上写前门控（hard=true=不可逆写硬门） */
  requireConsultFor: (toolNames: string[], opts?: { hard?: boolean }) => void
  /**
   * 查看是否有可用的 proceed 令牌（不消费，2026-08-09 S3）：
   * 门控判定（步骤 2.6）只看不动；消费推迟到工具真正执行前一刻——
   * 审批被拒/后续步骤拦截时写没有发生，令牌自然还在，无需"归还"。
   * 传 toolName 时同时校验令牌绑定（S2）：放行声明了别的工具即不可用。
   */
  peekProceedToken: (toolName?: string) => boolean
  /** 有一枚未消费且绑定匹配的 proceed 令牌则消费之并返回 true（一次性） */
  consumeProceedToken: (toolName?: string) => boolean
  /** 任务终结/归档时清空（门控失活） */
  clear: () => void
}

export const useStateKeeperStore = create<StateKeeperStore>((set, get) => ({
  statePath: null,
  conversationId: null,
  receipt: null,
  consultStops: [],
  cachedContent: null,
  consultToolNames: new Set<string>(),
  hardConsultToolNames: new Set<string>(),

  registerReceipt: (statePath, conversationId, receipt) =>
    set((s) => ({
      statePath,
      conversationId,
      receipt: { ...receipt, consumed: false },
      // 受阻史记账：hold 记一笔（对账发现阻碍）；proceed=取得进展清零；
      // updated/offtopic 中性不动——里程碑同步不应掩盖"写一直被拦"的事实
      consultStops:
        receipt.verdict === 'hold'
          ? [{ kind: 'hold' as const, summary: receipt.summary, concerns: receipt.concerns, at: receipt.at }, ...s.consultStops].slice(0, CONSULT_STOPS_KEEP)
          : receipt.verdict === 'proceed'
            ? []
            : s.consultStops,
    })),

  registerStateError: (statePath, conversationId, reason) =>
    set((s) => ({
      statePath,
      conversationId,
      receipt: { verdict: 'error', summary: reason, concerns: [], consumed: false, at: Date.now() },
      consultStops: [{ kind: 'error' as const, summary: reason, concerns: [], at: Date.now() }, ...s.consultStops].slice(0, CONSULT_STOPS_KEEP),
    })),

  activateStatePath: (statePath, conversationId) =>
    set((s) => ({
      statePath,
      conversationId,
      receipt: null,
      // 换状态文件=新任务，受阻史重来；同路径重复派遣保留（计数要能攒起来）
      consultStops: s.statePath === statePath ? s.consultStops : [],
    })),

  updateContent: (statePath, content) => {
    // 守卫两种可写：①当前无活跃状态任务（state agent 首次同步——回执登记先于
    // 内容缓存发生，此刻 statePath 还是 null，不收就永远进不了 compact 快照）；
    // ②路径匹配当前活跃状态文件。其余（接力旧文件的旁路写）不写缓存。
    const cur = get().statePath
    if (cur === null || cur === statePath) set({ cachedContent: content })
  },

  // 绑定缺省=不绑定（向后兼容未声明 action_tool 的回执）
  peekProceedToken: (toolName) => {
    const { receipt } = get()
    if (receipt?.verdict !== 'proceed' || receipt.consumed) return false
    if (receipt.actionTool && toolName && receipt.actionTool !== toolName) return false
    return true
  },

  consumeProceedToken: (toolName) => {
    if (!get().peekProceedToken(toolName)) return false
    const { receipt } = get()
    set({ receipt: { ...receipt!, consumed: true } })
    return true
  },

  requireConsultFor: (toolNames, opts) => {
    const key = opts?.hard ? 'hardConsultToolNames' : 'consultToolNames'
    const next = new Set(get()[key])
    for (const name of toolNames) next.add(name)
    set({ [key]: next } as Partial<StateKeeperStore>)
  },

  clear: () => set({ statePath: null, conversationId: null, receipt: null, consultStops: [], cachedContent: null }),
}))

import type { StateSchema } from '@/agent/structuredOutput'
import { getDomainPack, listDomainPackNames } from '@/agent/domainPacks'
import { useStateKeeperStore, type StateReceipt } from '@/stores/stateKeeperStore'

/**
 * helper 契约注册表（2026-08-13 子代理/helper 结构性打磨：helper 契约注册表 + state 特例回落）。
 *
 * 立意（计划文件 sunny-watching-pixel.md）：
 * state 角色原本以硬编码特例的形态长在派遣工具（agentTool.ts）里——每加一种认知角色，
 * 都要先读懂 agentTool 的全部细节、重新发明一次接法（schema 塞哪、联动挂哪、说明写哪）。
 * 认知角色是系统里最值钱的资产（对账护航/失败诊断/结果解释），但特例形态让它们无法作为
 * 资产沉淀、版本化、评测。helper 契约注册表把认知角色变成**声明式资产**：一张表说清系统里
 * 有哪些有界认知函数、每个函数的输入自足要求、输出契约、工具面边界、副作用联动。
 * 形态完全对齐已验证的 domainPacks 模式（注册表=单一事实源 + version 纪律 + 模块加载即生效）
 * ——domainPacks 沉淀"知识"，helperContracts 沉淀"认知职责"，两者共同构成系统的域能力目录。
 *
 * 契约即边界（agent proposes, deterministic disposes 的落地）：helper 契约在派遣之前声明
 * 这个认知函数能用哪些工具（toolScope）、必须交付什么形状的结果（outputSchema）、
 * 会触发哪些确定性联动（onDispatch/onOutcome）。主 agent 不需要理解 helper 的内部，
 * 只需要理解它的契约——这把"上下文隔离"从技巧升级为制度。
 *
 * 注册表是收敛机制不是扩张机制：字段就这些，新 helper 不许发明新接法，特例渗透的熵增
 * 被结构本身挡住。version 纪律让认知契约的演化可追溯、可回滚。
 *
 * 不做什么（立意的一部分）：
 * - 不做自动路由——选哪个 helper 是主 agent 的认知职责，框架不越俎代庖；
 * - 不做 helper 编排框架/DAG——确定性依赖才配进 DAG，认知任务不进；
 * - inject 型（知识注入）不进注册表——知识注入与认知隔离是两种机制，混进一个抽象会互相
 *   污染，skill 通道与 domainPack 已覆盖前者。
 *
 * 写作纪律：
 * - state 契约的每一段内容从 agentTool.ts **逐字搬迁**（schema/描述/failFast 文案/联动逻辑），
 *   只搬不改字——行为零变化是本次重构的铁律，改动必须自检计划文件「验收」13 条；
 * - 改契约视同改 prompt：version 必须 bump（与 domainPacks 同纪律）；
 * - 契约只承载"认知职责的形状"，状态怎么组织是 state agent 的认知职责（其 prompt 承担），
 *   代码不硬编码状态结构。
 */

/** 已注册的 helper 名单（agentTool 侧 SubAgentType = 'general' | 'explore' | HelperName 自动跟上） */
export const HELPER_CONTRACT_NAMES = ['state'] as const

/** helper 类型名（新 helper=名单加一名+注册表加一项，类型联合与工具 enum 自动跟上） */
export type HelperName = (typeof HELPER_CONTRACT_NAMES)[number]

/** helper 契约关心的入参投影（agentTool 把完整输入传给 validateInput，结构兼容） */
export interface HelperContractInput {
  state_path?: string
  domain_pack?: string
  structured_output_schema?: Record<string, unknown>
}

/** 后台派遣联动上下文（契约 onDispatch）：时序=launchBackgroundSubAgent 之后立即调用 */
export interface HelperDispatchContext {
  /** 状态文件路径（已 trim） */
  statePath: string
  conversationId: number | null | undefined
}

/** 完成联动上下文（契约 onOutcome）：同步/后台两条完成路径都调用 */
export interface HelperOutcomeContext {
  statePath?: string
  conversationId: number | null | undefined
  out: {
    structuredOutput?: { submitted: boolean; value?: unknown }
    status?: string
    error?: string
  }
}

export interface HelperContract {
  name: string
  /** 内容版本：改契约必须 bump（与 domainPacks 同纪律） */
  version: string
  /** TYPE_GUIDE 段落正文（业务语言；agentTool 拼装成 "- {name}：{description}"） */
  description: string
  /** 工具面主开关：readonly=结构性只读面（驱动 generalAgentRun 只读主开关） */
  toolScope: 'general' | 'readonly'
  /** 装配 stateKeeper 参数 + write_state 写钥匙 + 提示走 stateKeeper 分支 */
  stateKeeper?: boolean
  /** 结构化回执契约（state=现 STATE_RECEIPT_SCHEMA 原样迁入） */
  outputSchema?: StateSchema
  /** 轮数上限（state=12，常量从 generalAgentRun 迁出） */
  maxTurns?: number
  /** 默认运行方式：false=同步（对账需当场拿结论）；缺省=后台 */
  runInBackgroundDefault?: boolean
  /** runId 前缀（state='state'，拼成 "state-{ts}-{rand}"） */
  runIdPrefix?: string
  /** 专属输入字段（注册进 agent 工具 inputSchema 的 properties；state=state_path/domain_pack 两字段，描述逐字搬入） */
  inputFields?: Record<string, { type: string; description: string }>
  /** 派遣前参数校验：返回 failFast 文案（null=通过） */
  validateInput?: (input: HelperContractInput) => string | null
  /** 后台派遣联动（launch 后立即调用；state=activateStatePath 空窗预登记） */
  onDispatch?: (ctx: HelperDispatchContext) => void
  /** 完成联动（同步/后台完成路径都调用；state=registerStateOutcome） */
  onOutcome?: (ctx: HelperOutcomeContext) => void
}

/**
 * 状态维护角色的认知回执契约（内置，非域硬编码）：
 * 回执是协作协议（主 Agent 程序化读 verdict/concerns），不是状态本身——
 * 状态怎么组织是状态 agent 的认知职责（其 prompt 承担），这里只钉协议三格。
 */
const STATE_RECEIPT_SCHEMA: StateSchema = {
  type: 'object',
  required: ['verdict', 'summary', 'concerns'],
  additionalProperties: false,
  properties: {
    verdict: {
      type: 'string',
      enum: ['updated', 'proceed', 'hold', 'offtopic', 'archive'],
      description:
        'updated=状态已更新（里程碑同步）；proceed=对账通过，可以动手；hold=对账发现阻碍，先别动（concerns 列清原因）；' +
        'offtopic=本次同步与状态文件明显无关（未写入），应另建状态文件——summary 里会给出建议路径；' +
        'archive=任务彻底收尾，状态已归档（文件第一行改写"已归档"+最后一次压缩），此后不再维护、写前门控解除。',
    },
    summary: {
      type: 'string',
      description: '一句话说明处理对象与结论；对账时要能辨认获准/阻断的是哪笔动作、哪个对象和范围。',
    },
    action_tool: {
      type: 'string',
      description:
        '仅 verdict=proceed 时必填：本次放行覆盖的工具名（如 iris_aps_adjust_result）。' +
        '令牌与工具绑定——主 Agent 拿这回执去执行别的工具会被拦下；填对账写清的那笔动作对应的工具。',
    },
    suggest_archive: {
      type: 'boolean',
      description:
        '可选：判定目标判据全部达成、任务实质收尾时置 true（summary 里说明判据达成情况）。' +
        '只是给主 Agent 的建议信号——它会向用户确认后再派【归档】；真正解除门控仍靠 archive 回执。',
    },
    concerns: {
      type: 'array',
      items: { type: 'string' },
      description:
        '认知提示。hold 时逐项写清阻碍、后果和最短解除路径；proceed/updated 时只写不阻断当前动作的残余风险、偏差或更优可能；没有就空数组。',
    },
  },
}

const HELPER_CONTRACTS: Record<string, HelperContract> = {
  // state：状态维护角色 v1（2026-08-13 从 agentTool.ts 特例逐字回落，行为零变化）。
  // v1=原样搬迁：回执 schema / TYPE_GUIDE 段落 / failFast 文案 / 门控联动 / 回执登记。
  // v1.1=1280 复盘（2026-08-14）：补「是否全新一次」的接力判断——任务对象换了
  // （新计划号/新订单/新主题）必须另建新状态文件，不沿用旧路径；旧文件的
  // 「可复用经验」区只当待验证假设读，不当事实依据（实测：旧文件经验区混入
  // 未验证假设，污染了下一个对话的发布判断——发布闸正确拦截才没出事）。
  state: {
    name: 'state',
    version: '1.1.0',
    description: `状态维护子 Agent。长任务/有代价写决策的过程护航：它维护目标、事实、假设、决策、下一动作与实际后果之间的因果闭环，发现目标漂移、关键盲区和执行偏差。用法：整段任务指定同一个 state_path（如 /workspace/state/0813-排产-plan1278.txt——日期+主题+任务对象）；开场先 list_files /workspace/state/ 看有没有相关在途状态可接力（文件第一行标注活跃/已归档），没有再新建。接力前先判这是不是同一段任务：任务对象换了（新计划号/新订单/新主题）就是全新的一次——另建新文件，不要沿用旧路径；旧文件可以读，但其中「可复用经验」区可能混着未经结果验证的判断，只当待验证的假设参考，不当事实依据。里程碑时以【里程碑】开头，写清新观测、已完成动作及实际结果；写操作前以【对账】开头，写清动作类型、目标对象/版本、修改范围、关键参数、用户授权原话或业务依据、预期状态变化、写后验证与失败去向。它只看得见状态文件和你发给它的内容，转述要如实；它的认知提示（concerns）要认真对待，但 proceed 时的非阻断提醒不等于停止执行。proceed 放行是一次性的且与对账写清的那个工具绑定——拿它执行别的工具或第二笔写都会被拦，需重新对账。它若返回 offtopic 回执=本次内容与该状态无关（未写入），为新主题另换 state_path 重新派遣。任务彻底收尾时以【归档】开头派它做最终整理（archive 回执后写前门控解除）；它判定目标已全部达成时也会在回执里建议归档（suggest_archive），收到后向用户确认再派【归档】。对账反复受阻时不要闷头重试或反复派遣——向用户说清任务进行到哪一步、卡点是什么、你尝试过什么，请用户定夺后再行动。若任务属于已配备域知识的领域（如 APS 排产），传 domain_pack 让它带上开发阶段蒸馏好的域判断依据。默认同步运行（对账需当场拿结论）。`,
    toolScope: 'readonly',
    stateKeeper: true,
    outputSchema: STATE_RECEIPT_SCHEMA,
    maxTurns: 12,
    runInBackgroundDefault: false,
    runIdPrefix: 'state',
    inputFields: {
      state_path: {
        type: 'string',
        description:
          '状态文件路径（仅 subagent_type=state，必填）：如 /workspace/state/0813-排产-plan1278.txt。命名=日期+主题+任务对象（计划号/订单号不可少）——日期在前方便排序翻阅，对象在内避免同一天的同类任务互相串台；整段任务全程用同一个路径——状态文件的连续性就是状态 Agent 的记忆。',
      },
      domain_pack: {
        type: 'string',
        description:
          '域知识包名（仅 subagent_type=state，可选）：任务属于已配备域知识的领域时传入（如 aps=APS 硫化排产），开发阶段蒸馏好的域判断依据（引擎脾气/写安全判据/数据口径/场景推理链）会随它的系统提示注入，对账质量显著提升。',
      },
    },
    // 派遣前参数校验（failFast 文案逐字搬自 agentTool.ts）：state_path 必填 /
    // 与 structured_output_schema 互斥（内置认知回执契约，重复声明只会混淆）/ domain_pack 存在性列出可用名
    validateInput: (input) => {
      if (!input.state_path?.trim()) {
        return (
          '缺少 state_path：状态维护子 Agent 必须指定状态文件路径（如 /workspace/state/0813-排产-plan1278.txt，日期+主题+任务对象），' +
          '整段任务全程用同一个路径。请补上后重新派遣。'
        )
      }
      if (input.structured_output_schema) {
        return '参数冲突：state 类型内置认知回执契约，不要再传 structured_output_schema。'
      }
      if (input.domain_pack && !getDomainPack(input.domain_pack)) {
        const names = listDomainPackNames()
        return (
          `domain_pack='${input.domain_pack}' 不存在` +
          (names.length > 0 ? `（当前可用：${names.join('、')}）` : '（当前尚无已配备的域知识包）') +
          '。请修正后重新派遣。'
        )
      }
      return null
    },
    // 后台派遣时序（审计 F 空窗修复）：launch 之后立即预登记活跃状态路径——
    // 回执到达前门控已进入"有活跃任务但无可用令牌"的拦截态，主 Agent 不能赶在
    // 对账结论回来前抢先写；旧令牌同时作废（新一轮同步后可能过时）。
    onDispatch: ({ statePath, conversationId }) => {
      useStateKeeperStore.getState().activateStatePath(statePath, conversationId ?? null)
    },
    // 完成联动（同步/后台两条完成路径都调用；registerStateOutcome 原样回落）：
    // 提交了回执→正常登记（蛇形→驼峰映射；archive 且路径匹配才 clear 解门；hold 记受阻史、
    // proceed 清零由 store.registerReceipt 内部处理）；
    // 运行结束但没提交回执（轮次撞顶/异常/中断）→登记 error 回执+受阻史——
    // 此前这种失败是静默的，门控只会说"未对账"，主 Agent 不知道是对账本身失败了，
    // 会反复派遣反复撞顶（对账失败死循环）。error 回执让门控 deny 文案能区分
    // "还没对账"与"对账失败了"，并把失败计入收敛计数（连续受阻升级路由到人工）。
    onOutcome: ({ statePath, conversationId, out }) => {
      if (out.structuredOutput?.submitted && statePath?.trim()) {
        const raw = out.structuredOutput.value as Omit<StateReceipt, 'at'> & {
          action_tool?: string
          suggest_archive?: boolean
        }
        // schema 蛇形字段（模型按契约填 action_tool / suggest_archive）→ store 驼峰
        const value: Omit<StateReceipt, 'at'> = {
          verdict: raw.verdict,
          summary: raw.summary,
          concerns: raw.concerns,
          ...(raw.action_tool ? { actionTool: raw.action_tool } : {}),
          ...(raw.suggest_archive ? { suggestArchive: true } : {}),
        }
        const store = useStateKeeperStore.getState()
        // archive=任务终结：解除门控（仅当归档的正是当前活跃状态文件——
        // 旁路归档旧文件不误伤在途任务）。状态文件本身留在磁盘可追溯。
        if (value.verdict === 'archive') {
          if (store.statePath === statePath.trim()) store.clear()
        } else {
          store.registerReceipt(statePath.trim(), conversationId ?? null, { ...value, at: Date.now() })
        }
        return
      }
      if (statePath?.trim()) {
        const reason = out.error?.trim()
          ? `对账子 Agent 运行失败：${out.error.trim()}`
          : '对账子 Agent 未提交回执（可能轮次预算耗尽或任务表述不清）'
        useStateKeeperStore.getState().registerStateError(statePath.trim(), conversationId ?? null, reason)
      }
    },
  },
}

/** 按名取 helper 契约；未知名返回 undefined（调用方据此回退 general） */
export function getHelperContract(name: string): HelperContract | undefined {
  return HELPER_CONTRACTS[name]
}

export function listHelperContractNames(): string[] {
  return Object.keys(HELPER_CONTRACTS)
}

/** TYPE_GUIDE 的 helper 段落（agentTool 拼装时展开；state=逐字原段落，段落顺序按名单声明） */
export function buildHelperTypeGuideSections(): string {
  return HELPER_CONTRACT_NAMES.map((name) => `- ${name}：${HELPER_CONTRACTS[name].description}`).join('\n')
}

/**
 * 注册表装配（对齐 domainPacks.registerDomainPackGates：模块加载即生效，幂等）。
 * 当前所有契约都是静态常量，装配只做不变量自检（名单与注册表一一对应，防改名漏改）；
 * 将来做动态注册时在此扩展。
 */
export function registerHelperContracts(): void {
  const declared = HELPER_CONTRACT_NAMES as readonly string[]
  for (const name of declared) {
    if (!HELPER_CONTRACTS[name]) {
      console.warn(`[helperContracts] 名单声明 ${name} 但注册表无此契约`)
    }
  }
  for (const name of Object.keys(HELPER_CONTRACTS)) {
    if (!declared.includes(name)) {
      console.warn(`[helperContracts] 注册表含未声明契约名 ${name}`)
    }
  }
}

registerHelperContracts()

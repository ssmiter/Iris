import type { Tool, ToolExecutionContext } from '@/agent/types'
import { launchBackgroundSubAgent } from '@/agent/subAgentManager'
import { launchTaskSession } from '@/agent/taskSession'
import {
  makeExploreRunId,
  runExploreAgentSession,
  type ExploreAgentInput,
} from './exploreAgentRun'
import {
  makeGeneralRunId,
  runGeneralAgentSession,
  type GeneralAgentDeps,
} from './generalAgentRun'
import type { StateSchema } from '@/agent/structuredOutput'
import { validateSchemaSpec } from '@/agent/structuredOutput'
import { getDomainPack, registerDomainPackGates } from '@/agent/domainPacks'
import {
  getHelperContract,
  listHelperContractNames,
  buildHelperTypeGuideSections,
  type HelperName,
} from '@/agent/helperContracts'

// 域门控装配（2026-08-09 S1/S6）：各 domain pack 声明的 consult 清单挂进门控——
// 本模块随 agent 工具（alwaysLoad）装载即生效，幂等。
registerDomainPackGates()

/**
 * agent：统一子 Agent 派遣工具（2026-08-01 多 Agent 第二步，claude-code AgentTool 形态）。
 *
 * 收编原 explore_agent：subagent_type 选类型，与 claude-code 的 AgentTool
 * （description/prompt/subagent_type/run_in_background）同构：
 * - explore=只读探索子 Agent（调研/检索/排查，结构性只读）；
 * - general=通用子 Agent（权限与主 Agent 相同：读写文件、业务工具、SQL；
 *   需审批的写操作冒泡主对话审批卡——审批桥 D1）；
 * - helper=注册表驱动的认知角色（2026-08-13 helper 契约注册表，见 helperContracts.ts）：
 *   state 特例已全部回落为一项声明式契约（回执 schema/校验/联动/门控/TYPE_GUIDE 段落），
 *   新增认知角色只需注册表加一项+名单加一名，本工具的类型联合与 enum 自动跟上——
 *   认知角色从"派遣工具里的特例"变成"目录里的一项能力"；
 * - 自动调用=纯描述驱动（claude-code prompt.ts:270 同款："types 清单+主动委派指引"）；
 * - 默认后台运行（对齐 claude-code 默认后台）：回执立即返回，完成经通知通道回报；
 * - 并行读写一致性（D2 P1）：描述里引导并行派遣时给各子 Agent 指定不相交的产出路径，
 *   触碰面记录与冲突提示由运行体承担（generalAgentRun）。
 *
 * 深度守卫（D3）：本工具不注册进任何子注册表，子 Agent 拿不到派遣工具无法再派生
 * （claude-code 同款工具面裁剪）。
 *
 * 本模块只负责分派；运行体在 exploreAgentRun.ts / generalAgentRun.ts，
 * 后台生命周期在 subAgentManager.ts。
 */

export const AGENT_TOOL_NAME = 'agent'

export type SubAgentType = 'general' | 'explore' | HelperName

export interface AgentToolInput {
  /** 自足的任务描述：背景、目标、约束、期望的产出（产出文件路径要写清） */
  task: string
  /** 3-5 词的短描述（运行中展示用，如"排查排产异常"） */
  description?: string
  /** 子 Agent 类型（默认 general） */
  subagent_type?: SubAgentType
  /** 彻底程度，仅 explore 类型有效 */
  thoroughness?: 'quick' | 'medium' | 'thorough'
  /** 默认 true=后台运行（state 类型默认 false=同步，对账需当场拿结论） */
  run_in_background?: boolean
  /** 任务会话形态（仅 general）：true=在独立的任务会话中执行（长程编码/多步骤任务，用户可随时进入看过程） */
  as_task?: boolean
  /** 续跑（仅 general）：已结束任务会话的 id——追问/修改/继续执行时传入，历史自动接续，不要重新派遣 */
  resume_task?: number
  /** 结构化状态契约（仅 general）：JSON Schema，子 Agent 最终必须提交符合它的状态对象 */
  structured_output_schema?: Record<string, unknown>
  /** 状态文件路径（仅 state 类型，必填）：如 /workspace/state/0813-排产-plan1278.txt（日期+主题+任务对象），整段任务用同一个路径 */
  state_path?: string
  /** 域知识包名（仅 state 类型，可选）：如 'aps'——开发阶段蒸馏好的域判断依据随系统提示注入 */
  domain_pack?: string
}

export interface AgentToolOutput {
  content: string
  runId: string
  reportPath?: string
  persistedUrl?: string
  /** true=后台派遣回执（报告随后经通知到达）；缺省/false=同步报告即结果 */
  async?: boolean
  /** 任务会话 id（as_task=true 派遣成功时存在）：任务卡渲染与入口定位用 */
  taskConversationId?: number
  stats: {
    toolCalls: number
    discoveredTools: number
    durationMs: number
    thoroughness?: string
  }
}

export type AgentToolDeps = GeneralAgentDeps

// TYPE_GUIDE：general/explore 段落硬编码（原样）；helper 段落由注册表生成——
// state 段落正文逐字在 helperContracts.ts 的 state 契约 description 里
const TYPE_GUIDE = `
可用子 Agent 类型：
- general（默认）：通用子 Agent，权限与你相同——可以读写文件、调用业务工具、执行 SQL。需要系统性分析并产出具体文件、多步骤执行、或需要从不同角度并行推进的任务委派给它。它的写操作如需审批会冒泡请用户批准。
- explore：只读探索子 Agent。大范围、可并行的读/检索/调研委派给它：跨多个目录或业务对象的排查、需要大量阅读但结论简短的调研、会淹没主对话上下文的链状追溯。它不能写，任何写操作不要派给它。
${buildHelperTypeGuideSections()}`.trim()

export function createAgentTool(deps: AgentToolDeps): Tool<AgentToolInput, AgentToolOutput> {
  // 各 helper 声明的专属输入字段（state=state_path/domain_pack 两字段）并入工具 schema——
  // 新增 helper 只需在契约里声明 inputFields，这里自动带上
  const helperInputFields = Object.assign(
    {},
    ...listHelperContractNames().map((name) => getHelperContract(name)?.inputFields ?? {})
  )
  return {
    name: AGENT_TOOL_NAME,
    description:
      '派遣一个子 Agent 在独立上下文中自主完成一个子任务（它看不到本对话历史，任务描述必须自足：背景、目标、约束、期望产出）。\n' +
      TYPE_GUIDE +
      '\n当任务明显适合委派时应主动使用本工具，不要自己硬扛长链工作；**长程编码/多步骤执行任务默认开任务会话（as_task: true）交给 general 子 Agent 整段执行，不要自己在主对话里逐段硬扛**；同一轮可派遣多个子 Agent 并行处理互不相同的子问题——' +
      '并行派遣时给每个子 Agent 指定不相交的产出路径（如各自的 /workspace/outputs/{主题}/ 目录），避免写同一文件。' +
      '不适用：预计 1-2 次检索或一两次操作就能完成的简单事（自己直接做更快）；依赖本对话历史才能描述清楚的任务。' +
      '默认后台运行：调用立即返回 runId，它完成/出错/被取消时你会自动收到通知（含完整报告、产出/修改文件清单与统计），' +
      '通知到达前不要轮询进度、不要重复派遣相同或高度重叠的任务，继续正常对话即可；' +
      '确需当场拿到报告再行动时显式传 run_in_background: false。' +
      '终止子 Agent 用 cancel_subagent（runId）；向运行中的子 Agent 补充信息用 message_subagent。' +
      '任务会话的权限与主对话完全一致：需要审批的操作照常弹给用户（你在后台继续跑，审批卡冒泡到主对话），用户已批准的规则两边共用不重复询问；用户暂不在场时审批超时自动视为拒绝——跳过该项继续其余工作，并在报告中如实列出未执行项。' +
      '对已派任务的追问、修改或继续执行：用 resume_task 续跑（历史自动接续），不要重新派遣——从零开始会丢失该任务已有的结论与过程。' +
      '改动面大或方案拿不准时，在任务描述里约定"先只探索并把实施计划写进任务会话（或 /workspace/ 下计划文件），等用户反馈后再动手"即可——' +
      '用户能随时进入任务会话看到计划并直接补充纠正，无需专门的批准环节。' +
      '报告是给你的原料：综合提炼后再作答，不要整段转贴；落盘路径仅供追溯，不要例行复读落盘文件。',
    inputSchema: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description:
            '自足的任务描述（子 Agent 看不到对话历史）：背景、目标、约束、期望产出；需要产出文件时写清期望的文件路径。',
        },
        description: {
          type: 'string',
          description: '3-5 词的短描述，运行中展示用（如"排查排产异常"）。',
        },
        subagent_type: {
          type: 'string',
          enum: ['general', 'explore', ...listHelperContractNames()],
          description:
            '子 Agent 类型（默认 general）：general=权限与你相同的执行者（可写）；explore=只读调研员；state=状态维护者（过程护航：里程碑同步+写前对账，需配 state_path）。',
          default: 'general',
        },
        thoroughness: {
          type: 'string',
          enum: ['quick', 'medium', 'thorough'],
          description:
            '彻底程度，仅 subagent_type=explore 有效（轮数上限随档升高）：单点定位用 quick；多数调研用 medium（默认）；跨环节链状排查用 thorough。',
          default: 'medium',
        },
        run_in_background: {
          type: 'boolean',
          description:
            '是否后台运行（general/explore 默认 true；state 默认 false=同步——对账需当场拿结论）：后台=立即返回 runId，完成自动通知；false=同步等待，报告直接作为工具结果返回。',
          default: true,
        },
        as_task: {
          type: 'boolean',
          description:
            'true=任务在独立任务会话执行：过程可进入可回顾、用户可随时进入补充，完成时结果自动回本对话；长程编码/多步骤任务默认开，普通子任务用默认后台派遣即可。',
        },
        resume_task: {
          type: 'number',
          description:
            '续跑已结束的任务会话：传任务会话 id（派遣回执/完成通知里的"任务会话: #id"）。与 as_task 互斥；运行中的任务会话不能续跑（用 message_subagent 补充）。',
        },
        structured_output_schema: {
          type: 'object',
          description:
            '结构化状态契约（仅 subagent_type=general）：一个 JSON Schema 对象。提供后子 Agent 最终必须提交符合该 schema 的状态对象（schema 校验，不通过会被打回修正），提交的状态随报告返回。需要子 Agent 交付可供后续步骤/其他子 Agent 消费的结构化状态时使用；普通任务不要传。',
        },
        ...helperInputFields,
      },
    },
    // 统一工具可能是 general（会写）：不能标 read_only。
    // 真正的风险在子 Agent 内部逐次工具调用上判定+审批桥把关，派遣本身不直接产生副作用。
    riskLevel: 'standard',
    isReadOnly: false,
    isConcurrencySafe: true,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 30000,
    // 长程工具（仅同步路径相关）：15min 覆盖最坏档 + 信号量排队预算；
    // 后台路径回执秒回不触此限，由 manager 的 guard 超时承担
    timeoutMs: 15 * 60 * 1000,

    execute: async (input: AgentToolInput, ctx: ToolExecutionContext): Promise<AgentToolOutput> => {
      // 类型解析：general/explore 走原分支；helper 名单内（state）契约驱动；
      // 未知名/缺省一律回退 general（与重构前逐字一致）
      const type: SubAgentType =
        input.subagent_type === 'explore'
          ? 'explore'
          : input.subagent_type === 'general'
            ? 'general'
            : input.subagent_type && getHelperContract(input.subagent_type)
              ? input.subagent_type
              : 'general'
      const helper = getHelperContract(type)
      const runId =
        type === 'explore'
          ? makeExploreRunId()
          : helper?.runIdPrefix
            ? `${helper.runIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
            : makeGeneralRunId()
      const label = input.description?.trim() || input.task.slice(0, 30)
      const failFast = (content: string): AgentToolOutput => ({
        content,
        runId,
        stats: { toolCalls: 0, discoveredTools: 0, durationMs: 0 },
      })

      // 任务会话形态只挂 general：explore 是只读调研（报告即交付物，不需要承载空间），
      // helper 是认知角色（同步对账）；且任务会话运行体=通用子 Agent
      if (input.as_task && type !== 'general') {
        return failFast('参数冲突：as_task 只对 subagent_type=general 有效。')
      }
      // 续跑只挂任务会话轨（与 as_task 互斥：续跑本身就在任务会话中进行）
      if (input.resume_task != null && input.as_task) {
        return failFast('参数冲突：resume_task 与 as_task 不同时使用（续跑本身就在任务会话中进行）。')
      }
      if (input.resume_task != null && type !== 'general') {
        return failFast('参数冲突：resume_task 只对 subagent_type=general 有效。')
      }
      // domain_pack 只挂声明了 domain_pack 入参的 helper（当前只有 state）：
      // 非此类类型传了直接拒（general/explore 无契约可挂，未知名不进 loop 空烧轮次）
      if (input.domain_pack && !helper?.inputFields?.domain_pack) {
        return failFast('参数冲突：domain_pack 只对 subagent_type=state 有效。')
      }
      // 契约驱动参数校验（state=state_path 必填/与 structured_output_schema 互斥/domain_pack 存在性列出可用名；
      // failFast 文案逐字在契约 validateInput 里）
      const contractError = helper?.validateInput?.(input)
      if (contractError) {
        return failFast(contractError)
      }
      // 结构化状态契约只挂 general（explore 是只读调研员，不交付状态对象）
      if (input.structured_output_schema && type !== 'general') {
        return failFast(
          '参数冲突：structured_output_schema 只对 subagent_type=general 有效。' +
          'explore 是只读调研员，不交付结构化状态——改用 general 或去掉该参数。'
        )
      }
      // 创建期 schema 本体自检（claude-code ajv.validateSchema 同款）：
      // 废 schema 在派遣前拒掉，不进 loop 空烧轮次
      if (input.structured_output_schema) {
        const specError = validateSchemaSpec(input.structured_output_schema)
        if (specError) {
          return failFast(`structured_output_schema 不合法：${specError}。修正后重新派遣。`)
        }
      }
      const structuredOutput = helper?.outputSchema
        ? { schema: helper.outputSchema as StateSchema }
        : input.structured_output_schema
          ? { schema: input.structured_output_schema as StateSchema }
          : undefined
      // 唯一完成判据追加到任务正文末尾（3 号模型实验：系统提示中部的锚点会被长任务淹没，
      // 正文末尾权重最高）；manager 登记与通知仍用原始 task，不向用户暴露工具名
      const runnerTask = structuredOutput
        ? `${input.task}\n\n本任务以 submit_state 校验通过为唯一完成标志；文本总结不能替代提交。`
        : input.task
      // 默认运行方式：state 契约 runInBackgroundDefault=false=同步（对账需当场拿结论）；
      // general/explore 缺省后台
      const runInBackground =
        helper?.runInBackgroundDefault === false
          ? input.run_in_background === true
          : input.run_in_background !== false
      // stateKeeper 组装（契约 stateKeeper=true）：装配参数 + domainPack 内容
      const stateKeeper = helper?.stateKeeper
        ? {
            statePath: input.state_path!.trim(),
            ...(input.domain_pack ? { domainPack: getDomainPack(input.domain_pack) } : {}),
          }
        : undefined
      // 运行体 helper 参数（第 3 期泛化）：只读面主开关 + 状态维护参数 + 轮数上限
      const generalHelper = helper
        ? {
            readOnly: helper.toolScope === 'readonly',
            ...(stateKeeper ? { stateKeeper } : {}),
            ...(helper.maxTurns != null ? { maxTurns: helper.maxTurns } : {}),
          }
        : undefined

      if (input.as_task || input.resume_task != null) {
        // 任务会话派遣/续跑（2026-09-01 二阶段切片1；2026-09-02 §16.7 追问即续跑）：
        // 承载形态编排全在 taskSession.ts——新建=建落库会话（ParentConversationId 归属+
        // TaskState 状态机）；续跑=历史注入 loop 前缀续进同一会话。完成时结果落库 +
        // TaskState 回写 + 通知回传父会话。刻意不传 ctx.abortSignal（同普通后台派遣）。
        const launched = await launchTaskSession({
          task: runnerTask,
          label,
          runId,
          parentConversationId: deps.conversationId,
          parentToolCallId: ctx.toolCallId,
          structuredOutput,
          resumeTaskConversationId: input.resume_task ?? undefined,
          deps,
        })
        if (launched.taskConversationId == null) {
          // 承载形态是本体：会话建不出来/校验不过不空烧——拒派并给替代路径
          if (launched.error === 'running') {
            return failFast(`任务会话 #${input.resume_task} 正在运行中：补充信息用 message_subagent（runId 见此前的派遣回执/通知），等它完成后再续跑。`)
          }
          if (launched.error === 'not-task-session') {
            return failFast(`resume_task=${input.resume_task} 不是已存在的任务会话：任务会话 id 见派遣回执/完成通知里的"任务会话: #id"，新建任务改用 as_task。`)
          }
          if (launched.error === 'history-failed') {
            return failFast(`任务会话 #${input.resume_task} 历史读取失败或为空，未续跑。可稍后重试，或改用 as_task 新建任务会话。`)
          }
          return failFast('任务会话创建失败（历史存储不可用），未派遣。可改为普通后台派遣（去掉 as_task）或稍后重试。')
        }
        const isResume = input.resume_task != null
        return {
          content:
            (isResume
              ? `已在任务会话续跑（${label}），通用子 Agent 带着该会话历史继续执行。\nrunId: ${runId}\n任务会话: #${launched.taskConversationId}\n`
              : `已开任务会话（${label}），通用子 Agent 在其中后台执行。\nrunId: ${runId}\n任务会话: #${launched.taskConversationId}\n`) +
            '用户可随时打开任务会话查看过程或直接补充；它完成、出错或被取消时你会自动收到通知，届时综合汇报。\n' +
            '等待期间不要轮询进度、不要重复派遣相同或高度重叠的任务。\n' +
            `若用户要求终止，使用 cancel_subagent 工具（runId: ${runId}）；任务会话里用户可直接发消息补充。`,
          runId,
          async: true,
          taskConversationId: launched.taskConversationId,
          stats: { toolCalls: 0, discoveredTools: 0, durationMs: 0 },
        }
      }

      if (runInBackground) {
        // 后台派遣：注册表登记 + fire-and-forget，回执立即返回。
        // 刻意不传 ctx.abortSignal——后台运行应存活过主 loop 停止/本轮结束
        // （claude-code：background agents should survive when the user presses ESC）。
        launchBackgroundSubAgent({
          runId,
          kind: type,
          conversationId: deps.conversationId,
          task: input.task,
          run: (signal, onLoopHandle) =>
            type === 'explore'
              ? runExploreAgentSession(
                  { task: input.task, thoroughness: input.thoroughness, run_in_background: true } satisfies ExploreAgentInput,
                  deps,
                  signal,
                  { parentToolCallId: ctx.toolCallId, onLoopHandle, runId }
                ).then((out) => ({
                  status: out.status,
                  report: out.content,
                  reportPath: out.reportPath,
                  error: out.error,
                }))
              : runGeneralAgentSession(
                  { task: runnerTask },
                  deps,
                  signal,
                  {
                    parentToolCallId: ctx.toolCallId,
                    onLoopHandle,
                    runId,
                    structuredOutput,
                    helper: generalHelper,
                  }
                ).then((out) => {
                  helper?.onOutcome?.({ statePath: input.state_path, conversationId: deps.conversationId, out })
                  return {
                    status: out.status,
                    report: out.content,
                    reportPath: out.reportPath,
                    error: out.error,
                    touchedFiles: out.touchedFiles,
                    conflictNote: out.conflictNote,
                    structuredOutput: out.structuredOutput,
                  }
                }),
        })
        // 后台 state 运行期门控空窗修复（审计 F）：派遣即预登记活跃状态路径——
        // 回执到达前门控已进入"有活跃任务但无可用令牌"的拦截态，
        // 主 Agent 不能赶在对账结论回来前抢先写；旧令牌同时作废（新一轮同步后可能过时）。
        // 时序由契约 onDispatch 承载：launch 之后立即调用。
        helper?.onDispatch?.({ statePath: input.state_path!.trim(), conversationId: deps.conversationId })
        return {
          content:
            `已派遣${type === 'explore' ? '只读探索' : type === 'state' ? '状态维护' : '通用'}子 Agent 到后台运行（${label}）。\nrunId: ${runId}\n` +
            '它完成、出错或被取消时你会自动收到通知（含完整报告与统计），届时再综合汇报。\n' +
            '等待期间正常继续当前对话或其他工作：不要轮询它的进度，也不要重复派遣相同或高度重叠的任务。\n' +
            `若用户要求终止，使用 cancel_subagent 工具（runId: ${runId}）；若要补充信息，使用 message_subagent。`,
          runId,
          async: true,
          stats: { toolCalls: 0, discoveredTools: 0, durationMs: 0, thoroughness: input.thoroughness ?? 'medium' },
        }
      }

      // 同步路径：父 loop abort 级联，报告即工具结果
      if (type === 'explore') {
        return runExploreAgentSession(
          { task: input.task, thoroughness: input.thoroughness, run_in_background: false },
          deps,
          ctx.abortSignal,
          { onProgress: ctx.onProgress, parentToolCallId: ctx.toolCallId }
        )
      }
      return runGeneralAgentSession({ task: runnerTask }, deps, ctx.abortSignal, {
        onProgress: ctx.onProgress,
        parentToolCallId: ctx.toolCallId,
        structuredOutput,
        helper: generalHelper,
      }).then((out) => {
        helper?.onOutcome?.({ statePath: input.state_path, conversationId: deps.conversationId, out })
        return out
      })
    },
  }
}

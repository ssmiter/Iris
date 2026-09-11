import type { Tool, ToolExecutionContext } from '@/agent/types'
import type { ClarifyOutcome } from '@/agent/clarifyGate'

/**
 * 结构化反问原语（ask_user）—— 对标 claude-code AskUserQuestion。
 *
 * 模型执行中遇到"多种合理解读会导致实质不同产出"的分叉时，暂停并向用户
 * 抛出一张可点击的选项卡（脊柱 clarify attention 卡），答案作为 tool result
 * 返回，模型据此继续。
 *
 * 挂起-恢复链路：本工具 → ctx.clarifyGate.requestClarify（挂起 Promise）
 *   → agenticLoop 把请求渲染成 clarify attention 卡
 *   → 用户点 chip / 内联输入 → chatStore.resolveAttention → loopHandle.resolveAttention
 *   → gate.resolve(toolCallId, value) → 此处的 await 完成。
 *
 * 设计约束（与 claude-code 对齐）：
 * - 单问题扁平 schema（多问题将来加新工具，不改本 schema）；
 * - "其他…"自由输入与"由你决定"逃生口由 UI 统一提供，模型不要自己生成这类选项；
 * - 不做倒计时超时——逃生口 = chips + 其他… + 由你决定 + Stop 按钮（loop abort）。
 */

export const ASK_USER_TOOL_NAME = 'ask_user'

/** "由你决定"逃生口的哨兵值（UI 与工具共用）：用户把决定权交回模型 */
export const ASK_USER_DEFER_VALUE = '由你决定'

/** 推荐项标注后缀（展示用；作答回传时剥掉） */
const RECOMMENDED_SUFFIX = '（推荐）'

interface AskUserInput {
  /** 完整的问题，以问号结尾 */
  question: string
  /** 2-5 个互斥选项，每个尽量简短（≤12 字）；可带 "——一句话说明" 后缀作为选项描述 */
  options: string[]
  /** 推荐项在 options 中的下标（从 0 开始）；有倾向时必填，该项会被挪到首位并标注"（推荐）" */
  recommended?: number
}

interface AskUserOutput {
  answered: boolean
  answer?: string
  note?: string
}

/** 从 "标签——描述" 形式的选项文本中拆出标签与描述（hint） */
function splitOption(opt: string): { label: string; hint?: string } {
  const m = opt.match(/^(.+?)——(.+)$/)
  if (m) return { label: m[1].trim(), hint: m[2].trim() }
  return { label: opt.trim() }
}

export function createAskUserTool(): Tool<AskUserInput, AskUserOutput> {
  return {
    name: ASK_USER_TOOL_NAME,
    description:
      '执行任务途中向用户提出一个结构化选择题，阻塞等待作答后继续。' +
      '使用时机（严格）：多种合理解读会导致实质不同的产出，且你无法凭上下文合理决定——' +
      '例如风格/气质偏好（PPT 配色、文档调性）、范围取舍、方案分叉、格式偏好。' +
      '不要用于：' +
      '① 你能自己合理决定的——按最佳判断直接做，并在回答里说明你的假设；' +
      '② 风险确认（删除、写库、对外发送等）——那是审批系统的职责，不要用本工具替代；' +
      '③ 信息可以从文件/工具里查到的——先查再问。' +
      '纪律：每次任务最多调用 1-2 次；问题要具体、以问号结尾；' +
      '选项 2-5 个、互斥、尽量短（≤12 字），需要解释时用 "标签——一句话说明" 格式；' +
      '有推荐项时用 recommended 指出（会排在首位并标注"（推荐）"）；' +
      '不要生成"其他/随便/都可以"这类选项——UI 会自动提供自由输入与"由你决定"入口。',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '完整的问题，以问号结尾，例如 "这份 PPT 希望是什么风格？"',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 5,
          description: '2-5 个互斥选项；需要解释时用 "标签——一句话说明" 格式',
        },
        recommended: {
          type: 'integer',
          description: '推荐项在 options 中的下标（从 0 开始）；有倾向时必填',
        },
      },
      required: ['question', 'options'],
    },
    riskLevel: 'read_only',
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
    alwaysLoad: true,
    maxResultSizeChars: 2000,
    // 挂起等待用户作答，必须放宽执行器默认 120s 超时
    timeoutMs: 30 * 60 * 1000,
    category: 'interaction',
    execute: async (input: AskUserInput, ctx: ToolExecutionContext): Promise<AskUserOutput> => {
      const gate = ctx.clarifyGate
      if (!gate || !ctx.toolCallId) {
        // fail-soft：DAG / 子 Agent 等无交互通道的环境，让模型按最佳判断继续而不是挂死
        return {
          answered: false,
          note: '当前环境不支持交互提问。请按最佳判断继续，并在回答里说明你采用的假设。',
        }
      }

      const parsed = input.options.map(splitOption).filter((o) => o.label.length > 0)
      if (parsed.length < 2) {
        return {
          answered: false,
          note: '选项不足两个，本次提问未发出。请按最佳判断继续，或修正选项后重试。',
        }
      }

      // 推荐项挪到首位并标注（与 claude-code 约定一致）
      let order = parsed.map((_, i) => i)
      const rec = input.recommended
      if (typeof rec === 'number' && rec >= 0 && rec < parsed.length) {
        order = [rec, ...parsed.map((_, i) => i).filter((i) => i !== rec)]
      }
      const options = order.map((i, pos) => (pos === 0 && typeof rec === 'number' ? `${parsed[i].label}${RECOMMENDED_SUFFIX}` : parsed[i].label))
      const hints = order.map((i) => parsed[i].hint ?? '')

      const gatePromise = gate.requestClarify({
        toolCallId: ctx.toolCallId,
        question: input.question,
        options,
        hints,
      })
      // 单条工具取消（cancelTool）只发 abortSignal、不经 gate——监听信号提前结算，
      // 否则挂起 Promise 会悬到用户作答或整个 loop abort
      const outcome: ClarifyOutcome = await (ctx.abortSignal
        ? Promise.race([
            gatePromise,
            new Promise<ClarifyOutcome>((resolve) => {
              if (ctx.abortSignal!.aborted) {
                resolve({ answered: false, reason: '用户中断' })
                return
              }
              ctx.abortSignal!.addEventListener(
                'abort',
                () => resolve({ answered: false, reason: '用户中断' }),
                { once: true }
              )
            }),
          ])
        : gatePromise)

      if (outcome.answered && outcome.value === ASK_USER_DEFER_VALUE) {
        // 用户点"由你决定"：决定权交回模型，不算作答也不算中断
        return {
          answered: false,
          note: '用户把决定权交给了你。请按最佳判断继续，并在回答里说明你采用的选择与理由。',
        }
      }
      if (!outcome.answered || !outcome.value) {
        return {
          answered: false,
          note: `用户未作答（${outcome.reason ?? '已中断'}）。请按最佳判断继续完成任务，不要再追问同一问题。`,
        }
      }
      const answer = outcome.value.endsWith(RECOMMENDED_SUFFIX)
        ? outcome.value.slice(0, -RECOMMENDED_SUFFIX.length)
        : outcome.value
      return {
        answered: true,
        answer,
        note: `"${input.question}"="${answer}"。用户已作答，请结合该答案继续完成任务。`,
      }
    },
  }
}

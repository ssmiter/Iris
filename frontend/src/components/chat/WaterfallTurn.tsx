import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type { ChatMessage, RenderNode, ArtifactNode, ToolNode, RoundSnapshot, RoundStats, RoundState } from '@/types/chat'
import { FlowNode, type TurnPhase } from './FlowNode'
import { openTaskConversation } from './TaskSessionCard'
import { FlowGroup } from './FlowGroup'
import { ArtifactZone } from './ArtifactZone'
import { ArtifactModal } from './ArtifactModal'
import { FileCard } from './FileCard'
import { WebBridgeStage } from './WebBridgeStage'
import { useChatStore } from '@/stores/chatStore'
import { useMemoryDockStore } from '@/stores/memoryDockStore'
import { normalizeMarkdown, formatStreamingMarkdown } from '@/utils/markdownNormalizer'
import { legacyToRenderNodes } from '@/agent/renderNodeBuilder'
import { useReveal } from './useTextReveal'
import type { FileCardArtifact } from '@/types/artifactDock'
import { toFileCardArtifact } from '@/types/artifactDock'
import { extractArtifact } from '@/types/artifact'
import { getToolRenderer, isResultPromoted } from '@/agent/tools/toolRenderRegistry'

const remarkPlugins = [remarkGfm, remarkBreaks]

/**
 * 流式答案（丝滑交互改造 2026-07-26）：
 * 流式期间直接对"已揭示前缀"排版（formatStreamingMarkdown 容错未闭合块），
 * 完成且视觉尾巴追平后，同一容器提升为最终 Markdown——
 * 流式与终态共用 wf-prose 排版约束，提升零位移、不换脸。
 * 视觉节奏由 useReveal 视觉时钟驱动（数据脉冲 → 连续生长），重渲染锁在本组件内。
 */
const StreamingAnswer = memo(function StreamingAnswer({ text, streaming }: { text: string; streaming: boolean }) {
  const visible = useReveal(text, streaming)
  // 完成事件不截断视觉尾巴：visible 追平 target 前仍走流式渲染
  const settling = streaming || visible !== text
  // 无光标设计（2026-08-14 拍板删除块光标）：文字生长本身就是出字信号，
  // 过程节点活跃点承担工作中信号；闪烁块三轮修补仍有边界 bug（空行独闪/换行/跳段首），
  // 且是页面唯一周期动效、天然抢注意力——冗余信号，删。
  return (
    <div className="wf-prose wf-md">
      <ReactMarkdown remarkPlugins={remarkPlugins}>
        {settling ? formatStreamingMarkdown(visible) : normalizeMarkdown(text)}
      </ReactMarkdown>
    </div>
  )
})

/** 格式化时间戳为 HH:MM */
function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 用户气泡（v9.1 对话分支）：
 * - hover 出现编辑入口，点击后内联编辑，Ctrl+Enter/「重发」以新文本开新分支
 * - 有多个分支变体时下方显示 ‹ i/n › 切换（切换伴随文件状态回滚）
 * 风格克制：无强边界，与瀑布正文一体
 */
const UserBubble = memo(function UserBubble({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const branches = useChatStore((s) => s.branches)
  const resendEditedMessage = useChatStore((s) => s.resendEditedMessage)
  const switchBranch = useChatStore((s) => s.switchBranch)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)

  const entry = Object.entries(branches).find(
    ([, a]) => (a.variants[a.active]?.anchorMsgId ?? a.anchorId) === message.id
  )
  const anchor = entry?.[1]
  const anchorKey = entry?.[0]

  const commit = useCallback(() => {
    const text = draft.trim()
    setEditing(false)
    if (!text || text === message.content) return
    void resendEditedMessage(message.id, text)
  }, [draft, message.content, message.id, resendEditedMessage])

  if (editing) {
    return (
      <div className="wf-user-edit">
        <textarea
          autoFocus
          value={draft}
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
              setDraft(message.content)
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              commit()
            }
          }}
        />
        <div className="wf-user-edit-acts">
          <span className="wf-user-edit-hint">{t('chat.waterfallTurn.editHint')}</span>
          <button type="button" onClick={() => { setEditing(false); setDraft(message.content) }}>{t('common.cancel')}</button>
          <button type="button" className="primary" disabled={!draft.trim()} onClick={commit}>{t('chat.waterfallTurn.resend')}</button>
        </div>
      </div>
    )
  }

  return (
    <div className="wf-user-bubble-wrap">
      <div className="wf-user-bubble">
        {message.content}
        <button
          type="button"
          className="wf-user-edit-btn"
          title={t('chat.waterfallTurn.editTitle')}
          onClick={() => { setDraft(message.content); setEditing(true) }}
        >
          {t('chat.waterfallTurn.edit')}
        </button>
      </div>
      {anchor && anchor.variants.length > 1 && anchorKey && (
        <div className="wf-branch-pills">
          <button type="button" onClick={() => switchBranch(anchorKey, -1)} title={t('chat.waterfallTurn.prevBranch')}>‹</button>
          <span>{anchor.active + 1}/{anchor.variants.length}</span>
          <button type="button" onClick={() => switchBranch(anchorKey, 1)} title={t('chat.waterfallTurn.nextBranch')}>›</button>
        </div>
      )}
    </div>
  )
})

/**
 * 系统事件气泡（2026-08-01 异步子 Agent 通知等伪装 user 消息）：
 * 不是用户说的话——淡墨卡片、不右对齐、不白底，与普通用户气泡一眼区分。
 *
 * 2026-09-02 通知瘦身：长报告全文不再糊在主对话里——默认只显示首行事实
 * （"后台任务完成/计划已就绪/命令执行完成"），全文折叠可展开；文本指向任务会话时
 * 给出"打开任务会话"入口（报告/过程都在那边，气泡只是路标）。
 * 注意：message.content（模型上下文里的通知全文）不动——主 Agent 综合汇报要靠它。
 */
const SystemEventBubble = memo(function SystemEventBubble({ message }: { message: ChatMessage }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const text = message.content
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? ''
  const rest = text.slice(text.indexOf(firstLine) + firstLine.length).trim()
  // 任务会话入口：通知文本含"任务会话: #N"（formatSubAgentCompletion 的稳定格式）
  const taskConvId = /任务会话: #(\d+)/.exec(text)?.[1]
  return (
    <div className="wf-sysevent">
      <span className="wf-sysevent-ic">✦</span>
      <span className="wf-sysevent-text">
        {firstLine}
        {rest && !expanded && (
          <button type="button" className="wf-text-btn" onClick={() => setExpanded(true)}>
            {t('chat.systemEvent.more')}
          </button>
        )}
        {rest && expanded && (
          <>
            {'\n'}
            {rest}
            <button type="button" className="wf-text-btn" onClick={() => setExpanded(false)}>
              {t('chat.systemEvent.less')}
            </button>
          </>
        )}
        {taskConvId && (
          <button
            type="button"
            className="wf-text-btn primary"
            onClick={() => openTaskConversation(Number(taskConvId))}
          >
            {t('chat.systemEvent.openTask')}
          </button>
        )}
      </span>
    </div>
  )
})

/** 记忆便签（2026-08-05 补上欠下的渲染器，types/chat.ts 注释承诺的"淡墨行"）：
 * 自动提取落盘后留在事发地的一行——"记下了什么"当下可见，点开记忆抽屉。 */
const MemoryNoteLine = memo(function MemoryNoteLine({
  note,
}: {
  note: NonNullable<ChatMessage['memoryNote']>
}) {
  const { t } = useTranslation()
  const open = useMemoryDockStore((s) => s.open)
  const summaries = note.items.map((i) => i.summary).filter(Boolean)
  return (
    <button
      className="wf-memory-note"
      onClick={() => open({ focusId: note.items[0]?.id ?? undefined })}
    >
      <span className="wf-memory-note-ic">✒</span>
      <span>
        {t('chat.waterfallTurn.memoryNote', {
          count: note.items.length,
          summaries: summaries.length > 0 ? `：${summaries.join('、')}` : '',
        })}
      </span>
    </button>
  )
})

/** 用户消息外观分派：系统事件（子 Agent 通知）走淡墨卡，其余走用户气泡 */
function UserMessageView({ message }: { message: ChatMessage }) {
  if (message.isSystemEvent) return <SystemEventBubble message={message} />
  return (
    <div className="flex justify-end mb-3">
      <UserBubble message={message} />
    </div>
  )
}

/** 判断节点是否为终态（不再运行中） */
function isNodeSettled(node: RenderNode): boolean {
  if (node.type === 'tool') return node.status === 'done' || node.status === 'error' || node.status === 'cancelled'
  if (node.type === 'thinking') return node.status === 'done'
  if (node.type === 'answer') return node.status === 'done' || node.status === 'stopped' || node.status === 'error'
  if (node.type === 'attention') return node.status === 'resolved' || node.status === 'skipped' || node.status === 'timeout' || node.status === 'cancelled'
  return true
}

/** 格式化耗时（秒） */
function formatDuration(ms: number): string {
  if (ms <= 0) return '0s'
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 1000).toFixed(0)}s`
}

/** 格式化轮次摘要文本 */
function formatRoundSummary(stats: RoundStats, t: (key: string, options?: Record<string, unknown>) => string): string {
  const parts: string[] = []
  if (stats.thinkingMs > 0) parts.push(t('chat.waterfallTurn.thinking', { duration: formatDuration(stats.thinkingMs) }))
  if (stats.toolCount > 0) {
    const done = stats.toolDoneCount
    if (done === stats.toolCount) parts.push(t('chat.waterfallTurn.toolCallsAll', { count: stats.toolCount }))
    else parts.push(t('chat.waterfallTurn.toolCallsPartial', { done, total: stats.toolCount }))
  }
  if (stats.totalMs > 0) parts.push(t('chat.waterfallTurn.total', { duration: formatDuration(stats.totalMs) }))
  return parts.join(' · ')
}

/** 合并多个 RoundStats */
function mergeRoundStats(all: RoundStats[]): RoundStats {
  if (all.length === 0) return { thinkingCount: 0, thinkingMs: 0, toolCount: 0, toolDoneCount: 0, errorCount: 0, cancelledCount: 0, attentionCount: 0, artifactCount: 0, totalMs: 0, firstStartedAt: 0 }
  if (all.length === 1) return { ...all[0] }
  let thinkingCount = 0, thinkingMs = 0, toolCount = 0, toolDoneCount = 0
  let errorCount = 0, cancelledCount = 0, attentionCount = 0, artifactCount = 0
  let totalMs = 0
  let firstStartedAt = 0
  for (const s of all) {
    thinkingCount += s.thinkingCount
    thinkingMs += s.thinkingMs
    toolCount += s.toolCount
    toolDoneCount += s.toolDoneCount
    errorCount += s.errorCount
    cancelledCount += s.cancelledCount
    attentionCount += s.attentionCount
    artifactCount += s.artifactCount
    totalMs += s.totalMs
    if (s.firstStartedAt && (!firstStartedAt || s.firstStartedAt < firstStartedAt)) {
      firstStartedAt = s.firstStartedAt
    }
  }
  return { thinkingCount, thinkingMs, toolCount, toolDoneCount, errorCount, cancelledCount, attentionCount, artifactCount, totalMs, firstStartedAt }
}

/** 格式化 segment 摘要行标签 */
function formatSegmentLabel(indices: number[], t: (key: string, options?: Record<string, unknown>) => string): string {
  if (indices.length === 0) return ''
  if (indices.length === 1) return t('chat.waterfallTurn.roundSingle', { n: indices[0] })
  return t('chat.waterfallTurn.roundRange', { from: indices[0], to: indices[indices.length - 1] })
}

/** 从 process 节点中提取 present_artifact 产物，去重 */
function extractFileCards(nodes: RenderNode[]): FileCardArtifact[] {
  const seen = new Set<string>()
  const cards: FileCardArtifact[] = []
  for (const node of nodes) {
    if (node.type !== 'tool') continue
    if (node.toolName !== 'present_artifact') continue
    if (!node.result) continue

    // 复用 extractArtifact 的包装识别逻辑（支持 { artifact: {...} } 包装）
    const artifact = extractArtifact(node.result)
    if (!artifact) continue

    const id = artifact.path
    if (seen.has(id)) continue
    seen.add(id)
    try {
      cards.push(toFileCardArtifact(artifact))
    } catch {
      // 转换失败则跳过
    }
  }
  return cards
}

/** 渲染用轮次编组：1+ rounds 合并为一个视觉单元 */
interface RoundSegment {
  key: string
  roundIndices: number[]
  nodes: RenderNode[]
  answerText: string
  answerNode: RenderNode | undefined
  answerRoundIndex: number
  isStageConclusion: boolean
  stats: RoundStats
  phase: RoundState['phase']
  /** 从 present_artifact 工具节点中提取的文件卡片 */
  fileCards: FileCardArtifact[]
}

type RoundNodeData = {
  snapshot: RoundSnapshot
  nodes: RenderNode[]
  answerNode: RenderNode | undefined
  answerText: string
}

/** 将轮次编组为 segments：相邻无 answer 轮次合并 */
function groupRoundsIntoSegments(roundNodeLists: RoundNodeData[]): RoundSegment[] {
  const segments: RoundSegment[] = []
  let accum: RoundNodeData[] = []

  for (const rd of roundNodeLists) {
    accum.push(rd)
    if (rd.answerText) {
      segments.push(buildSegment(accum))
      accum = []
    }
  }

  // 末尾无 answer 的轮次（活跃中或被停止）
  if (accum.length > 0) {
    segments.push(buildSegment(accum))
  }

  return segments

  function buildSegment(group: RoundNodeData[]): RoundSegment {
    const last = group[group.length - 1]
    const answerRound = [...group].reverse().find((rd) => rd.answerText) || last
    const indices = group.map((rd) => rd.snapshot.index)
    const allNodes = group.flatMap((rd) => rd.nodes)
    const allStats = group.map((rd) => rd.snapshot.stats)
    const allPhases = group.map((rd) => rd.snapshot.phase)

    let phase: RoundState['phase'] = 'settled'
    if (allPhases.includes('active')) phase = 'active'
    else if (allPhases.includes('failed')) phase = 'failed'
    else if (allPhases.includes('stopped')) phase = 'stopped'

    return {
      // key 用首轮次索引（2026-07-28 修复"渲染中点开自动关闭"）：
      // 原区间键 "1-k" 在新轮次开始/k 增长时变化 → expandedSegKeys 索引失效、
      // segment 子树卸载重挂（展开状态丢失 + 闪烁）。首索引在合并延伸与
      // answer 分裂两种情况下都稳定，且一轮内各 segment 首索引互不相同。
      key: String(indices[0]),
      roundIndices: indices,
      nodes: allNodes,
      answerText: answerRound.answerText,
      answerNode: answerRound.answerNode,
      answerRoundIndex: answerRound.snapshot.index,
      isStageConclusion: false, // 由调用方设置（需要知道是否最后一个 segment）
      stats: mergeRoundStats(allStats),
      phase,
      fileCards: extractFileCards(allNodes),
    }
  }
}

interface WaterfallTurnProps {
  /** 缺省 = 回执段（命令回执/压缩边界，无用户气泡） */
  userMessage?: ChatMessage
  assistantMessages: ChatMessage[]
  allMessages: ChatMessage[]
  isStreaming?: boolean
}

// ── RoundView：单轮 flow + answer ──────────────────────────

interface RoundViewProps {
  segmentLabel: string
  answerRoundIndex: number
  isFinal: boolean
  isStageConclusion: boolean
  nodes: RenderNode[]
  answerNode: RenderNode | undefined
  answerText: string
  stats: RoundStats
  phase: 'active' | 'settled' | 'stopped' | 'failed'
  turnPhase: TurnPhase
  turnEnded: boolean
  isAnswerStreaming: boolean
  /** 由父组件管理的折叠状态 */
  showProcess: boolean
  onToggleProcess: () => void
  onNodeToggle: (nodeId: string) => void
  onTakeover: (nodeId: string) => void
  onSkipAttention: (nodeId: string) => void
  onApprove: (toolCallId: string) => void
  onReject: (toolCallId: string) => void
  promotedToolCallIds: Set<string>
  overridesRef: React.MutableRefObject<Set<string>>
  /** 该 segment 的产物文件卡片 */
  fileCards?: FileCardArtifact[]
}

const RoundView = memo(function RoundView({
  segmentLabel,
  // answerRoundIndex / isStageConclusion 仍由调用方传入（阶段结论标记下线，见下方注释），此处不解构
  isFinal,
  nodes,
  answerNode,
  answerText,
  stats,
  phase,
  turnPhase,
  turnEnded,
  isAnswerStreaming,
  showProcess,
  onToggleProcess,
  onNodeToggle,
  onTakeover,
  onSkipAttention,
  onApprove,
  onReject,
  promotedToolCallIds,
  overridesRef,
  fileCards,
}: RoundViewProps) {
  const { t } = useTranslation()
  const hasProcess = nodes.length > 0
  const isSettledRound = phase === 'settled' || phase === 'stopped' || phase === 'failed'
  const summaryText = formatRoundSummary(stats, t)

  // 本轮含 webbridge 工具 → 挂载浏览器舞台（过程即内容）
  const hasWebBridge = useMemo(
    () => nodes.some((n) => n.type === 'tool' && typeof n.toolName === 'string' && n.toolName.startsWith('webbridge')),
    [nodes]
  )

  // 将连续相同 groupId 的节点归入 FlowGroup
  const groupedItems = useMemo(() => {
    type RenderItem =
      | { kind: 'node'; node: RenderNode; segFlowed: boolean }
      | { kind: 'group'; groupId: string; groupType: 'parallel' | 'retry'; nodes: RenderNode[]; segFlowedFirst: boolean }

    const items: RenderItem[] = []
    let i = 0
    while (i < nodes.length) {
      const node = nodes[i]
      const prevNode = i > 0 ? nodes[i - 1] : null
      const segFlowed = prevNode ? isNodeSettled(prevNode) : false
      if (node.groupId) {
        const groupNodes: RenderNode[] = [node]
        let j = i + 1
        while (j < nodes.length && nodes[j].groupId === node.groupId) {
          groupNodes.push(nodes[j])
          j++
        }
        const hasFailure = groupNodes.some(
          (n) => n.type === 'tool' && (n.status === 'error' || n.status === 'cancelled')
        )
        items.push({
          kind: 'group',
          groupId: node.groupId,
          groupType: hasFailure ? 'retry' : 'parallel',
          nodes: groupNodes,
          segFlowedFirst: segFlowed,
        })
        i = j
      } else {
        items.push({ kind: 'node', node, segFlowed })
        i++
      }
    }
    return items
  }, [nodes])

  return (
    <div className="wf-round">
      {/* 过程区（在摘要行上方：展开时内容向下撑开，摘要行跟随下滑，视线保持在点击位） */}
      {hasProcess && (
        <div className={`wf-round-flow-wrap ${showProcess ? '' : 'wf-collapsed'}`}>
          <div className="wf-round-flow-inner">
            <div className="wf-round-flow">
              {groupedItems.map((item, idx) => {
                const isLastInFlow = idx === groupedItems.length - 1
                return item.kind === 'group' ? (
                  <FlowGroup
                    key={item.groupId}
                    groupId={item.groupId}
                    groupType={item.groupType}
                    nodes={item.nodes}
                    turnPhase={turnPhase}
                    segFlowedFirst={item.segFlowedFirst}
                    isLastInFlow={isLastInFlow}
                    isOverridden={(id: string) => overridesRef.current.has(id)}
                    onToggle={onNodeToggle}
                    onTakeover={onTakeover}
                    onSkipAttention={onSkipAttention}
                    onApprove={onApprove}
                    onReject={onReject}
                    promotedToolCallIds={promotedToolCallIds}
                  />
                ) : (
                  <FlowNode
                    key={item.node.id}
                    node={item.node}
                    turnPhase={turnPhase}
                    segFlowed={item.segFlowed}
                    isOverridden={overridesRef.current.has(item.node.id)}
                    isLastInFlow={isLastInFlow}
                    onToggle={onNodeToggle}
                    onTakeover={onTakeover}
                    onSkipAttention={onSkipAttention}
                    onApprove={onApprove}
                    onReject={onReject}
                    promotedToolCallIds={promotedToolCallIds}
                  />
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* 摘要行（过程内容下方：作为折叠/展开的锚点，点击时视线无需跳转） */}
      {hasProcess && (
        <button className={`wf-round-summary ${showProcess ? 'wf-round-summary-open' : ''}`} onClick={onToggleProcess}>
          <span className="wf-round-summary-chev">▶</span>
          <span className="wf-round-summary-label">{segmentLabel}</span>
          {summaryText && <span className="wf-round-summary-stats">· {summaryText}</span>}
          {phase === 'stopped' && <span className="wf-round-summary-flag warn">{t('chat.waterfallTurn.stopped')}</span>}
          {phase === 'failed' && <span className="wf-round-summary-flag err">{t('chat.waterfallTurn.failed')}</span>}
        </button>
      )}

      {/* 浏览器舞台：实时画面 + 字幕 + 就地审批 + 接管；收尾收拢为 chip */}
      {hasWebBridge && (
        <WebBridgeStage settled={isSettledRound} statsText={summaryText || undefined} />
      )}

      {/* 阶段结论 / 最终答案 */}
      {answerText && (
        <div className={`wf-round-answer ${isFinal && turnEnded ? 'wf-round-answer-final' : ''}`}>
          {/* 阶段结论眉题已下线（2026-08-04 用户决定）：多一轮任务里它只是
              一行无动画无设计的纯文本，无论字号/颜色怎么调都看着累；
              信息本身有价值，待想出配得上瀑布流的形式后再回来。
              判定逻辑 isStageConclusion 保留（计算零成本），仅不渲染。 */}
          <StreamingAnswer text={answerText} streaming={isAnswerStreaming} />
        </div>
      )}

      {/* 可交互业务结果卡片：由工具渲染注册表显式声明提升，避免在聊天层硬编码业务名称。 */}
      {nodes.filter(isPromotedToolResult).map((node) => (
        <PromotedToolResult key={`promoted:${node.id}`} node={node} />
      ))}

      {/* 产物文件卡片（present_artifact 产出，在 answer 下方） */}
      {fileCards && fileCards.length > 0 && (
        <div className="wf-round-answer">
          {fileCards.map((fc) => (
            <FileCard key={fc.id} artifact={fc} />
          ))}
        </div>
      )}
    </div>
  )
})

function isPromotedToolResult(node: RenderNode): node is ToolNode {
  return node.type === 'tool'
    && node.status === 'done'
    && node.result != null
    && isResultPromoted(node.toolName, node.result)
}

function PromotedToolResult({ node }: { node: ToolNode }) {
  const Renderer = getToolRenderer(node.toolName)?.resultRenderer
  if (!Renderer) return null
  const message: ChatMessage = {
    id: `promoted:${node.id}`,
    role: 'tool',
    content: node.summary,
    structuredData: node.result,
    toolCallName: node.toolName,
    toolCallStatus: 'done',
  }
  return (
    <div className="wf-round-answer">
      <Renderer message={message} />
    </div>
  )
}

/**
 * 瀑布流 Turn 容器（v4.0 轮次模型）。
 *
 * Turn = N × (flow + answer)，每轮独立折叠。
 * - 折叠纯手动：flow 默认收起为摘要行（含思考/工具/耗时统计），仅用户点击展开；
 *   流式 delta、phase 变化、round 切换均不改变任何折叠状态
 * - 中间轮次 answer 带"阶段结论"chip + 轮次标注
 * - 最终轮次 answer 无 chip（即为最终答案）
 * - turn 结束后显示 turn 总结行
 *
 * 向后兼容：无 rounds 数据时按单轮渲染。
 */
export const WaterfallTurn = memo(function WaterfallTurn({
  userMessage,
  assistantMessages,
  allMessages,
  isStreaming,
}: WaterfallTurnProps) {
  const { t } = useTranslation()
  // 2026-07-31 订阅风暴修复：对象字面量选择器无 shallow 会在每次 chatStore set
  // （流式期间每 200ms flush）让所有 turn 重渲染；三个都是稳定 action 引用，拆开订阅。
  const approveToolCall = useChatStore((s) => s.approveToolCall)
  const rejectToolCall = useChatStore((s) => s.rejectToolCall)
  const resolveAttention = useChatStore((s) => s.resolveAttention)

  // 收集所有 renderNodes（memoryNote 便签不是对话内容——空 content 会污染
  // lastAssistant/rounds 判定，单独剥离渲染为淡墨行，2026-08-05）
  const contentMessages = useMemo(
    () => assistantMessages.filter((m) => !m.memoryNote),
    [assistantMessages]
  )
  const memoryNotes = useMemo(
    () => assistantMessages.filter((m) => m.memoryNote),
    [assistantMessages]
  )
  const allNodes = useMemo(() => {
    const nodes: RenderNode[] = []
    for (const msg of contentMessages) {
      if (msg.renderNodes && msg.renderNodes.length > 0) {
        nodes.push(...msg.renderNodes)
      } else if (msg.role === 'assistant') {
        const synthetic = legacyToRenderNodes(msg)
        if (synthetic.length > 0) nodes.push(...synthetic)
      }
    }
    return nodes
  }, [contentMessages])

  // v4.0: 从最后一个 assistant 消息读取轮次数据
  const lastAssistant = contentMessages[contentMessages.length - 1]
  const roundsData: RoundSnapshot[] | undefined = lastAssistant?.rounds
  const answersData: string[] | undefined = lastAssistant?.answers
  const turnStats = lastAssistant?.turnStats

  // nodeId → node 快速查找
  const nodeMap = useMemo(() => {
    const map = new Map<string, RenderNode>()
    for (const n of allNodes) map.set(n.id, n)
    return map
  }, [allNodes])

  // 提取产物节点
  const artifacts = useMemo(() => {
    return allNodes.filter((n): n is ArtifactNode => n.type === 'artifact')
  }, [allNodes])

  const promotedToolCallIds = useMemo(() => {
    const ids = new Set<string>()
    for (const a of artifacts) {
      if (a.sourceToolCallId) ids.add(a.sourceToolCallId)
    }
    return ids
  }, [artifacts])

  // ── 终态检测 ──
  const endState = useMemo(() => {
    if (!lastAssistant) return undefined
    if (lastAssistant.turnPhase === 'settled') return 'settled'
    if (lastAssistant.turnPhase === 'stopped') return 'stopped'
    if (lastAssistant.turnPhase === 'failed') return 'failed'
    if (isStreaming) return undefined
    if (lastAssistant.turnPhase === 'active') return undefined
    if (lastAssistant.status === 'error') return 'failed'
    if (lastAssistant.status === 'cancelled') return 'stopped'
    const stoppedAnswer = allNodes.find((n) => n.type === 'answer' && n.status === 'stopped')
    if (stoppedAnswer) return 'stopped'
    if (lastAssistant.status === 'done') return 'settled'
    if (lastAssistant.content && lastAssistant.content.length > 0) return 'settled'
    if (allNodes.length > 0 && allNodes.every((n) => {
      if (n.type === 'tool') return n.status === 'done' || n.status === 'error' || n.status === 'cancelled'
      if (n.type === 'thinking') return n.status === 'done'
      if (n.type === 'answer') return n.status === 'done' || n.status === 'stopped'
      return true
    })) return 'settled'
    return undefined
  }, [lastAssistant, allNodes, isStreaming])

  const settled = endState === 'settled'
  const ended = settled || endState === 'stopped' || endState === 'failed'

  // ── TurnPhase 状态机 ──
  const phaseRef = useRef<TurnPhase>(ended && !isStreaming ? 'settled' : 'active')
  const [turnPhase, setTurnPhase] = useState<TurnPhase>(
    () => ended && !isStreaming ? 'settled' : 'active'
  )
  const settlingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isStreaming) {
      if (settlingTimerRef.current) {
        clearTimeout(settlingTimerRef.current)
        settlingTimerRef.current = null
      }
      if (phaseRef.current !== 'active') {
        phaseRef.current = 'active'
        setTurnPhase('active')
      }
      return
    }
    if (ended && phaseRef.current === 'active') {
      phaseRef.current = 'settling'
      setTurnPhase('settling')
      settlingTimerRef.current = setTimeout(() => {
        phaseRef.current = 'settled'
        setTurnPhase('settled')
        settlingTimerRef.current = null
      }, 300)
    }
    return () => {
      if (settlingTimerRef.current) {
        clearTimeout(settlingTimerRef.current)
        settlingTimerRef.current = null
      }
    }
  }, [isStreaming, ended])

  // ── 折叠状态（纯手动模型）──
  // expandedSegKeys: 用户手动展开的 segment 集合——默认全部收起，
  // 流式 delta / phase 变化 / round 切换绝不修改此集合，只有 onClick 能改。
  const [expandedSegKeys, setExpandedSegKeys] = useState<Set<string>>(new Set())
  // turn 级全展开（兼容旧布局）
  const [showProcess, setShowProcess] = useState(false)
  const overridesRef = useRef<Set<string>>(new Set())
  const [, setOverridesVersion] = useState(0)
  const [fullscreenArtifact, setFullscreenArtifact] = useState<ArtifactNode | null>(null)

  const handleNodeToggle = useCallback((nodeId: string) => {
    const set = overridesRef.current
    if (set.has(nodeId)) {
      set.delete(nodeId)
    } else {
      set.add(nodeId)
    }
    setOverridesVersion((v) => v + 1)
  }, [])

  const handleToggleProcess = useCallback(() => {
    setShowProcess((v) => !v)
  }, [])

  // v4.0: per-segment 折叠切换（唯一修改 expandedSegKeys 的入口）
  const handleToggleSegment = useCallback((segKey: string) => {
    setExpandedSegKeys((prev) => {
      const next = new Set(prev)
      if (next.has(segKey)) {
        next.delete(segKey)
      } else {
        next.add(segKey)
      }
      return next
    })
  }, [])

  // 澄清回答走 FloatingActionBar（浮动操作栏是唯一入口，2026-08-04 收敛），
  // 瀑布内不再透传 onClarifyPick。
  const handleTakeover = useCallback((nodeId: string) => {
    resolveAttention(nodeId, undefined, false)
    overridesRef.current.add(nodeId)
    setOverridesVersion((v) => v + 1)
    const el = document.createElement('div')
    el.textContent = t('chat.waterfallTurn.takeoverToast')
    el.style.cssText = `
      position: fixed; left: 50%; bottom: 110px; transform: translateX(-50%);
      background: var(--wf-capsule-bg); color: var(--wf-capsule-ink); font-size: 12.5px;
      padding: 8px 16px; border-radius: 999px; z-index: 200;
      opacity: 0; transition: opacity .25s; pointer-events: none;
    `
    document.body.appendChild(el)
    requestAnimationFrame(() => { el.style.opacity = '1' })
    setTimeout(() => {
      el.style.opacity = '0'
      setTimeout(() => el.remove(), 300)
    }, 1800)
  }, [resolveAttention])

  const handleSkipAttention = useCallback((nodeId: string) => {
    resolveAttention(nodeId, undefined, false)
    overridesRef.current.add(nodeId)
    setOverridesVersion((v) => v + 1)
  }, [resolveAttention])

  // 汇总答案内容（兼容旧布局）
  const answerContent = useMemo(() => {
    for (let i = contentMessages.length - 1; i >= 0; i--) {
      const msg = contentMessages[i]
      if (msg.content) return msg.content
    }
    return ''
  }, [contentMessages])

  // 当前正在流式输出的 answer（最后一个 answer node 为 streaming）
  const activeStreamingAnswer = useMemo(() => {
    for (let i = allNodes.length - 1; i >= 0; i--) {
      const n = allNodes[i]
      if (n.type === 'answer' && n.status === 'streaming') return n
    }
    return null
  }, [allNodes])

  const isAnswerStreaming = activeStreamingAnswer !== null

  // ── 过程中补充（v9.3）：不在瀑布流渲染气泡——composer chip 动画即是反馈，
  // 补充消息仍持久化在历史/上下文（导出可见），但不占视觉层级，
  // 避免"气泡沉在 turn 末尾像下一轮"的错位感。

  // turn meta 文本（2026-09-02 状态文案去重）：只在终态出现——运行中的状态由
  // 输入区 rowhint「任务执行中…」一处承担，turn 底部不再挂「进行中」（两处同框即噪音）
  const turnMetaText = useMemo(() => {
    const time = userMessage ? formatTime(userMessage.timestamp) : ''
    if (endState === 'failed') return time ? `${time} · ${t('chat.waterfallTurn.failed')}` : t('chat.waterfallTurn.failed')
    if (endState === 'stopped') return time ? `${time} · ${t('chat.waterfallTurn.stopped')}` : t('chat.waterfallTurn.stopped')
    if (settled) return time ? `${time} · ${t('chat.waterfallTurn.completed')}` : t('chat.waterfallTurn.completed')
    return ''
  }, [userMessage, endState, settled, t])

  const turnMetaClass = useMemo(() => {
    if (endState === 'failed') return 'wf-turn-meta failed'
    if (endState === 'stopped') return 'wf-turn-meta stopped'
    return 'wf-turn-meta'
  }, [endState])

  // turn 级 CSS 类
  const turnClass = useMemo(() => {
    const classes = ['wf-turn']
    if (turnPhase === 'settling') classes.push('wf-settling')
    if (turnPhase === 'settled') classes.push('wf-settled')
    if (endState === 'stopped') classes.push('wf-stopped')
    if (endState === 'failed') classes.push('wf-failed')
    return classes.join(' ')
  }, [turnPhase, endState])

  // v4.0: 构建每个 round 的节点列表
  const roundNodeLists = useMemo(() => {
    if (!roundsData) return null
    return roundsData.map((r) => {
      const roundNodes = r.nodeIds.map((id) => nodeMap.get(id)).filter(Boolean) as RenderNode[]
      const answerNode = r.answerNodeId ? nodeMap.get(r.answerNodeId) : undefined
      return {
        snapshot: r,
        nodes: roundNodes.filter((n) => n.type !== 'answer' && n.type !== 'artifact'),
        answerNode,
        answerText: answerNode && answerNode.type === 'answer'
          ? answerNode.content
          : (answersData?.[r.index - 1] ?? ''),
      }
    })
  }, [roundsData, nodeMap, answersData])

  // v4.0: 将轮次编组为 segments（相邻无 answer 轮次合并）
  const roundSegments = useMemo(() => {
    if (!roundNodeLists) return null
    const segments = groupRoundsIntoSegments(roundNodeLists)
    // 设置 isStageConclusion（需要在知道是否最后一段后设置）
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      seg.isStageConclusion = seg.answerText !== '' && i < segments.length - 1
    }
    return segments
  }, [roundNodeLists])

  // 判断哪个 segment 的 answer 正在流式
  const streamingSegmentKey = useMemo(() => {
    if (!activeStreamingAnswer || !roundSegments) return null
    for (const seg of roundSegments) {
      if (seg.answerNode?.id === activeStreamingAnswer.id) return seg.key
    }
    // fallback: 最后一段
    return roundSegments.length > 0 ? roundSegments[roundSegments.length - 1].key : null
  }, [activeStreamingAnswer, roundSegments])

  // 全部展开/收起（必须在 roundSegments 定义之后）
  const handleToggleAllRounds = useCallback(() => {
    if (!roundSegments) return
    const allExpanded = roundSegments.every((seg) => expandedSegKeys.has(seg.key))
    setExpandedSegKeys(
      allExpanded ? new Set() : new Set(roundSegments.map((s) => s.key))
    )
  }, [roundSegments, expandedSegKeys])

  // ── 旧布局兜底 hooks（必须在所有条件 return 之前调用，避免 hooks 顺序变化导致白屏） ──
  const processNodes = useMemo(() => {
    return allNodes.filter((n) => {
      if (n.type === 'artifact' || n.type === 'answer') return false
      if (n.type === 'tool' && (n.toolName === 'present_artifact' || n.toolName === 'presentArtifact')) return false
      return true
    })
  }, [allNodes])

  const nodeSegStates = useMemo(() => {
    return processNodes.map((node, i) => {
      const prevNode = i > 0 ? processNodes[i - 1] : null
      const segFlowed = prevNode ? isNodeSettled(prevNode) : false
      return { node, segFlowed }
    })
  }, [processNodes])

  const groupedRenderItems = useMemo(() => {
    type RenderItem =
      | { kind: 'node'; node: RenderNode; segFlowed: boolean }
      | { kind: 'group'; groupId: string; groupType: 'parallel' | 'retry'; nodes: RenderNode[]; segFlowedFirst: boolean }

    const items: RenderItem[] = []
    let i = 0
    while (i < nodeSegStates.length) {
      const { node, segFlowed } = nodeSegStates[i]
      if (node.groupId) {
        const groupNodes: RenderNode[] = [node]
        let j = i + 1
        while (j < nodeSegStates.length && nodeSegStates[j].node.groupId === node.groupId) {
          groupNodes.push(nodeSegStates[j].node)
          j++
        }
        const hasFailure = groupNodes.some(
          (n) => n.type === 'tool' && (n.status === 'error' || n.status === 'cancelled')
        )
        items.push({
          kind: 'group',
          groupId: node.groupId,
          groupType: hasFailure ? 'retry' : 'parallel',
          nodes: groupNodes,
          segFlowedFirst: segFlowed,
        })
        i = j
      } else {
        items.push({ kind: 'node', node, segFlowed })
        i++
      }
    }
    return items
  }, [nodeSegStates])

  const oldTurnClass = useMemo(() => {
    const classes = ['wf-turn']
    if (turnPhase === 'settling') classes.push('wf-settling')
    if (turnPhase === 'settled') classes.push('wf-settled')
    if (endState === 'stopped') classes.push('wf-stopped')
    if (endState === 'failed') classes.push('wf-failed')
    if (showProcess) classes.push('wf-show-process')
    else classes.push('wf-no-process')
    return classes.join(' ')
  }, [turnPhase, showProcess, endState])

  // ── v4.0 多轮渲染 ──
  if (roundSegments && roundSegments.length > 0) {
    return (
      <div className={turnClass}>
        {/* 用户问题（回执段无用户消息时省略；v9.1 支持编辑重发与分支切换） */}
        {userMessage && <UserMessageView message={userMessage} />}

        {/* 各轮次段 */}
        {roundSegments!.map((seg, idx) => {
          const isFinal = idx === roundSegments!.length - 1
          const isStreamingSeg = seg.key === streamingSegmentKey
          const segShowProcess = expandedSegKeys.has(seg.key) // 纯手动：默认收起，流式不触碰

          return (
            <div key={seg.key}>
            <RoundView
              segmentLabel={formatSegmentLabel(seg.roundIndices, t)}
              answerRoundIndex={seg.answerRoundIndex}
              isFinal={isFinal}
              isStageConclusion={seg.isStageConclusion}
              nodes={seg.nodes}
              answerNode={seg.answerNode}
              answerText={seg.answerText}
              stats={seg.stats}
              phase={seg.phase}
              turnPhase={turnPhase}
              turnEnded={ended || false}
              isAnswerStreaming={isStreamingSeg && isAnswerStreaming}
              showProcess={segShowProcess}
              onToggleProcess={() => handleToggleSegment(seg.key)}
              onNodeToggle={handleNodeToggle}
              onTakeover={handleTakeover}
              onSkipAttention={handleSkipAttention}
              onApprove={approveToolCall}
              onReject={rejectToolCall}
              promotedToolCallIds={promotedToolCallIds}
              overridesRef={overridesRef}
              fileCards={seg.fileCards}
            />
          </div>
        )
        })}

        {/* 产物区 */}
        <ArtifactZone
          artifacts={artifacts}
          onViewFullscreen={(artifactId) => {
            const found = artifacts.find((a) => a.artifactId === artifactId)
            if (found) setFullscreenArtifact(found)
          }}
        />

        {/* v4.0 Turn 总结行（结束后显示） */}
        {ended && roundSegments && roundSegments.length > 0 && (() => {
          const allExpanded = roundSegments.every((seg) => expandedSegKeys.has(seg.key))
          return (
          <button className={`wf-turn-summary ${allExpanded ? 'wf-turn-summary-open' : ''}`} onClick={handleToggleAllRounds}>
            <span className="wf-turn-summary-chev">▶</span>
            <span>{t('chat.waterfallTurn.totalRounds', { count: roundsData!.length })}</span>
          </button>
          )
        })()}

        {/* 记忆便签（淡墨行）：自动提取的新记忆在事发地可见 */}
        {memoryNotes.map((m) => (
          <MemoryNoteLine key={m.id} note={m.memoryNote!} />
        ))}

        {/* Turn Meta 行（运行中为空串=不渲染，见 turnMetaText 注释） */}
        {turnMetaText && <div className={turnMetaClass}>{turnMetaText}</div>}

        {/* 产物全屏浮层 */}
        <ArtifactModal
          artifact={fullscreenArtifact}
          onClose={() => setFullscreenArtifact(null)}
        />
      </div>
    )
  }

  // ── 旧布局兜底（无 rounds 数据的消息） ──

  return (
    <div className={oldTurnClass}>
      {/* 用户问题（回执段无用户消息时省略；v9.1 支持编辑重发与分支切换） */}
      {userMessage && <UserMessageView message={userMessage} />}

      {/* 摘要行（所有阶段常驻；有过程内容即提供展开入口，折叠状态纯手动） */}
      {(turnStats || processNodes.length > 0) && (
        <button className="wf-settle-line" onClick={handleToggleProcess}>
          <span className="wf-settle-chev">▶</span>
          {turnStats && turnStats.toolCount > 0 && (
            <span>{t('chat.waterfallTurn.toolCallsPartial', { done: turnStats.toolDoneCount, total: turnStats.toolCount })}</span>
          )}
          {turnStats && turnStats.thinkingMs > 0 && (
            <span>· {t('chat.waterfallTurn.thinking', { duration: formatDuration(turnStats.thinkingMs) })}</span>
          )}
          {turnStats && turnStats.totalMs > 0 && (
            <span>· {t('chat.waterfallTurn.total', { duration: formatDuration(turnStats.totalMs) })}</span>
          )}
          {!turnStats && <span>{t('chat.waterfallTurn.processDetails')}</span>}
          {endState === 'stopped' && <span className="wf-settle-flag warn"><span className="wf-settle-fd" />{t('chat.waterfallTurn.stopped')}</span>}
          {endState === 'failed' && <span className="wf-settle-flag err"><span className="wf-settle-fd" />{t('chat.waterfallTurn.failed')}</span>}
        </button>
      )}

      {/* 瀑布脊柱（纯手动：不再随 turnPhase 自动展开/收起） */}
      {showProcess && (
        <div className="wf-flow">
          {groupedRenderItems.map((item, idx) => {
            const isLastInFlow = idx === groupedRenderItems.length - 1
            return item.kind === 'group' ? (
              <FlowGroup
                key={item.groupId}
                groupId={item.groupId}
                groupType={item.groupType}
                nodes={item.nodes}
                turnPhase={turnPhase}
                segFlowedFirst={item.segFlowedFirst}
                isLastInFlow={isLastInFlow}
                isOverridden={(id: string) => overridesRef.current.has(id)}
                onToggle={handleNodeToggle}
                onTakeover={handleTakeover}
                onSkipAttention={handleSkipAttention}
                onApprove={approveToolCall}
                onReject={rejectToolCall}
                promotedToolCallIds={promotedToolCallIds}
              />
            ) : (
              <FlowNode
                key={item.node.id}
                node={item.node}
                turnPhase={turnPhase}
                segFlowed={item.segFlowed}
                isOverridden={overridesRef.current.has(item.node.id)}
                isLastInFlow={isLastInFlow}
                onToggle={handleNodeToggle}
                onTakeover={handleTakeover}
                onSkipAttention={handleSkipAttention}
                onApprove={approveToolCall}
                onReject={rejectToolCall}
                promotedToolCallIds={promotedToolCallIds}
              />
            )
          })}
        </div>
      )}

      {/* 产物区 */}
      <ArtifactZone
        artifacts={artifacts}
        onViewFullscreen={(artifactId) => {
          const found = artifacts.find((a) => a.artifactId === artifactId)
          if (found) setFullscreenArtifact(found)
        }}
      />

      {/* 答案 */}
      {answerContent && (
        <div className="wf-answer">
          <StreamingAnswer text={answerContent} streaming={isStreaming || isAnswerStreaming} />
          {endState === 'stopped' && <span className="wf-stop-mark">{t('chat.waterfallTurn.partialStopMark')}</span>}
        </div>
      )}
      {/* 记忆便签（淡墨行） */}
      {memoryNotes.map((m) => (
        <MemoryNoteLine key={m.id} note={m.memoryNote!} />
      ))}
      {/* Turn Meta 行（运行中为空串=不渲染） */}
      {turnMetaText && <div className={turnMetaClass}>{turnMetaText}</div>}

      {/* 产物全屏浮层 */}
      <ArtifactModal
        artifact={fullscreenArtifact}
        onClose={() => setFullscreenArtifact(null)}
      />
    </div>
  )
})

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, ListRestart, Moon, Sun } from 'lucide-react'
import {
  cancelSupplement,
  createBranch,
  createCompaction,
  createConversation,
  createSupplement,
  createTurn,
  decideApproval,
  getContextUsage,
  getConversationView,
  IrisApiError,
  listConversations,
  listTasks,
  respondAttention,
  streamConversationEvents,
  stopTurn,
  uploadArtifact,
  type ContextUsageView,
  type ConversationView,
  type UploadedArtifact,
} from '@/api/irisApi'
import { ConversationShell } from '@/components/layout'
import { Badge, Button, ToastHost, notify } from '@/components/ui'
import { CapabilityCenter } from '@/components/capabilities'
import type {
  AttentionAction,
  AttentionNode,
  BranchSummary,
  CompactBoundaryView,
  CompactionView,
} from '@/domain/chat/models'
import type { TurnView } from '@/domain/chat/models'
import { selectActiveTurn, selectProjection } from '@/domain/chat/selectors'
import { useChatStore } from '@/stores/chatStore'
import {
  useConversationStore,
  type ConversationSummary,
} from '@/stores/conversationStore'
import { useViewStateStore } from '@/stores/viewStateStore'
import { ComposerDock } from './composer'
import { ChildRunCapsules, ChildRunPanel } from './ChildRunView'
import { ConversationTimeline } from './ConversationTimeline'
import type { ConversationTimelineHandle } from './ConversationTimeline'
import { HydrationSkeleton } from './HydrationSkeleton'
import { StallProvider } from './FlowNode'
import { PendingApprovalStack } from './PendingApprovalStack'
import { TaskBlackboard } from './TaskBlackboard'
import { TurnRail } from './TurnRail'
import { useAnswerQuote } from './useAnswerQuote'

function summary(view: ConversationView) {
  const turns = Object.values(view.turnsById)
  return {
    conversationId: view.conversationId,
    title: view.title || '新对话',
    updatedAt:
      turns.at(-1)?.stats.startedAt ?? new Date().toISOString(),
    activeTurnCount: turns.filter(
      (turn) => turn.phase === 'active' || turn.phase === 'queued',
    ).length,
    pendingAttentionCount: view.pendingAttentionIds?.length ?? 0,
    version: view.version,
  }
}

export function ConversationApp() {
  const chat = useChatStore()
  const conversations = useConversationStore()
  const draftsByConversationId = useViewStateStore(
    (state) => state.draftsByConversationId,
  )
  const permissionMode = useViewStateStore(
    (state) => state.permissionMode,
  )
  const theme = useViewStateStore((state) => state.theme)
  // 顶栏快捷切换作用于「当前呈现」的反色：system 档先解析再取反
  const resolvedTheme: 'light' | 'dark' =
    theme === 'system'
      ? typeof window !== 'undefined'
        && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme
  const setDraft = useViewStateStore((state) => state.setDraft)
  const setPermissionMode = useViewStateStore(
    (state) => state.setPermissionMode,
  )
  const setTheme = useViewStateStore((state) => state.setTheme)
  const currentConversationId = conversations.currentConversationId
  const currentBranchId = conversations.currentBranchId
  const branches = conversations.branches
  const draftKey = currentConversationId
    ? `${currentConversationId}:${currentBranchId ?? ''}`
    : 'new-conversation'
  const draft = draftsByConversationId[draftKey] ?? ''
  const [replacementTarget, setReplacementTarget] =
    useState<TurnView | null>(null)
  const [viewerRunId, setViewerRunId] = useState<string | null>(null)
  const [pendingAttachments, setPendingAttachments] =
    useState<UploadedArtifact[]>([])
  const [pendingQuotes, setPendingQuotes] = useState<
    Array<{ id: string; text: string }>
  >([])
  const [contextUsage, setContextUsage] = useState<ContextUsageView | null>(
    null,
  )
  const [earlierLoading, setEarlierLoading] = useState(false)
  const earlierLoadingRef = useRef(false)
  const timelineRef = useRef<ConversationTimelineHandle>(null)

  // 向上翻页：以视野内最早 Turn 为水位线取上一页，只补不覆盖；
  // 压缩线随页并入（dedup 由 addCompactBoundary 保证）。
  const loadEarlierTurns = useCallback(async () => {
    if (!currentConversationId || earlierLoadingRef.current) return
    const chatState = useChatStore.getState()
    const firstTurnId = chatState.turnOrder[0]
    if (!firstTurnId || !chatState.hasEarlierTurns) return
    earlierLoadingRef.current = true
    setEarlierLoading(true)
    try {
      const view = await getConversationView(
        currentConversationId,
        useConversationStore.getState().currentBranchId || undefined,
        firstTurnId,
      )
      useChatStore.getState().prependEarlierView(view)
      for (const boundary of view.compactBoundaries) {
        useConversationStore.getState().addCompactBoundary(boundary)
      }
    } catch (error) {
      notify.error('更早的轮次暂时没有载入', {
        description: error instanceof Error ? error.message : '请稍后重试。',
      })
    } finally {
      earlierLoadingRef.current = false
      setEarlierLoading(false)
    }
  }, [currentConversationId])

  useEffect(() => {
    setPendingAttachments([])
    setPendingQuotes([])
  }, [draftKey])

  const hydrateView = useCallback((view: ConversationView) => {
    useChatStore.getState().hydrateView(view)
    useConversationStore.getState().setCurrentConversation(
      view.conversationId,
      view.selectedBranchId,
    )
    useConversationStore.getState().setCompactBoundaries(
      view.compactBoundaries,
    )
    useConversationStore.getState().setBranches(view.branches)
    useConversationStore.getState().setCompactions(view.compactionsById)
    // 列表水合给出的 lastVisibleText 在 view 摘要里没有——合并保留，避免每次
    // hydrateView 把侧栏预览行抹掉。
    useConversationStore.getState().upsertConversation({
      ...useConversationStore.getState().conversationsById[
        view.conversationId
      ],
      ...summary(view),
    })
    useViewStateStore.getState().seedExpandedNodes(
      Object.values(view.renderNodesById)
        .filter(
          (node) =>
            (node.type === 'attention' && node.status === 'waiting') ||
            node.status === 'failed' ||
            node.status === 'outcome_unknown',
        )
        .map((node) => node.nodeId),
    )
  }, [])

  useEffect(() => {
    let cancelled = false
    useConversationStore.setState({ loadingState: 'loading' })
    listConversations()
      .then((page) => {
        if (cancelled) return
        conversations.hydrateList(
          page.items.map((item) => ({
            ...item,
            title: item.title || '新对话',
          })),
        )
        if (!useConversationStore.getState().currentConversationId) {
          const first = page.items[0]
          if (first) {
            useConversationStore.getState().setCurrentConversation(
              first.conversationId,
              '',
            )
          }
        }
      })
      .catch((error: Error) => {
        if (cancelled) return
        useConversationStore.setState({ loadingState: 'failed' })
        notify.error('无法读取本地对话', { description: error.message })
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!currentConversationId) return
    const controller = new AbortController()
    useChatStore.getState().setConnectionState('hydrating')
    getConversationView(
      currentConversationId,
      currentBranchId || undefined,
    )
      .then(async (view) => {
        if (controller.signal.aborted) return
        hydrateView(view)
        try {
          const usage = await getContextUsage(
            view.conversationId,
            view.selectedBranchId,
          )
          if (!controller.signal.aborted) {
            setContextUsage(usage)
          }
        } catch {
          // 上下文用量不是核心路径，静默失败
        }
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return
        useChatStore.getState().setConnectionState('failed')
        notify.error('对话恢复失败', { description: error.message })
      })
    return () => controller.abort()
  }, [currentBranchId, currentConversationId, hydrateView])

  useEffect(() => {
    if (!currentConversationId || !currentBranchId) {
      useChatStore.setState({ tasksById: {} })
      return
    }
    const controller = new AbortController()
    useChatStore.setState({ tasksById: {} })
    listTasks(currentConversationId, currentBranchId)
      .then((page) => {
        if (!controller.signal.aborted) {
          useChatStore.getState().hydrateTasks(page.items)
        }
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return
        notify.warning('任务进度暂时不可见', {
          description: error.message,
        })
      })
    return () => controller.abort()
  }, [currentBranchId, currentConversationId])

  useEffect(() => {
    if (
      !currentConversationId ||
      !currentBranchId ||
      chat.connectionState === 'hydrating'
    ) {
      return
    }
    const controller = new AbortController()
    let reconnectTimer: number | undefined
    let reconnectAttempt = 0

    const connect = async () => {
      if (controller.signal.aborted) return
      useChatStore.getState().setConnectionState(
        reconnectAttempt === 0 ? 'connecting' : 'reconnecting',
      )
      try {
        await streamConversationEvents(
          currentConversationId,
          useChatStore.getState().eventCursor,
          controller.signal,
          (event) => {
            // branch.created 的 envelope.branchId 是新分支自身——必须先于
            // 下方 branchId 过滤处理，否则永远被丢弃（盲猜对账发现的断链）。
            if (event.type === 'branch.created') {
              const branch = event.envelope.payload.branch as
                | BranchSummary
                | undefined
              if (branch) {
                const conversationState = useConversationStore.getState()
                if (
                  !conversationState.branches.some(
                    (item) => item.branchId === branch.branchId,
                  )
                ) {
                  conversationState.setBranches([
                    ...conversationState.branches,
                    branch,
                  ])
                }
              }
              return
            }
            if (event.type === 'conversation.updated') {
              const incoming = event.envelope.payload.conversation as
                | Partial<
                    Pick<
                      ConversationSummary,
                      | 'title'
                      | 'updatedAt'
                      | 'activeTurnCount'
                      | 'pendingAttentionCount'
                      | 'lastVisibleText'
                      | 'version'
                    >
                  > & { archived?: boolean }
                | undefined
              const conversationId = event.envelope.conversationId
              if (incoming && conversationId) {
                const conversationState = useConversationStore.getState()
                if (incoming.archived === true) {
                  // 归档即移出列表视野；历史在服务端完整保留
                  conversationState.removeConversation(conversationId)
                  return
                }
                const existing =
                  conversationState.conversationsById[conversationId]
                if (existing) {
                  conversationState.upsertConversation({
                    ...existing,
                    ...incoming,
                    conversationId,
                    title: incoming.title ?? existing.title,
                  })
                }
              }
              return
            }
            if (
              event.envelope.branchId &&
              event.envelope.branchId !== currentBranchId
            ) {
              return
            }
            if (event.type === 'context.usage') {
              const usage = event.envelope.payload.contextUsage as
                | ContextUsageView
                | undefined
              if (usage) {
                setContextUsage(usage)
              }
              return
            }
            const eventTurn =
              event.type === 'turn.accepted' ||
              event.type === 'turn.updated'
                ? (event.envelope.payload.turn as
                    | TurnView
                    | undefined)
                : undefined
            const previousTurn = eventTurn
              ? useChatStore.getState().turnsById[eventTurn.turnId]
              : undefined
            useChatStore.getState().applyEvent(event)
            if (eventTurn) {
              const isActive = (turn: TurnView | undefined) =>
                turn?.phase === 'queued' || turn?.phase === 'active'
              const activeDelta =
                Number(isActive(eventTurn)) -
                Number(isActive(previousTurn))
              if (activeDelta !== 0) {
                const conversationState =
                  useConversationStore.getState()
                const currentSummary =
                  conversationState.conversationsById[
                    currentConversationId
                  ]
                if (currentSummary) {
                  conversationState.upsertConversation({
                    ...currentSummary,
                    activeTurnCount: Math.max(
                      0,
                      currentSummary.activeTurnCount + activeDelta,
                    ),
                    updatedAt: event.envelope.occurredAt,
                  })
                }
              }
            }
            if (
              event.type.startsWith('compaction.') &&
              event.envelope.payload.compaction
            ) {
              useConversationStore.getState().upsertCompaction(
                event.envelope.payload.compaction as unknown as CompactionView,
              )
              const boundary = event.envelope.payload.boundary
              if (boundary) {
                useConversationStore.getState().addCompactBoundary(
                  boundary as unknown as CompactBoundaryView,
                )
              }
              if (event.type === 'compaction.completed') {
                notify.success('上下文已整理完成', {
                  description:
                    '新的 Context Frame 已生效，完整历史仍可在当前对话中查看。',
                })
              } else if (event.type === 'compaction.failed') {
                notify.error('上下文整理没有完成', {
                  description:
                    '原始历史没有受到影响，可以稍后重新尝试。',
                })
              }
            }
            useChatStore.getState().setConnectionState('connected')
          },
          () => {
            reconnectAttempt = 0
            useChatStore.getState().setConnectionState('connected')
          },
        )
      } catch (error) {
        if (controller.signal.aborted) return
        // 续传游标失效（410 event_cursor_unavailable）：整树重水合拿到新游标
        // 再重连——否则同一个失效游标会在退避循环里无限 410。
        if (error instanceof IrisApiError && error.status === 410) {
          try {
            const view = await getConversationView(
              currentConversationId,
              currentBranchId || undefined,
            )
            if (controller.signal.aborted) return
            hydrateView(view)
            reconnectAttempt = 0
            void connect()
            return
          } catch {
            // 重水合也失败，落入常规退避
          }
        }
        reconnectAttempt += 1
        reconnectTimer = window.setTimeout(
          connect,
          Math.min(500 * 2 ** reconnectAttempt, 8_000),
        )
      }
    }
    void connect()
    return () => {
      controller.abort()
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
    }
  }, [currentBranchId, currentConversationId])

  useEffect(() => {
    if (
      chat.connectionState !== 'invalidated' ||
      !currentConversationId
    ) {
      return
    }
    getConversationView(currentConversationId, currentBranchId || undefined)
      .then(hydrateView)
      .catch((error: Error) => {
        useChatStore.getState().setConnectionState('failed')
        notify.error('增量状态失配，重新载入失败', {
          description: error.message,
        })
      })
  }, [
    chat.connectionState,
    currentBranchId,
    currentConversationId,
    hydrateView,
  ])

  const projection = useMemo(
    () => selectProjection(chat, conversations.compactBoundaries),
    [
      chat.turnOrder,
      chat.turnsById,
      chat.runsById,
      chat.roundsById,
      chat.renderNodesById,
      conversations.compactBoundaries,
    ],
  )
  const activeTurn = selectActiveTurn(chat)

  const quotePopover = useAnswerQuote((text) => {
    setPendingQuotes((current) => {
      const trimmed = text.trim()
      if (!trimmed || current.some((item) => item.text === trimmed)) {
        return current
      }
      return [...current, { id: crypto.randomUUID(), text: trimmed }]
    })
  })

  // 浮动审批条只选择 approval；clarification 直接在过程链内回答，
  // 两者都由后端持久 Attention 事实驱动。
  const waitingApprovals = useMemo(
    () =>
      Object.values(projection.renderNodesById)
        .filter(
          (node): node is AttentionNode =>
            node.type === 'attention'
            && node.subtype === 'approval'
            && node.status === 'waiting',
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [projection.renderNodesById],
  )
  const activeCompaction = Object.values(
    conversations.compactionsById,
  ).find(
    (compaction) =>
      compaction.branchId === currentBranchId &&
      (compaction.phase === 'accepted' ||
        compaction.phase === 'running'),
  )

  const sendTurn = async (
    text: string,
    attachmentRefs: string[] = [],
    // 内联编辑重发（M7g）显式传入分叉点，绕开 setState 未提交的时序问题；
    // 常规替换流程走闭包里的 replacementTarget。
    replacement: TurnView | null = replacementTarget,
  ) => {
    if (
      replacement &&
      currentConversationId &&
      currentBranchId
    ) {
      // SSE keeps the timeline current without reloading the whole View, so
      // the summary version captured when the Turn was accepted may be stale
      // after rounds, tools, artifacts and closure events have completed.
      const sourceView = await getConversationView(
        currentConversationId,
        currentBranchId,
      )
      const created = await createBranch(
        currentConversationId,
        replacement.branchId,
        replacement.requestMessageId,
        text,
        sourceView.version,
        attachmentRefs,
      )
      setReplacementTarget(null)
      setPendingAttachments([])
      conversations.setCurrentConversation(
        currentConversationId,
        created.branchId,
      )
      hydrateView(
        await getConversationView(
          currentConversationId,
          created.branchId,
        ),
      )
      return
    }

    let conversationId = currentConversationId
    let branchId = currentBranchId
    if (!conversationId || !branchId) {
      const created = await createConversation()
      conversationId = created.conversationId
      branchId = created.rootBranchId
      conversations.upsertConversation({
        conversationId,
        title: '新对话',
        updatedAt: new Date().toISOString(),
        activeTurnCount: 0,
        version: created.version,
      })
      conversations.setCurrentConversation(conversationId, branchId)
    }
    await createTurn(conversationId, branchId, text, attachmentRefs)
    setPendingAttachments([])
    hydrateView(await getConversationView(conversationId, branchId))
  }

  const addAttachments = async (files: File[]) => {
    let conversationId = currentConversationId
    let branchId = currentBranchId
    if (!conversationId || !branchId) {
      const created = await createConversation('新对话')
      conversationId = created.conversationId
      branchId = created.rootBranchId
      conversations.upsertConversation({
        conversationId,
        title: '新对话',
        updatedAt: new Date().toISOString(),
        activeTurnCount: 0,
        version: created.version,
      })
      setDraft(`${conversationId}:${branchId}`, draft)
      conversations.setCurrentConversation(conversationId, branchId)
    }
    const remaining = Math.max(0, 16 - pendingAttachments.length)
    const selected = files.slice(0, remaining)
    try {
      for (const file of selected) {
        const uploaded = await uploadArtifact(
          conversationId,
          branchId,
          file,
        )
        setPendingAttachments((current) => [...current, uploaded])
      }
    } catch (error) {
      notify.error('附件没有完成导入', {
        description: (error as Error).message,
      })
    }
  }

  const handleAttentionAction = useCallback(async (
    node: AttentionNode,
    action: AttentionAction,
  ) => {
    try {
      if (node.subtype === 'approval' && node.approval) {
        await decideApproval(
          node.approval.approvalId,
          action.id === 'approve' ? 'approve' : 'reject',
          node.approval.version,
          node.approval.operationSnapshotHash,
        )
        notify.success(action.id === 'approve' ? '已批准，继续执行' : '已拒绝')
        return
      }
      if (node.subtype === 'clarification' && node.input) {
        await respondAttention(
          node.attentionId,
          action.id,
          node.input.version,
        )
        notify.success('已收到你的选择，继续处理')
        return
      }
      notify.warning('这类响应尚未接入')
    } catch (error) {
      notify.error('响应没有提交', {
        description: (error as Error).message,
      })
    }
  }, [])
  const handleReplaceRequest = useCallback((turn: TurnView) => {
    setReplacementTarget(turn)
    setDraft(draftKey, turn.request.text)
  }, [draftKey, setDraft])

  // 内联编辑重发：稳定引用保证 WaterfallTurn 的 memo 不被函数身份破坏；
  // 分叉点显式传参，不依赖 setReplacementTarget 的提交时序。
  const sendTurnRef = useRef(sendTurn)
  sendTurnRef.current = sendTurn
  const handleEditResend = useCallback((turn: TurnView, text: string) => {
    void sendTurnRef.current(text, [], turn)
  }, [])

  const composer = (
    <div className="relative">
      <ChildRunCapsules
        viewerRunId={viewerRunId}
        onOpen={setViewerRunId}
        onClose={() => setViewerRunId(null)}
        onAttentionAction={handleAttentionAction}
      />
      <PendingApprovalStack
        nodes={waitingApprovals}
        onDecide={handleAttentionAction}
      />
      <ComposerDock
      value={draft}
      onValueChange={(value) => setDraft(draftKey, value)}
      activeTurn={Boolean(activeTurn)}
      stopRequested={Boolean(activeTurn?.stop)}
      permissionMode={permissionMode}
      onPermissionModeChange={setPermissionMode}
      pendingSupplements={chat.pendingSupplements}
      attachments={pendingAttachments}
      onRemoveAttachment={(artifactRef) =>
        setPendingAttachments((current) =>
          current.filter((item) => item.artifactRef !== artifactRef),
        )
      }
      quotes={pendingQuotes}
      onRemoveQuote={(id) =>
        setPendingQuotes((current) =>
          current.filter((item) => item.id !== id),
        )
      }
      onClearQuotes={() => setPendingQuotes([])}
      replacementMode={
        replacementTarget
          ? {
              onCancel: () => {
                setReplacementTarget(null)
                setDraft(draftKey, '')
              },
            }
          : undefined
      }
      onCancelSupplement={async (clientRequestId) => {
        const item = useChatStore.getState().pendingSupplements.find(
          (supplement) =>
            supplement.clientRequestId === clientRequestId,
        )
        if (!item?.supplementId) return
        try {
          await cancelSupplement(item.turnId, item.supplementId)
          useChatStore.getState().cancelPendingSupplement(clientRequestId)
        } catch (error) {
          notify.error('补充内容没有撤回', {
            description: (error as Error).message,
          })
        }
      }}
      onSendTurn={sendTurn}
      onSendSupplement={async (text, attachmentRefs) => {
        if (!activeTurn) return
        const clientRequestId = chat.addPendingSupplement(
          activeTurn.turnId,
          text,
        )
        try {
          const supplement = await createSupplement(
            activeTurn.turnId,
            text,
            attachmentRefs,
          )
          setPendingAttachments([])
          useChatStore.getState().confirmPendingSupplement(
            clientRequestId,
            supplement,
          )
        } catch (error) {
          useChatStore.getState().cancelPendingSupplement(clientRequestId)
          notify.error('补充内容没有排入当前任务', {
            description: (error as Error).message,
          })
          throw error
        }
      }}
      onStop={async () => {
        if (!activeTurn) return
        try {
          const stop = await stopTurn(activeTurn.turnId)
          notify.info(
            stop.state === 'draining'
              ? '正在核验已经开始的动作'
              : '停止请求已收到',
            {
              description:
                'Iris 不会再开始新的步骤，最终状态由运行事件确认。',
            },
          )
        } catch (error) {
          notify.error('当前任务没有停止', {
            description: (error as Error).message,
          })
        }
      }}
      onAttachmentRequest={addAttachments}
      contextUsage={contextUsage}
      />
    </div>
  )

  return (
    <ConversationShell
      badge={
        <Badge appearance="outline">
          {chat.connectionState === 'connected'
            ? '本地已连接'
            : chat.connectionState === 'failed'
              ? '连接失败'
              : '正在连接'}
        </Badge>
      }
      headerActions={
        <>
          {projection.turns.length >= 8 && (
            <TurnRail
              turns={projection.turns}
              onScrollToTurn={(index) =>
                timelineRef.current?.scrollToTurn(index)
              }
            />
          )}
          {branches.length > 1 && currentBranchId && (
            <label className="relative hidden items-center sm:flex">
              <GitBranch
                aria-hidden="true"
                className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-ink-muted"
              />
              <span className="sr-only">切换对话分支</span>
              <select
                className="h-8 max-w-40 rounded-sm border border-border bg-surface-raised py-0 pl-7 pr-7 text-small text-ink shadow-hairline outline-none focus:border-border-strong focus:shadow-focus"
                value={currentBranchId}
                onChange={(event) => {
                  setReplacementTarget(null)
                  conversations.setCurrentConversation(
                    currentConversationId!,
                    event.target.value,
                  )
                }}
              >
                {branches.map((branch, index) => (
                  <option key={branch.branchId} value={branch.branchId}>
                    {branch.parentBranchId === null
                      ? '主线'
                      : `分支 ${index}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {currentConversationId &&
            currentBranchId &&
            projection.turns.length >= 6 && (
              <Button
                variant="ghost"
                size="sm"
                className="hidden sm:inline-flex"
                disabled={Boolean(activeTurn || activeCompaction)}
                isLoading={Boolean(activeCompaction)}
                loadingLabel="正在整理"
                onClick={async () => {
                  try {
                    await createCompaction(
                      currentConversationId,
                      currentBranchId,
                    )
                    notify.info('已开始整理上下文', {
                      description:
                        '完整历史仍会保留，后续对话将从新的 Context Frame 继续。',
                    })
                    hydrateView(
                      await getConversationView(
                        currentConversationId,
                        currentBranchId,
                      ),
                    )
                  } catch (error) {
                    notify.error('暂时无法整理上下文', {
                      description: (error as Error).message,
                    })
                  }
                }}
              >
                <ListRestart aria-hidden="true" className="h-4 w-4" />
                整理上下文
              </Button>
            )}
          <CapabilityCenter />
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              resolvedTheme === 'light'
                ? '切换到暗色主题'
                : '切换到亮色主题'
            }
            onClick={() =>
              setTheme(resolvedTheme === 'light' ? 'dark' : 'light')
            }
          >
            {resolvedTheme === 'light' ? (
              <Moon aria-hidden="true" className="h-4 w-4" />
            ) : (
              <Sun aria-hidden="true" className="h-4 w-4" />
            )}
          </Button>
        </>
      }
      composer={composer}
    >
      {quotePopover}
      <StallProvider>
        <TaskBlackboard tasks={Object.values(chat.tasksById)} />
        {chat.connectionState === 'hydrating' &&
        projection.turns.length === 0 ? (
          <HydrationSkeleton />
        ) : projection.turns.length > 0 ? (
          <ConversationTimeline
            ref={timelineRef}
            key={draftKey}
            projection={projection}
            hasEarlierTurns={chat.hasEarlierTurns}
            earlierLoading={earlierLoading}
            onLoadEarlier={loadEarlierTurns}
            onAttentionAction={handleAttentionAction}
            onReplaceRequest={
              activeTurn
                ? undefined
                : handleReplaceRequest
            }
            onEditResend={
              activeTurn ? undefined : handleEditResend
            }
            onOpenChildRun={setViewerRunId}
          />
        ) : (
          <main className="grid min-h-0 flex-1 place-items-center px-6 text-center">
            <div className="max-w-md animate-node-enter motion-reduce:animate-none">
              {/* 空态裸标：品牌环静置于文案之上，不脉动、不循环——它锚定的是
                  "这里是 Iris"，不是"系统在等待"。 */}
              <span
                aria-hidden="true"
                className="brand-spectrum mx-auto grid h-10 w-10 place-items-center rounded-full p-1 shadow-hairline"
              >
                <span className="h-full w-full rounded-full bg-surface-raised" />
              </span>
              <p className="mt-5 text-title font-semibold text-ink">
                想先处理什么？
              </p>
            <p className="mt-2 text-small leading-relaxed text-ink-muted">
              直接描述结果、限制和你在意的细节。Iris 会从当前能力中寻找一条可验证的路径。
            </p>
          </div>
        </main>
      )}
        <ToastHost />
        <ChildRunPanel
          runId={viewerRunId}
          onClose={() => setViewerRunId(null)}
          onAttentionAction={handleAttentionAction}
        />
      </StallProvider>
    </ConversationShell>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitBranch, ListRestart, Moon, Sun } from 'lucide-react'
import {
  cancelSupplement,
  createBranch,
  createCompaction,
  createConversation,
  createSupplement,
  createTurn,
  decideApproval,
  getConversationView,
  listConversations,
  streamConversationEvents,
  stopTurn,
  uploadArtifact,
  type ConversationView,
  type UploadedArtifact,
} from '@/api/irisApi'
import { ConversationShell } from '@/components/layout'
import { Badge, Button, ToastHost, notify } from '@/components/ui'
import type {
  AttentionAction,
  AttentionNode,
  CompactBoundaryView,
  CompactionView,
} from '@/domain/chat/models'
import type { TurnView } from '@/domain/chat/models'
import { selectActiveTurn, selectProjection } from '@/domain/chat/selectors'
import { useChatStore } from '@/stores/chatStore'
import { useConversationStore } from '@/stores/conversationStore'
import { useViewStateStore } from '@/stores/viewStateStore'
import { ComposerDock } from './composer'
import { ConversationTimeline } from './ConversationTimeline'

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
  const viewState = useViewStateStore()
  const currentConversationId = conversations.currentConversationId
  const currentBranchId = conversations.currentBranchId
  const branches = conversations.branches
  const draftKey = currentConversationId
    ? `${currentConversationId}:${currentBranchId ?? ''}`
    : 'new-conversation'
  const draft = viewState.draftsByConversationId[draftKey] ?? ''
  const [replacementTarget, setReplacementTarget] =
    useState<TurnView | null>(null)
  const [pendingAttachments, setPendingAttachments] =
    useState<UploadedArtifact[]>([])

  useEffect(() => {
    setPendingAttachments([])
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
    useConversationStore.getState().upsertConversation(summary(view))
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
      .then((view) => {
        if (!controller.signal.aborted) hydrateView(view)
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return
        useChatStore.getState().setConnectionState('failed')
        notify.error('对话恢复失败', { description: error.message })
      })
    return () => controller.abort()
  }, [currentBranchId, currentConversationId, hydrateView])

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
            if (
              event.envelope.branchId &&
              event.envelope.branchId !== currentBranchId
            ) {
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
  ) => {
    if (
      replacementTarget &&
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
        replacementTarget.branchId,
        replacementTarget.requestMessageId,
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
      const created = await createConversation(text.slice(0, 32))
      conversationId = created.conversationId
      branchId = created.rootBranchId
      conversations.upsertConversation({
        conversationId,
        title: text.slice(0, 32),
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
      viewState.setDraft(`${conversationId}:${branchId}`, draft)
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

  const handleAttentionAction = async (
    node: AttentionNode,
    action: AttentionAction,
  ) => {
    if (node.subtype !== 'approval' || !node.approval) {
      notify.warning('这类响应尚未接入')
      return
    }
    try {
      await decideApproval(
        node.approval.approvalId,
        action.id === 'approve' ? 'approve' : 'reject',
        node.approval.version,
        node.approval.operationSnapshotHash,
      )
      notify.success(action.id === 'approve' ? '已批准，继续执行' : '已拒绝')
    } catch (error) {
      notify.error('审批没有提交', {
        description: (error as Error).message,
      })
    }
  }

  const composer = (
    <ComposerDock
      value={draft}
      onValueChange={(value) => viewState.setDraft(draftKey, value)}
      activeTurn={Boolean(activeTurn)}
      stopRequested={Boolean(activeTurn?.stop)}
      permissionMode={viewState.permissionMode}
      onPermissionModeChange={viewState.setPermissionMode}
      pendingSupplements={chat.pendingSupplements}
      attachments={pendingAttachments}
      onRemoveAttachment={(artifactRef) =>
        setPendingAttachments((current) =>
          current.filter((item) => item.artifactRef !== artifactRef),
        )
      }
      replacementMode={
        replacementTarget
          ? {
              onCancel: () => {
                setReplacementTarget(null)
                viewState.setDraft(draftKey, '')
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
    />
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
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              viewState.theme === 'light'
                ? '切换到暗色主题'
                : '切换到亮色主题'
            }
            onClick={() =>
              viewState.setTheme(
                viewState.theme === 'light' ? 'dark' : 'light',
              )
            }
          >
            {viewState.theme === 'light' ? (
              <Moon aria-hidden="true" className="h-4 w-4" />
            ) : (
              <Sun aria-hidden="true" className="h-4 w-4" />
            )}
          </Button>
        </>
      }
      composer={composer}
    >
      {projection.turns.length > 0 ? (
        <ConversationTimeline
          projection={projection}
          onAttentionAction={handleAttentionAction}
          onReplaceRequest={
            activeTurn
              ? undefined
              : (turn) => {
                  setReplacementTarget(turn)
                  viewState.setDraft(draftKey, turn.request.text)
                }
          }
        />
      ) : (
        <main className="grid min-h-0 flex-1 place-items-center px-6 text-center">
          <div className="max-w-md">
            <p className="text-title font-semibold text-ink">
              想先处理什么？
            </p>
            <p className="mt-2 text-small leading-relaxed text-ink-muted">
              直接描述结果、限制和你在意的细节。Iris 会从当前能力中寻找一条可验证的路径。
            </p>
          </div>
        </main>
      )}
      <ToastHost />
    </ConversationShell>
  )
}

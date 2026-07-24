import { useEffect, useMemo } from 'react'
import { Moon, Sun } from 'lucide-react'
import type {
  AttentionAction,
  AttentionNode,
} from '@/domain/chat/models'
import { mockConversation } from '@/domain/chat/mockConversation'
import {
  selectActiveTurn,
  selectProjection,
} from '@/domain/chat/selectors'
import { ComposerDock, ConversationTimeline } from '@/components/chat'
import { ConversationShell } from '@/components/layout'
import { Badge, Button, ToastHost, notify } from '@/components/ui'
import { useChatStore } from '@/stores/chatStore'
import { useConversationStore } from '@/stores/conversationStore'
import { useViewStateStore } from '@/stores/viewStateStore'

export function WaterfallPreview() {
  const turnOrder = useChatStore((state) => state.turnOrder)
  const turnsById = useChatStore((state) => state.turnsById)
  const runsById = useChatStore((state) => state.runsById)
  const roundsById = useChatStore((state) => state.roundsById)
  const renderNodesById = useChatStore((state) => state.renderNodesById)
  const pendingSupplements = useChatStore(
    (state) => state.pendingSupplements,
  )
  const hydrateProjection = useChatStore(
    (state) => state.hydrateProjection,
  )
  const upsertTurn = useChatStore((state) => state.upsertTurn)
  const addPendingSupplement = useChatStore(
    (state) => state.addPendingSupplement,
  )
  const cancelPendingSupplement = useChatStore(
    (state) => state.cancelPendingSupplement,
  )

  const compactBoundaries = useConversationStore(
    (state) => state.compactBoundaries,
  )
  const currentConversationId = useConversationStore(
    (state) => state.currentConversationId,
  )
  const hydrateConversation = useConversationStore(
    (state) => state.hydratePreview,
  )

  const theme = useViewStateStore((state) => state.theme)
  const setTheme = useViewStateStore((state) => state.setTheme)
  const permissionMode = useViewStateStore(
    (state) => state.permissionMode,
  )
  const setPermissionMode = useViewStateStore(
    (state) => state.setPermissionMode,
  )
  const draftsByConversationId = useViewStateStore(
    (state) => state.draftsByConversationId,
  )
  const setDraft = useViewStateStore((state) => state.setDraft)
  const seedExpandedNodes = useViewStateStore(
    (state) => state.seedExpandedNodes,
  )

  const draftKey = currentConversationId ?? 'preview'
  const draft = draftsByConversationId[draftKey] ?? ''
  const chatState = useMemo(
    () => ({
      turnOrder,
      turnsById,
      runsById,
      roundsById,
      renderNodesById,
    }),
    [renderNodesById, roundsById, runsById, turnOrder, turnsById],
  )
  const projection = useMemo(
    () =>
      selectProjection(
        {
          ...useChatStore.getState(),
          ...chatState,
        },
        compactBoundaries,
      ),
    [chatState, compactBoundaries],
  )
  const activeTurn = selectActiveTurn(useChatStore.getState())

  useEffect(() => {
    hydrateProjection(mockConversation)
    hydrateConversation(mockConversation, {
      conversationId: 'conversation-preview',
      title: '杭州行程与网申',
      updatedAt: '2026-07-24T18:30:00+08:00',
      activeTurnCount: 1,
    })
    seedExpandedNodes(
      Object.values(mockConversation.renderNodesById)
        .filter(
          (node) =>
            (node.type === 'attention' && node.status === 'waiting') ||
            node.status === 'failed' ||
            node.status === 'outcome_unknown',
        )
        .map((node) => node.nodeId),
    )
  }, [hydrateConversation, hydrateProjection, seedExpandedNodes])

  const handleAttentionAction = (
    node: AttentionNode,
    action: AttentionAction,
  ) => {
    notify.info(`演示动作：${action.label}`, {
      description: `未向后端发送决定；Attention ${node.attentionId} 仍保持等待。`,
    })
  }

  const composer = (
    <ComposerDock
        value={draft}
        onValueChange={(value) => setDraft(draftKey, value)}
        activeTurn={Boolean(activeTurn)}
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
        pendingSupplements={pendingSupplements}
        onCancelSupplement={(clientRequestId) => {
          cancelPendingSupplement(clientRequestId)
          notify.success('补充已撤回', {
            description: '演示状态中尚未注入，因此可以安全撤回。',
          })
        }}
        onSendTurn={(text) => {
          const latestTurn = turnsById[turnOrder[turnOrder.length - 1]]
          if (latestTurn) {
            upsertTurn({
              ...latestTurn,
              phase: 'active',
              version: latestTurn.version + 1,
            })
          }
          notify.success('新任务已在本地演示中接受', {
            description: text,
          })
        }}
        onSendSupplement={(text) => {
          addPendingSupplement(text)
          notify.info('补充正在等待安全边界', {
            description: '只有后端 SSE 才能确认它已经注入。',
          })
        }}
        onStop={() => {
          if (activeTurn) {
            upsertTurn({
              ...activeTurn,
              phase: 'stopped',
              version: activeTurn.version + 1,
            })
          }
          notify.warning('已提交停止意图', {
            description: '待送入的补充仍被保留，不会自动重发。',
          })
        }}
        onAttachmentRequest={() =>
          notify.info('附件入口尚未接入', {
            description: '节点 1.3 只保留视觉入口，不读取本地文件。',
          })
        }
      />
  )

  return (
    <ConversationShell
      badge={<Badge appearance="outline">大陆 1 · Preview</Badge>}
      headerActions={
        <>
          <Button
            variant="ghost"
            size="sm"
            className="hidden sm:inline-flex"
            onClick={() => {
              const latestTurn =
                turnsById[turnOrder[turnOrder.length - 1]]
              if (!latestTurn) return
              upsertTurn({
                ...latestTurn,
                phase: activeTurn ? 'settled' : 'active',
                version: latestTurn.version + 1,
              })
            }}
          >
            {activeTurn ? '切换到空闲态' : '模拟运行态'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              theme === 'light' ? '切换到暗色主题' : '切换到亮色主题'
            }
            onClick={() => {
              const nextTheme = theme === 'light' ? 'dark' : 'light'
              setTheme(nextTheme)
            }}
          >
            {theme === 'light' ? (
              <Moon aria-hidden="true" className="h-4 w-4" />
            ) : (
              <Sun aria-hidden="true" className="h-4 w-4" />
            )}
          </Button>
        </>
      }
      composer={composer}
    >
      <ConversationTimeline
        projection={projection}
        onAttentionAction={handleAttentionAction}
      />
      <ToastHost />
    </ConversationShell>
  )
}

/**
 * BoardPanel — 进展黑板（P1，蓝图 v13 四段：目标 / 已确认 / 待办 / 产物）
 *
 * 数据源：boardStore（目标/已确认/待办三段唯一事实源）+ artifactDockStore（产物段）。
 * - 用户所有行内编辑经 applyUserEdit(convId, edit) 走 store（who='me' + userDirty 置位），
 *   编辑随下一条用户消息经 trailingMeta 告知模型。
 * - 产物删除直接调 useArtifactDockStore.getState().removeArtifact(id)。
 * - 产物打开复用预览坞统一打开路径（FileCard / RecentStrip 同款：open(id, 'preview')）。
 *
 * 交互行统一加 .wf-press（全站点击下沉反馈）；颜色只走 var(--wf-*) 主题变量。
 */

import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Check, FileText } from 'lucide-react'
import { useConversationStore } from '@/stores/conversationStore'
import { useBoardStore, type BoardWho, type BoardUserEdit } from '@/stores/boardStore'
import { useArtifactDockStore } from '@/stores/artifactDockStore'
import { cn } from '@/utils'

/** 来源标注：me=你 / ai=AI（模型整理）；缺省按 AI 处理 */
function WhoTag({ who }: { who?: BoardWho }) {
  const { t } = useTranslation()
  return (
    <span className="wf-board-who">
      {who === 'me' ? t('chat.board.youTag') : t('chat.board.aiTag')}
    </span>
  )
}

/**
 * 行内编辑器：未编辑时渲染文本（空值渲染 muted 占位符），点击进入 input。
 * Enter / blur 提交（内容未变不提交），Esc 取消不提交。
 */
function InlineEditor({
  value,
  onCommit,
  placeholder,
}: {
  value: string
  onCommit: (text: string) => void
  placeholder?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const cancelled = useRef(false)

  const start = () => {
    setDraft(value)
    cancelled.current = false
    setEditing(true)
  }
  const commit = () => {
    if (cancelled.current) return
    const next = draft.trim()
    if (next !== value.trim()) onCommit(next)
    setEditing(false)
  }
  const cancel = () => {
    cancelled.current = true
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        className="wf-board-input"
        value={draft}
        placeholder={placeholder}
        autoFocus
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
        onBlur={commit}
      />
    )
  }
  return (
    <span
      className={cn('wf-board-tx', !value && 'wf-board-tx-empty')}
      onClick={start}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          start()
        }
      }}
    >
      {value || placeholder}
    </span>
  )
}

/** 段尾追加行：+ 输入框，Enter 提交（提交后清空） */
function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (text: string) => void }) {
  const [v, setV] = useState('')
  const submit = () => {
    const next = v.trim()
    if (next) {
      onAdd(next)
      setV('')
    }
  }
  return (
    <div className="wf-board-add">
      <span className="wf-board-add-plus">+</span>
      <input
        className="wf-board-input"
        placeholder={placeholder}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
      />
    </div>
  )
}

export function BoardPanel() {
  const { t } = useTranslation()
  const convIdNum = useConversationStore((s) => s.currentConversationId)
  const convId = convIdNum == null ? '' : String(convIdNum)
  const board = useBoardStore((s) => (convId ? s.byConv[convId] : undefined))
  const prodIds = useArtifactDockStore((s) => s.artifactOrder)
  const artifacts = useArtifactDockStore((s) => s.artifacts)

  const goal = board?.goal ?? ''
  const facts = board?.facts ?? []
  const todos = board?.todos ?? []
  const who = board?.who ?? {}

  const apply = (edit: BoardUserEdit) => {
    if (convId) useBoardStore.getState().applyUserEdit(convId, edit)
  }

  const hasContent = Boolean(goal || facts.length > 0 || todos.length > 0 || prodIds.length > 0)
  if (!hasContent) {
    return (
      <div className="wf-board-empty">
        <span>{t('chat.board.emptyHint')}</span>
      </div>
    )
  }

  return (
    <div className="wf-board">
      {/* 目标 */}
      <section className="wf-board-sec">
        <h4 className="wf-board-sec-t">{t('chat.board.goal')}</h4>
        <div className="wf-board-row wf-press">
          <InlineEditor
            value={goal}
            placeholder={t('chat.board.goalPlaceholder')}
            onCommit={(text) => apply({ kind: 'goal', value: text })}
          />
          {goal ? <WhoTag who={who.goal} /> : null}
        </div>
      </section>

      {/* 已确认 */}
      <section className="wf-board-sec">
        <h4 className="wf-board-sec-t">{t('chat.board.facts')}</h4>
        {facts.map((f) => (
          <div key={f.id} className="wf-board-row wf-press">
            <InlineEditor value={f.text} onCommit={(text) => apply({ kind: 'fact-edit', id: f.id, text })} />
            <WhoTag who={who[f.id]} />
            <button
              type="button"
              className="wf-board-del"
              title={t('chat.board.removeFact')}
              aria-label={t('chat.board.removeFact')}
              onClick={() => apply({ kind: 'fact-del', id: f.id })}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <AddRow
          placeholder={t('chat.board.factPlaceholder')}
          onAdd={(text) => apply({ kind: 'fact-add', text })}
        />
      </section>

      {/* 待办 */}
      <section className="wf-board-sec">
        <h4 className="wf-board-sec-t">{t('chat.board.todos')}</h4>
        {todos.map((td) => {
          const done = td.status === 'completed'
          return (
            <div key={td.id} className={cn('wf-board-row wf-press', done && 'wf-board-todo-done')}>
              <button
                type="button"
                role="checkbox"
                aria-checked={done}
                className={cn('wf-board-check wf-press', done && 'checked')}
                onClick={() => apply({ kind: 'todo-toggle', id: td.id })}
              >
                {done && <Check size={10} strokeWidth={3.5} />}
              </button>
              <InlineEditor
                value={td.content}
                onCommit={(text) => apply({ kind: 'todo-edit', id: td.id, content: text })}
              />
              <WhoTag who={who[td.id]} />
              <button
                type="button"
                className="wf-board-del"
                title={t('chat.board.removeTodo')}
                aria-label={t('chat.board.removeTodo')}
                onClick={() => apply({ kind: 'todo-del', id: td.id })}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
        <AddRow
          placeholder={t('chat.board.todoPlaceholder')}
          onAdd={(text) => apply({ kind: 'todo-add', content: text })}
        />
      </section>

      {/* 产物：仅当前会话有产物时渲染（dock 状态本身就是会话级的，clearConversation 即清空） */}
      {prodIds.length > 0 && (
        <section className="wf-board-sec">
          <h4 className="wf-board-sec-t">{t('chat.board.prods')}</h4>
          {prodIds.map((id) => {
            const a = artifacts[id]
            if (!a) return null
            return (
              <div
                key={id}
                className="wf-board-row wf-press wf-board-prod"
                role="button"
                tabIndex={0}
                onClick={() => useArtifactDockStore.getState().open(id, 'preview')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    useArtifactDockStore.getState().open(id, 'preview')
                  }
                }}
              >
                <span className="wf-board-prod-ic">
                  <FileText size={12} />
                </span>
                <span className="wf-board-tx">{a.caption || a.fileName}</span>
                <span className="wf-board-prod-go">→</span>
                <button
                  type="button"
                  className="wf-board-del"
                  title={t('chat.board.removeProd')}
                  aria-label={t('chat.board.removeProd')}
                  onClick={(e) => {
                    e.stopPropagation()
                    useArtifactDockStore.getState().removeArtifact(id)
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}

import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { useFileStore } from '@/stores/fileStore'
import { useSkillStore } from '@/stores/skillStore'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { ChatWidth } from '@/stores/settingsStore'
import type { ExecutionMode } from '@/agent/types'
import type { SlashCommand } from '@/agent/commands/types'
import { FileAttachmentBar } from './FileAttachmentBar'
import { FileDropZone } from './FileDropZone'
import { FilePermissionModal } from './FilePermissionModal'
import { PptTemplateSelector } from './PptTemplateSelector'
import { SlashMenu } from './SlashMenu'
import { ComposerTray } from './ComposerTray'
import { ComposerRibbon } from './ComposerRibbon'
import { CompactBar } from './CompactBar'
import { isPptTriggerMessage, PPT_SKILL_ID } from '@/data/pptTemplates'
import { Send, Square, Paperclip } from 'lucide-react'

interface InputAreaProps {
  onSend: (content: string, attachmentIds?: string[]) => void
  onStop: () => void
  isLoading: boolean
  isStreaming: boolean
  disabled?: boolean
  onNavigate?: (view: string) => void
  /** 过程中补充：用户在中途输入的新指令，在当前 turn 步骤间隙注入模型上下文 */
  onSendSupplement?: (text: string) => void
  /** 选中引用（v9 quote chip）：发送时以「引用」前缀拼入消息体 */
  quote?: string | null
  onClearQuote?: () => void
}

export const PERMISSION_MODE_OPTIONS: Array<{ value: ExecutionMode; labelKey: string; fallback: string; descFallback: string }> = [
  // 文案与 toolExecutor/checkToolPermissions 的实际语义严格对齐（2026-07-24 审批审计）：
  // - bypass：read_only/standard/elevated 全放行；仅保留底线确认（SQL 写、destructive、项目首写）
  // - auto：read_only/standard（本地可逆写，如 workspace 文件）放行；elevated/destructive 确认
  // - confirm：一切调用都确认（含只读）
  // - sandbox：一切非只读直接拒绝（不询问）
  { value: 'bypass', labelKey: 'chat.inputArea.permissionBypass', fallback: '全部自动', descFallback: 'SQL 写等底线仍确认' },
  { value: 'auto', labelKey: 'chat.inputArea.permissionAuto', fallback: '高风险确认', descFallback: '常规自动 · 高风险确认' },
  { value: 'confirm', labelKey: 'chat.inputArea.permissionConfirm', fallback: '全部确认', descFallback: '每步都确认' },
  { value: 'sandbox', labelKey: 'chat.inputArea.permissionSandbox', fallback: '沙箱禁写', descFallback: '只读运行' },
]

/** 权限模式控件（v9.1 重设计）：mono 小按钮 + 弹出项，中性色、与 hintbar 宽度档位同一视觉语言；
 * Shift+Tab 在输入框内可快速循环切换 */
function PermissionModeSelect() {
  const { t } = useTranslation()
  const sessionMode = useChatStore((s) => s.permissionMode)
  const setSessionMode = useChatStore((s) => s.setPermissionMode)
  const globalMode = useSettingsStore((s) => s.permissionMode)
  const value = sessionMode ?? globalMode
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 点击外部收起
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current = PERMISSION_MODE_OPTIONS.find((o) => o.value === value) ?? PERMISSION_MODE_OPTIONS[1]

  return (
    <div className="wf-perm" ref={wrapRef}>
      <button
        type="button"
        className="wf-perm-btn"
        data-mode={value}
        onClick={() => setOpen((o) => !o)}
        title={t('chat.inputArea.permissionModeTitle', {
          defaultValue: '权限模式（Shift+Tab 快速切换）',
        })}
      >
        <span className="pd" />
        {t(current.labelKey, { defaultValue: current.fallback })}
      </button>
      {open && (
        <div className="wf-perm-pop">
          {PERMISSION_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`wf-perm-item${opt.value === value ? ' on' : ''}`}
              onClick={() => {
                setSessionMode(opt.value)
                setOpen(false)
              }}
            >
              <span className="dot" />
              {t(opt.labelKey, { defaultValue: opt.fallback })}
              <span className="pm-desc">{opt.descFallback}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 对话列宽档位（v9 hintbar）：写入 settingsStore，由 ChatView 应用到 --wf-col-max */
const CHAT_WIDTHS: ChatWidth[] = [680, 780, 960]

/** 单行斜杠输入检测：仅整行以 / 开头且无空格时唤起菜单（修复旧版锁死回车） */
const SLASH_RE = /^\/([\w\-一-龥]*)$/

export function InputArea({ onSend, onStop, isLoading, isStreaming, disabled, onSendSupplement, quote, onClearQuote }: InputAreaProps) {
  const { t } = useTranslation()
  const [content, setContent] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [topCandidate, setTopCandidate] = useState<SlashCommand | null>(null)
  const [isComposing, setIsComposing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropCounter = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // v9 自然过渡：运行满 5s 后才把 placeholder/提示切到「可补充」态——
  // 用户感知到"任务跑了一会儿了，可以补充"，替代强弹窗引导（时间维度的无声提示）
  const [supplementReady, setSupplementReady] = useState(false)
  useEffect(() => {
    if (!isStreaming) {
      setSupplementReady(false)
      return
    }
    const timer = setTimeout(() => setSupplementReady(true), 5000)
    return () => clearTimeout(timer)
  }, [isStreaming])

  // 把 composer 实际高度同步到 CSS 变量，供 MessageList / jump pill 使用
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height
        document.documentElement.style.setProperty('--wf-input-bar-height', `${Math.ceil(h)}px`)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { pendingAttachments, addPendingFiles } = useFileStore()
  const { skills, activeSkillIds, init: initSkills } = useSkillStore()
  const queueMessage = useChatStore((s) => s.queueMessage)
  const popLastQueued = useChatStore((s) => s.popLastQueued)
  const hasQueued = useChatStore((s) => s.queuedMessages.length > 0)
  const currentContextTokens = useChatStore((s) => s.currentContextTokens)
  const contextWindowSize = useChatStore((s) => s.contextWindowSize)
  const chatWidth = useSettingsStore((s) => s.chatWidth)
  const setChatWidth = useSettingsStore((s) => s.setChatWidth)
  const { pptTemplateSelection, requestPptTemplateSelection, confirmPptTemplateSelection, cancelPptTemplateSelection } = useChatStore()

  // 确保 Skill 列表已被加载（斜杠菜单的 Skill 命令与关键词触发都依赖它）
  useEffect(() => {
    if (skills.length === 0) {
      initSkills()
    }
  }, [skills.length, initSkills])

  const showSlashMenu = slashQuery !== null && !disabled && !isLoading

  // 幽灵补全：首候选命令名的剩余部分 + 参数提示
  const ghost = (() => {
    if (!showSlashMenu || !topCandidate || slashQuery === null) return ''
    const name = topCandidate.name
    const remainder = name.toLowerCase().startsWith(slashQuery.toLowerCase())
      ? name.slice(slashQuery.length)
      : ''
    const hint = topCandidate.argumentHint ? ` ${topCandidate.argumentHint}` : ''
    const g = remainder + hint
    return g.trim() ? g : ''
  })()

  /** 发送（空闲）：PPT 触发检测 → onSend；引用随消息拼出 */
  const handleSend = useCallback(async () => {
    const trimmed = content.trim()
    if (!trimmed && pendingAttachments.length === 0) return
    if (isLoading) return

    // 如果 Skill 列表尚未加载，先初始化，否则关键词触发和模板选择不会生效
    if (skills.length === 0) {
      await initSkills()
    }

    const attachmentIds = pendingAttachments.map((a) => a.id)

    // 检测是否需要 PPT 模板选择：消息内容包含 PPT 关键词且 pptx-presentation skill 已启用
    const isPptSkillAvailable = activeSkillIds.includes(PPT_SKILL_ID) ||
      skills.some((s) => s.id === PPT_SKILL_ID && s.enabled)

    const quoted = quote ? `「${quote.slice(0, 500)}」\n\n${trimmed}` : trimmed

    if (isPptTriggerMessage(trimmed) && isPptSkillAvailable) {
      requestPptTemplateSelection(quoted, attachmentIds.length > 0 ? attachmentIds : undefined)
      setContent('')
      setSlashQuery(null)
      onClearQuote?.()
      return
    }

    onSend(quoted, attachmentIds.length > 0 ? attachmentIds : undefined)
    setContent('')
    setSlashQuery(null)
    onClearQuote?.()
    // pending files 由 chatStore.sendMessage → commitPendingFiles 统一提交并移除
  }, [content, isLoading, onSend, pendingAttachments, activeSkillIds, skills, requestPptTemplateSelection, initSkills, quote, onClearQuote])

  /** 运行中发送（Enter / Ctrl+Enter 同语义，claude-code 队列模型）：
   * 消息在下一个 loop 边界（阶段结论后、下次调用前）作为用户消息进入上下文，
   * 渲染为对应轮次段之后的补充气泡；若没等到边界 turn 就结束了，则作为新 turn 发出。 */
  const handleSendSupplement = useCallback(() => {
    const trimmed = content.trim()
    if (!trimmed) return
    if (isStreaming) {
      onSendSupplement?.(quote ? `「${quote.slice(0, 500)}」\n\n${trimmed}` : trimmed)
      onClearQuote?.()
    } else {
      handleSend()
      return
    }
    setContent('')
    setSlashQuery(null)
  }, [content, isStreaming, onSendSupplement, quote, onClearQuote, handleSend])

  /** 斜杠菜单：执行命令（无参 Enter / 点击） */
  const handleExecuteCommand = useCallback(
    (cmd: SlashCommand) => {
      setContent('')
      setSlashQuery(null)
      const text = `/${cmd.name}`
      if (isStreaming) queueMessage(text)
      else onSend(text)
    },
    [isStreaming, queueMessage, onSend]
  )

  /** 斜杠菜单：补全命令名到输入框（Tab / 有参 Enter） */
  const handleCompleteCommand = useCallback((cmd: SlashCommand) => {
    setContent(`/${cmd.name} `)
    setSlashQuery(null)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.selectionStart = el.selectionEnd = el.value.length
      }
    })
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // 输入法组合期间不拦截任何键（中文 Enter 选词）
      if (isComposing) return
      // 斜杠菜单打开时的 ↑↓/Tab/Enter/Esc 由 SlashMenu 在 window capture 阶段拦截

      // Shift+Tab：循环切换权限模式（嵌入对话框的模式快捷切换，claude-code 式）
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        const order = PERMISSION_MODE_OPTIONS.map((o) => o.value)
        const st = useChatStore.getState()
        const cur = st.permissionMode ?? useSettingsStore.getState().permissionMode
        const next = order[(order.indexOf(cur) + 1) % order.length]
        st.setPermissionMode(next)
        return
      }

      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (showSlashMenu) return // 菜单 Enter 已处理
        e.preventDefault()
        // 运行中 Enter = 中途补充（下一个 loop 边界进入上下文）；空闲 Enter = 发送
        if (isStreaming) handleSendSupplement()
        else handleSend()
        return
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        handleSendSupplement()
        return
      }
      // 空输入 + 有排队：↑ 拉回最后一条排队消息（claude-code popAllEditable 单条版）
      if (e.key === 'ArrowUp' && !content && hasQueued && !showSlashMenu) {
        e.preventDefault()
        const text = popLastQueued()
        if (text) {
          setContent(text)
          requestAnimationFrame(() => {
            const el = textareaRef.current
            if (el) el.selectionStart = el.selectionEnd = el.value.length
          })
        }
      }
    },
    [isComposing, showSlashMenu, isStreaming, handleSend, handleSendSupplement, content, hasQueued, popLastQueued]
  )

  const handleInput = useCallback(() => {
    const val = textareaRef.current?.value ?? ''
    const m = val.match(SLASH_RE)
    setSlashQuery(m ? m[1] : null)
  }, [])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setContent(e.target.value)
      handleInput()
    },
    [handleInput]
  )

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        await addPendingFiles(Array.from(files))
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    },
    [addPendingFiles]
  )

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dropCounter.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dropCounter.current--
    if (dropCounter.current === 0) {
      setIsDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      dropCounter.current = 0
      setIsDragOver(false)

      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) {
        await addPendingFiles(files)
      }
    },
    [addPendingFiles]
  )

  // 简洁 placeholder（v9：不可用项已移除）
  // 运行满 5s 才切「排队/补充」文案（自然过渡）；前 5s 保持常态，避免跳变干扰
  const placeholder = disabled
    ? t('chat.inputArea.loginRequired')
    : isStreaming && supplementReady
      ? t('chat.inputArea.queuePlaceholder', { defaultValue: '输入补充，将在下一步送入当前任务…' })
      : t('chat.inputArea.inputHint')

  // hintbar 左侧（v9.3 引导融入式设计）：空闲时不显示任何快捷键说明——
  // 引导靠 placeholder 与交互本身传达；只有运行进入可补充态时才浮现一句当期有用的提示
  const hintKey = !isStreaming ? 'idle' : supplementReady ? 'ready' : 'starting'
  const hintText = !isStreaming
    ? ''
    : supplementReady
      ? t('chat.inputArea.hintbarReady', { defaultValue: '输入补充，Enter 将在下一步送入' })
      : t('chat.inputArea.hintbarStarting', { defaultValue: '任务执行中…' })

  // 上下文水位（hintbar 右侧）
  // 大窗口模型（如 kimi-for-coding 256K）下小会话 round 后恒为 0%，
  // 有 token 时至少显示 1%，避免"统计坏了"的错觉（2026-07-24）
  const ctxPct =
    contextWindowSize > 0 && currentContextTokens > 0
      ? Math.max(1, Math.min(100, Math.round((currentContextTokens / contextWindowSize) * 100)))
      : 0

  return (
    <div
      ref={containerRef}
      className={`wf-input-bar${isStreaming ? ' running' : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <FileDropZone isVisible={isDragOver} />
      <FilePermissionModal />

      <div className="wf-input-inner">
        {/* 排队 / 待注入 chips */}
        <ComposerTray />

        {/* 运行状态缎带 */}
        <ComposerRibbon />

        {/* 压缩进度条（v9.2：手动/自动压缩共用，完成自动淡出） */}
        <CompactBar />

        {/* 引用 chip（v9：选中正文引用到输入框） */}
        {quote && (
          <div className="wf-quote-att">
            <span>❝</span>
            <span className="qa-t" title={quote}>{quote.length > 72 ? quote.slice(0, 72) + '…' : quote}</span>
            <button type="button" className="qa-x" onClick={onClearQuote}>✕</button>
          </div>
        )}

        <div className="wf-input-bubble" data-state={isStreaming ? 'running' : undefined}>
          {/* File attachment bar */}
          <FileAttachmentBar />

          {/* PPT Template Selector */}
          {pptTemplateSelection?.isPending && (
            <PptTemplateSelector
              onSelect={(templateId) => confirmPptTemplateSelection(templateId)}
              onCancel={() => cancelPptTemplateSelection()}
            />
          )}

          {/* Slash 命令菜单（v9：过滤/分组/频率排序） */}
          {showSlashMenu && slashQuery !== null && (
            <SlashMenu
              query={slashQuery}
              onExecute={handleExecuteCommand}
              onComplete={handleCompleteCommand}
              onClose={() => setSlashQuery(null)}
              onTopCandidateChange={setTopCandidate}
            />
          )}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="*/*"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Input row：cp-mirror（幽灵补全）+ textarea + 控件 + 圆形发送/停止按钮 */}
          <div className="wf-composer-row">
            <div className="wf-cp-wrap">
              <div className="wf-cp-mirror" aria-hidden="true">
                {content}
                {ghost && <span className="wf-cp-ghost">{ghost}</span>}
                {'​'}
              </div>
              <textarea
                ref={textareaRef}
                value={content}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onInput={handleInput}
                onCompositionStart={() => setIsComposing(true)}
                onCompositionEnd={(e) => {
                  setIsComposing(false)
                  handleInput()
                  // 某些输入法组合结束后不会触发 onChange，手动同步
                  setContent(e.currentTarget.value)
                }}
                placeholder={placeholder}
                disabled={disabled || (isLoading && !isStreaming) || !!pptTemplateSelection?.isPending}
                rows={1}
              />
            </div>

            {/* 辅助控件：权限模式 + 文件上传（融入胶囊风格） */}
            <PermissionModeSelect />

            {/* File upload button */}
            <button
              onClick={handleFileSelect}
              disabled={disabled || (isLoading && !isStreaming)}
              className={cn(
                'h-9 w-9 flex items-center justify-center rounded-lg transition-colors flex-shrink-0',
                disabled || isLoading
                  ? 'text-surface-300 cursor-not-allowed'
                  : 'text-surface-400 hover:text-surface-600'
              )}
              title={t('chat.inputArea.uploadFile')}
            >
              <Paperclip size={16} />
            </button>

            {/* Send / Stop 按钮组（运行中发送=中途补充，Enter 同语义） */}
            {isStreaming ? (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  onClick={handleSendSupplement}
                  disabled={!content.trim()}
                  className="wf-send-btn"
                  title={t('chat.inputArea.supplementTitle', { defaultValue: '补充到当前任务，下一步送入（Enter）' })}
                  aria-label={t('chat.inputArea.supplementTitle', { defaultValue: '补充到当前任务，下一步送入（Enter）' })}
                >
                  <Send size={14} />
                </button>
                <button
                  onClick={onStop}
                  className="wf-send-btn stop"
                  title={t('chat.inputArea.stopGeneration')}
                  aria-label={t('chat.inputArea.stopGeneration')}
                >
                  <Square size={14} />
                </button>
              </div>
            ) : (
              <button
                onClick={handleSend}
                disabled={!content.trim() && pendingAttachments.length === 0 || isLoading || disabled || !!pptTemplateSelection?.isPending}
                className="wf-send-btn"
                title={t('chat.inputArea.send')}
                aria-label={t('chat.inputArea.send')}
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>

        {/* 提示条（v9 hintbar）：左侧快捷键 · 右侧上下文水位 + 宽度档位 */}
        <div className="wf-hintbar">
          <span key={hintKey} className="hb-l wf-hint-swap">{hintText}</span>
          <span className={`ctx${ctxPct > 70 ? ' warn' : ''}`}>
            {t('chat.inputArea.hintbarCtx', { defaultValue: '上下文' })} {ctxPct}%
            <span className="ctxbar"><i style={{ width: `${ctxPct}%` }} /></span>
          </span>
          <span className="widths">
            {CHAT_WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                className={chatWidth === w ? 'on' : ''}
                onClick={() => setChatWidth(w)}
              >
                {w}
              </button>
            ))}
          </span>
        </div>
      </div>
    </div>
  )
}

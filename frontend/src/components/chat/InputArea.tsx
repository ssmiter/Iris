import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { useFileStore } from '@/stores/fileStore'
import { useSkillStore } from '@/stores/skillStore'
import { useChatStore } from '@/stores/chatStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useCorridorStore } from '@/stores/corridorStore'
import type { ChatWidth } from '@/stores/settingsStore'
import type { ExecutionMode } from '@/agent/types'
import type { SlashCommand } from '@/agent/commands/types'
import { FileAttachmentBar } from './FileAttachmentBar'
import { FileDropZone } from './FileDropZone'
import { FilePermissionModal } from './FilePermissionModal'
import { SlashMenu } from './SlashMenu'
import { ComposerTray } from './ComposerTray'
import { SubAgentCapsules } from './SubAgentCapsules'
import { CompactBar } from './CompactBar'
import { Send, Square, Paperclip, UnfoldHorizontal, Sparkles } from 'lucide-react'
import {
  effortLevelsForModel,
  modelSupportsEffort,
  resolveUserEffort,
  setUserEffort,
} from '@/services/modelCapabilityRegistry'

interface InputAreaProps {
  onSend: (content: string, attachmentIds?: string[]) => void
  onStop: () => void
  isLoading: boolean
  isStreaming: boolean
  disabled?: boolean
  /** 过程中补充：用户在中途输入的新指令，在当前 turn 步骤间隙注入模型上下文 */
  onSendSupplement?: (text: string) => void
  /** 选中引用（v9 quote chip）：发送时以「引用」前缀拼入消息体 */
  quote?: string | null
  onClearQuote?: () => void
}

export const PERMISSION_MODE_OPTIONS: Array<{ value: ExecutionMode; labelKey: string; descKey: string; fallback: string; descFallback: string }> = [
  // 文案与 toolExecutor/checkToolPermissions 的实际语义严格对齐（2026-07-24 审批审计）：
  // - bypass：read_only/standard/elevated 全放行；仅保留底线确认（SQL 写、destructive、项目首写）
  // - auto：read_only/standard（本地可逆写，如 workspace 文件）放行；elevated/destructive 确认
  // - confirm：一切调用都确认（含只读）
  // - sandbox：一切非只读直接拒绝（不询问）
  { value: 'bypass', labelKey: 'chat.inputArea.permissionBypass', descKey: 'chat.inputArea.permissionBypassDesc', fallback: '全部自动', descFallback: 'SQL 写等底线仍确认' },
  { value: 'auto', labelKey: 'chat.inputArea.permissionAuto', descKey: 'chat.inputArea.permissionAutoDesc', fallback: '高风险确认', descFallback: '常规自动 · 高风险确认' },
  { value: 'confirm', labelKey: 'chat.inputArea.permissionConfirm', descKey: 'chat.inputArea.permissionConfirmDesc', fallback: '全部确认', descFallback: '每步都确认' },
  { value: 'sandbox', labelKey: 'chat.inputArea.permissionSandbox', descKey: 'chat.inputArea.permissionSandboxDesc', fallback: '沙箱禁写', descFallback: '只读运行' },
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
        title={t('chat.inputArea.permissionModeTitle')}
      >
        <span className="pd" />
        {t(current.labelKey)}
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
              {t(opt.labelKey)}
              <span className="pm-desc">{t(opt.descKey)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 对话列宽档位（v9 hintbar）：写入 settingsStore，由 ChatView 应用到 --wf-col-max */
const CHAT_WIDTHS: ChatWidth[] = [680, 780, 960]

/** 芽轨弹窗的点击外部收起（PermissionModeSelect 同款） */
function usePopClose(open: boolean, wrapRef: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, wrapRef, close])
}

/**
 * 芽轨下行操作项：思考强度（2026-09-07 从顶栏 provider 下拉迁入）。
 * 仅声明支持的模型在场；选项窗复用权限模式弹窗语言（wf-perm-pop）。
 * 与设置页供应商卡片的 effort 分段是同一注册表键（provider+model）：
 * 设置页=预先默认配置，这里=对话中实时覆盖（下一次请求即生效）。
 */
function EffortRailSelect() {
  const { t } = useTranslation()
  const activeProvider = useChatStore((s) => s.activeProvider)
  const [open, setOpen] = useState(false)
  // 能力注册表是 localStorage 持久化（非响应式），选择后 tick 触发重渲染
  const [, setTick] = useState(0)
  const wrapRef = useRef<HTMLSpanElement>(null)
  usePopClose(open, wrapRef, useCallback(() => setOpen(false), []))

  // 不支持的模型不渲染（对齐 CC：不声明不显示不发送，避免把参数发给不认它的上游）
  if (!activeProvider || !modelSupportsEffort(activeProvider.provider, activeProvider.model)) {
    return null
  }
  const current = resolveUserEffort(activeProvider.provider, activeProvider.model)
  const levels = effortLevelsForModel(activeProvider.model)
  const levelLabel = (level: (typeof levels)[number] | undefined) =>
    level ? t(`chat.chatView.effort.${level}`) : t('chat.chatView.effort.default')
  const title = t('chat.inputArea.effortTitle', { level: levelLabel(current) })

  return (
    <span className="wf-rail-op" ref={wrapRef}>
      <button
        type="button"
        className={cn('wf-rail-opbtn', current && 'on')}
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-label={title}
      >
        <Sparkles size={15} />
      </button>
      {open && (
        <div className="wf-perm-pop wf-rail-pop">
          {([undefined, ...levels] as const).map((level) => (
            <button
              key={level ?? 'default'}
              type="button"
              className={`wf-perm-item${current === level ? ' on' : ''}`}
              onClick={() => {
                setUserEffort(activeProvider.provider, activeProvider.model, level ?? null)
                setTick((v) => v + 1)
                setOpen(false)
              }}
            >
              <span className="dot" />
              {levelLabel(level)}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/** 芽轨下行操作项：对话列宽。原"点击盲轮换"改为选项弹窗（两行约定：下行件点击弹窗，
    档位标签直接可见，不用记轮换顺序） */
function WidthRailSelect() {
  const { t } = useTranslation()
  const chatWidth = useSettingsStore((s) => s.chatWidth)
  const setChatWidth = useSettingsStore((s) => s.setChatWidth)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  usePopClose(open, wrapRef, useCallback(() => setOpen(false), []))

  const title = t('chat.inputArea.widthCycleTitle', { width: chatWidth })
  const widthLabels = [
    t('chat.inputArea.widthCompact'),
    t('chat.inputArea.widthStandard'),
    t('chat.inputArea.widthWide'),
  ]

  return (
    <span className="wf-rail-op" ref={wrapRef}>
      <button
        type="button"
        className="wf-rail-opbtn"
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-label={title}
      >
        <UnfoldHorizontal size={15} />
      </button>
      {open && (
        <div className="wf-perm-pop wf-rail-pop">
          {CHAT_WIDTHS.map((w, i) => (
            <button
              key={w}
              type="button"
              className={`wf-perm-item${chatWidth === w ? ' on' : ''}`}
              onClick={() => {
                setChatWidth(w)
                setOpen(false)
              }}
            >
              <span className="dot" />
              {widthLabels[i] ?? String(w)}
              <span className="pm-desc">{w}px</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

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
  const { skills, init: initSkills } = useSkillStore()

  // 走廊 toast「回到对话直接用」的一次性预填（2026-08-07 能力房闭环）：
  // 非空=覆盖输入并聚焦，空串=仅聚焦；消费后立即清空，绝不重复注入
  const composerPrefill = useCorridorStore((s) => s.composerPrefill)
  useEffect(() => {
    if (composerPrefill === null) return
    if (composerPrefill) setContent(composerPrefill)
    textareaRef.current?.focus()
    useCorridorStore.getState().consumePrefill()
  }, [composerPrefill])
  // 2026-07-31 订阅风暴修复：整店订阅 → 输入区随每个流式 chunk 重渲染；精准订阅
  const queueMessage = useChatStore((s) => s.queueMessage)
  const popLastQueued = useChatStore((s) => s.popLastQueued)
  const hasQueued = useChatStore((s) => s.queuedMessages.length > 0)
  const currentContextTokens = useChatStore((s) => s.currentContextTokens)
  const contextWindowSize = useChatStore((s) => s.contextWindowSize)
  const contextWindowSource = useChatStore((s) => s.contextWindowSource)
  // （chatWidth/setChatWidth 已随列宽控件迁入 WidthRailSelect 自订阅）

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

  /** 发送（空闲）：消息直发 onSend；引用随消息拼出 */
  const handleSend = useCallback(async () => {
    const trimmed = content.trim()
    if (!trimmed && pendingAttachments.length === 0) return
    if (isLoading) return

    // 如果 Skill 列表尚未加载，先初始化，否则关键词触发不会生效
    if (skills.length === 0) {
      await initSkills()
    }

    const attachmentIds = pendingAttachments.map((a) => a.id)

    const quoted = quote ? `「${quote.slice(0, 500)}」\n\n${trimmed}` : trimmed

    onSend(quoted, attachmentIds.length > 0 ? attachmentIds : undefined)
    setContent('')
    setSlashQuery(null)
    onClearQuote?.()
    // pending files 由 chatStore.sendMessage → commitPendingFiles 统一提交并移除
  }, [content, isLoading, onSend, pendingAttachments, skills, initSkills, quote, onClearQuote])

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
  // 管理员模式：最高优先提示当前对话语境（P2）
  const adminMode = useChatStore((s) => s.adminMode)
  const placeholder = adminMode
    ? t('chat.inputArea.adminPlaceholder')
    : disabled
    ? t('chat.inputArea.loginRequired')
    : isStreaming && supplementReady
      ? t('chat.inputArea.queuePlaceholder')
      : t('chat.inputArea.inputHint')

  // hintbar 左侧（v9.3 引导融入式设计）：空闲时不显示任何快捷键说明——
  // 引导靠 placeholder 与交互本身传达。运行后只在前 5s 浮现「任务执行中…」；
  // 进入可补充态后改由 placeholder「输入补充…」单独承担（2026-09-02 去重：
  // 此前 rowhint 与 placeholder 同说"输入补充"，两处同框即复读）
  const hintKey = !isStreaming ? 'idle' : supplementReady ? 'ready' : 'starting'
  const hintText = !isStreaming || supplementReady
    ? ''
    : t('chat.inputArea.hintbarStarting')

  // 上下文水位（行内环，hintbar 退役并入 2026-08-21）
  // 大窗口模型（如 kimi-for-coding 256K）下小会话 round 后恒为 0%，
  // 有 token 时至少显示 1%，避免"统计坏了"的错觉（2026-07-24）
  const ctxPct =
    contextWindowSize > 0 && currentContextTokens > 0
      ? Math.max(1, Math.min(100, Math.round((currentContextTokens / contextWindowSize) * 100)))
      : 0
  // 常态细环；>70% 琥珀档、>90% 红档展开为百分比+细条（判定同 Iris docs/36，只借呈现）
  const ctxWarn = ctxPct > 70 && ctxPct <= 90
  const ctxDanger = ctxPct > 90

  // 2026-07-29：顶栏 ContextCapacityBar 已移除，具体数字迁移到 hintbar——
  // 悬停 title 显示精确值，点击在「百分比 ↔ 具体数字」间切换。
  // 1024 进制：模型窗口按 2 的幂标称（256K = 262,144），1024 进制显示才符合用户认知
  const [showCtxDetail, setShowCtxDetail] = useState(false)
  const formatCtxK = (n: number) =>
    n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)}K` : String(n)
  const ctxSourceLabel =
    contextWindowSource === 'user' ? t('chat.inputArea.ctxSrcUser') :
    contextWindowSource === 'learned' ? t('chat.inputArea.ctxSrcLearned') :
    contextWindowSource === 'api' ? t('chat.inputArea.ctxSrcApi') :
    t('chat.inputArea.ctxSrcGuess')

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
        {/* 子 Agent 胶囊条（后台运行入口，点击开子对话页） */}
        <SubAgentCapsules />

        {/* 排队 / 待注入 chips */}
        <ComposerTray />

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
                disabled={disabled || (isLoading && !isStreaming)}
                rows={1}
              />
            </div>

            {/* 运行提示：借胶囊行内空余（hintbar 退役并入 2026-08-21），窄屏隐藏；
                仅启动期（前 5s）在场，可补充态移交 placeholder（见 hintText 注释） */}
            {hintText && (
              <span key={hintKey} className="wf-rowhint wf-hint-swap">{hintText}</span>
            )}

            {/* 辅助控件：权限模式 + 文件上传（融入胶囊风格） */}
            <PermissionModeSelect />

            {/* File upload button */}
            <button
              onClick={handleFileSelect}
              disabled={disabled || (isLoading && !isStreaming)}
              className={cn(
                'h-9 w-9 flex items-center justify-center rounded-lg transition-colors flex-shrink-0',
                disabled || isLoading
                  ? 'text-[var(--wf-faint)] cursor-not-allowed'
                  : 'text-[var(--wf-faint)] hover:text-[var(--wf-sub)]'
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
                  title={t('chat.inputArea.supplementTitle')}
                  aria-label={t('chat.inputArea.supplementTitle')}
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
                disabled={!content.trim() && pendingAttachments.length === 0 || isLoading || disabled}
                className="wf-send-btn"
                title={t('chat.inputArea.send')}
                aria-label={t('chat.inputArea.send')}
              >
                <Send size={14} />
              </button>
            )}
          </div>

          {/* 坞右缘芽轨（2026-08-21）：低频状态件收进胶囊右缘。
              两行约定（2026-09-07 拍板）：上行=信息（只读呈现，如上下文水位）；
              下行=操作（点击弹选项窗，复用权限模式弹窗语言 wf-perm-pop）。
              新增控件按此归位——下行不做"点击直接改值"的盲轮换。
              三级渐进：默认无 → 接近右缘浮现"胶囊耳" → 进入热区滑轨弹出 */}
          <div className="wf-dock-approach">
            <div className="wf-dock-railzone">
              <div className="wf-dock-rail">
                {/* 上行 · 信息：上下文水位（常态细环；琥珀/红档展开百分比+细条。
                    点击在「环 ↔ 具体数字」间切换显示形态，仍属信息查看；悬停出精确值与来源） */}
                <div className="wf-dock-rail-info">
                  <span
                    className={cn('wf-ctxring', ctxDanger ? 'danger' : ctxWarn ? 'warn' : '')}
                    title={`${t('chat.contextCapacityBar.tooltip', { used: currentContextTokens.toLocaleString(), total: contextWindowSize.toLocaleString(), percentage: ctxPct })} · ${ctxSourceLabel} · ${t('chat.inputArea.ctxClickHint')}`}
                    onClick={() => setShowCtxDetail((v) => !v)}
                  >
                    {showCtxDetail ? (
                      <span className="wf-ctxring-num">{formatCtxK(currentContextTokens)}/{formatCtxK(contextWindowSize)}</span>
                    ) : ctxWarn || ctxDanger ? (
                      <>
                        <span className="wf-ctxring-pct">{ctxPct}%</span>
                        <span className="wf-ctxring-bar"><i style={{ width: `${ctxPct}%` }} /></span>
                      </>
                    ) : (
                      <svg viewBox="0 0 16 16" className="wf-ctxring-svg" aria-hidden="true">
                        <circle cx="8" cy="8" r="6" className="trk" />
                        <circle cx="8" cy="8" r="6" className="prg" strokeDasharray={`${(ctxPct / 100) * 37.7} 37.7`} />
                      </svg>
                    )}
                  </span>
                </div>
                <span className="wf-dock-rail-sep" aria-hidden="true" />
                {/* 下行 · 操作：点击弹选项窗（思考强度仅声明支持的模型在场） */}
                <div className="wf-dock-rail-ops">
                  <EffortRailSelect />
                  <WidthRailSelect />
                </div>
              </div>
            </div>
            <span className="wf-dock-rail-nub" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  )
}

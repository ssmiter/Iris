/**
 * Slash 命令菜单（v9 重写）
 *
 * 对标 claude-code 的命令提示体验：
 * - 边输入边过滤（rankCommands：精确 > 别名 > 前缀 > 模糊 + 频率加分）
 * - ↑↓ 循环选择、Tab 仅补全、Enter 执行（有参命令先补全）、Esc 关闭
 * - 菜单关闭后 Enter 立即归还发送（修复旧版"锁死回车"问题）
 *
 * 键盘事件在 window capture 阶段处理并 stopPropagation，
 * textarea 的 onKeyDown 不会重复响应。
 *
 * 见 learn/04/workshop/对话框v9实现计划-2026-07-22.md §3
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rankCommands } from '@/agent/commands/registry'
import type { SlashCommand } from '@/agent/commands/types'

interface SlashMenuProps {
  /** 当前过滤词（'/' 之后的内容，单行） */
  query: string
  /** 执行命令（无参命令 Enter / 点击） */
  onExecute: (cmd: SlashCommand) => void
  /** 补全到输入框（Tab / 有参命令 Enter）：填入 "/name " */
  onComplete: (cmd: SlashCommand) => void
  onClose: () => void
  /** 候选列表变化时回传首项（供幽灵补全） */
  onTopCandidateChange?: (cmd: SlashCommand | null) => void
}

interface FlatItem {
  cmd: SlashCommand
  /** 分组标题：仅在该项是某组第一项时出现 */
  groupLabel?: string
}

export function SlashMenu({ query, onExecute, onComplete, onClose, onTopCandidateChange }: SlashMenuProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const ranked = useMemo(() => rankCommands(query), [query])

  // 扁平化为带分组标题的列表：无过滤词时分组展示；有过滤词时平铺
  const items = useMemo<FlatItem[]>(() => {
    if (query) return ranked.map((cmd) => ({ cmd }))
    const builtin = ranked.filter((c) => c.group === 'builtin')
    const skill = ranked.filter((c) => c.group === 'skill')
    const out: FlatItem[] = []
    builtin.forEach((cmd, i) =>
      out.push({ cmd, groupLabel: i === 0 ? t('chat.slashMenu.groupBuiltin', { defaultValue: '命令' }) : undefined })
    )
    skill.forEach((cmd, i) =>
      out.push({ cmd, groupLabel: i === 0 ? t('chat.slashMenu.groupSkill', { defaultValue: '技能' }) : undefined })
    )
    return out
  }, [ranked, query, t])

  // 候选变化：重置选择 + 回传首项（幽灵补全）
  const topCandidate = items.length > 0 ? items[Math.min(selected, items.length - 1)].cmd : null
  useEffect(() => {
    setSelected(0)
  }, [query])
  useEffect(() => {
    onTopCandidateChange?.(items.length > 0 ? items[Math.min(selected, items.length - 1)].cmd : null)
  }, [items, selected, onTopCandidateChange])

  // 选中项滚动可见
  useEffect(() => {
    const el = listRef.current?.querySelector('.wf-slash-item.sel')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // 键盘语义（capture 阶段拦截，避免 textarea 重复响应）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 输入法组合期间不拦截（中文 Enter 选词）
      if (e.isComposing) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        if (items.length === 0) return
        setSelected((prev) =>
          e.key === 'ArrowDown' ? (prev + 1) % items.length : (prev - 1 + items.length) % items.length
        )
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        if (topCandidate) onComplete(topCandidate)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        if (!topCandidate) {
          onClose()
          return
        }
        // 有参命令先补全等输入；无参命令直接执行
        if (topCandidate.argumentHint) onComplete(topCandidate)
        else onExecute(topCandidate)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [items.length, topCandidate, onExecute, onComplete, onClose])

  return (
    <div className="wf-slash">
      <div className="wf-slash-list" ref={listRef}>
        {items.length === 0 && (
          <div className="wf-slash-empty">{t('chat.slashMenu.empty', { defaultValue: '没有匹配的命令' })}</div>
        )}
        {items.map((item, idx) => (
          <div key={item.cmd.name}>
            {item.groupLabel && <div className="wf-slash-group">{item.groupLabel}</div>}
            <button
              type="button"
              className={`wf-slash-item${idx === selected ? ' sel' : ''}`}
              onMouseEnter={() => setSelected(idx)}
              onClick={() => {
                if (item.cmd.argumentHint) onComplete(item.cmd)
                else onExecute(item.cmd)
              }}
            >
              <span className="si-name">/{item.cmd.name}</span>
              <span className="si-desc">{item.cmd.description}</span>
              {item.cmd.argumentHint && <span className="si-args">{item.cmd.argumentHint}</span>}
            </button>
          </div>
        ))}
      </div>
      <div className="wf-slash-foot">
        <span><b>↑↓</b> {t('chat.slashMenu.footSelect', { defaultValue: '选择' })}</span>
        <span><b>Tab</b> {t('chat.slashMenu.footComplete', { defaultValue: '补全' })}</span>
        <span><b>Enter</b> {t('chat.slashMenu.footRun', { defaultValue: '执行' })}</span>
        <span><b>Esc</b> {t('chat.slashMenu.footClose', { defaultValue: '关闭' })}</span>
      </div>
    </div>
  )
}

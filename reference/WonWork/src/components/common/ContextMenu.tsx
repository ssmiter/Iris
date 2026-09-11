/**
 * ContextMenu — 通用右键菜单（2026-09-09 文件浏览二阶段引入，全 app 可复用）。
 *
 * 设计要点（对齐系统菜单直觉，参照 Sidebar ConvContextMenu 的关闭语义）：
 * - fixed 定位在鼠标点，视口边缘自动内收（先按估计尺寸clamp，挂载后按实测尺寸精修）；
 * - 关闭：点外部 mousedown / Escape / 窗口滚动与缩放（菜单锚定的内容已动，留着会指错对象）；
 * - 菜单项点击后必关；danger 项红色语义（删除类）。
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'

export interface ContextMenuItem {
  key: string
  label: string
  icon?: LucideIcon
  /** 危险操作（删除类），红色 */
  danger?: boolean
  disabled?: boolean
  /** disabled 时的悬停提示 */
  disabledTitle?: string
  onSelect: () => void
}

export type ContextMenuEntry = ContextMenuItem | 'divider'

export interface ContextMenuState {
  x: number
  y: number
  entries: ContextMenuEntry[]
}

/** 估计尺寸（首帧 clamp 用；挂载后用实测精修） */
const EST_WIDTH = 190
const EST_ITEM_HEIGHT = 30

export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  // 定位：打开时按估计尺寸 clamp 出初始位；挂载后按实测尺寸精修一次（防底部/右侧出屏）
  useLayoutEffect(() => {
    if (!state) {
      setPos(null)
      return
    }
    const estHeight = state.entries.length * EST_ITEM_HEIGHT + 10
    setPos({
      x: Math.min(state.x, window.innerWidth - EST_WIDTH - 8),
      y: Math.min(state.y, window.innerHeight - estHeight - 8),
    })
  }, [state])

  useLayoutEffect(() => {
    if (!state || !menuRef.current) return
    const box = menuRef.current.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(state.x, window.innerWidth - box.width - 8)),
      y: Math.max(4, Math.min(state.y, window.innerHeight - box.height - 8)),
    })
    // 仅在打开瞬间精修一次（state 变化=新开菜单）
  }, [state])

  useEffect(() => {
    if (!state) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onMouseDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose()
    }
    const onScroll = () => onClose()
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    // capture=true：列表区自身滚动也要关（菜单锚定的行已滚走）
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [state, onClose])

  if (!state || !pos) return null

  return createPortal(
    <div ref={menuRef} className="wf-context-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {state.entries.map((entry, i) =>
        entry === 'divider' ? (
          <div key={`sep-${i}`} className="wf-context-menu-sep" />
        ) : (
          <button
            key={entry.key}
            role="menuitem"
            className={entry.danger ? 'danger' : ''}
            disabled={entry.disabled}
            title={entry.disabled ? entry.disabledTitle : undefined}
            onClick={() => {
              onClose()
              entry.onSelect()
            }}
          >
            {entry.icon && <entry.icon size={13} />}
            <span>{entry.label}</span>
          </button>
        )
      )}
    </div>,
    document.body
  )
}

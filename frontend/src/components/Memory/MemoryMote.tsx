import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useFileMemoryStore } from '@/stores/fileMemoryStore'
import { useMemoryDockStore } from '@/stores/memoryDockStore'

/**
 * 记忆微尘（记忆之野 v11 · 顶栏入口 2026-07-31；2026-09-03 切换文件数据源）
 *
 * 顶栏里的一粒琥珀微尘：缓慢呼吸 = 记忆系统活着；
 * 数字 = 记忆文件条数；点击开合记忆覆层（与 /memory、侧栏入口同一开关）。
 * 有新记忆写入时微尘 bump 一下——不弹 toast 也能感知"它记下了"。
 */
export function MemoryMote() {
  const { t } = useTranslation()
  const count = useFileMemoryStore((s) => s.entries.length)
  const initialized = useFileMemoryStore((s) => s.initialized)
  const isOpen = useMemoryDockStore((s) => s.isOpen)
  const toggle = useMemoryDockStore((s) => s.toggle)
  const [bump, setBump] = useState(false)
  const prevCount = useRef<number | null>(null)

  useEffect(() => {
    if (!initialized) void useFileMemoryStore.getState().initialize()
  }, [initialized])

  // 计数上升 → bump（首次装载不算）
  useEffect(() => {
    if (prevCount.current !== null && count > prevCount.current) {
      setBump(true)
      const timer = setTimeout(() => setBump(false), 750)
      return () => clearTimeout(timer)
    }
    prevCount.current = count
  }, [count])

  return (
    <button
      type="button"
      className={`wf-mote${bump ? ' bump' : ''}${isOpen ? ' open' : ''}`}
      onClick={toggle}
      title={t('memory.mote.title')}
    >
      <span className="wf-mote-star" aria-hidden />
      <span className="wf-mote-label">{t('memory.mote.label')}</span>
      <span className="wf-mote-cnt">· {count}</span>
    </button>
  )
}

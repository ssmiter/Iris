import { useCallback, useRef, useState } from 'react'
import type { MemoryFileEntry } from '@/types/memoryFile'
import { useFileMemoryStore } from '@/stores/fileMemoryStore'

/**
 * 淡忘：先模糊失色（.8s），再坍缩高度（.5s），最后才删文件——无跳变。
 * 文件化（2026-09-03）后只剩"删除"一种离场：文件世界里没有归档态，
 * 不需要的记忆就是删掉（模型侧同理：删文件+移除索引行）。
 */
export function useForget() {
  const [fading, setFading] = useState<Set<string>>(new Set())
  const [collapsing, setCollapsing] = useState<Set<string>>(new Set())
  const timers = useRef<number[]>([])

  const forget = useCallback((entry: MemoryFileEntry) => {
    const id = entry.relativePath
    setFading((prev) => new Set(prev).add(id))
    timers.current.push(
      window.setTimeout(() => {
        setCollapsing((prev) => new Set(prev).add(id))
      }, 800),
      window.setTimeout(() => {
        // 文件+索引行一步净（2026-09-03 审计修复：原先只删文件，MEMORY.md 留孤儿索引行）
        void useFileMemoryStore.getState().deleteMemoryWithIndex(id)
        setFading((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        setCollapsing((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, 1350)
    )
  }, [])

  return { fading, collapsing, forget }
}

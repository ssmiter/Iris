import { useMemo, useState } from 'react'
import {
  capabilityAdminApi,
  type CapabilityAdminDetail,
  type CapabilityAdminItem,
  type CapabilityAdminListing,
} from '@/api/irisApi'
import {
  cacheCapabilityDetail,
  makeCapabilityDetailKey,
  readCapabilityCenterCache,
  readCapabilityDetail,
} from '@/domain/capability/capabilityCenterCache'

export type DetailState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; detail: CapabilityAdminDetail }

/**
 * 详情层数据（docs/39 §6 从壳拆出）：detailPath 开关、按 manifestHash 缓存的
 * 详情预取。详情对象先查当前目录清单，再查全部已缓存清单（搜索直达详情时
 * 目标目录可能还没切过去）。
 */
export function useCapabilityDetail({
  listing,
  listingsVersion,
}: {
  listing: CapabilityAdminListing | null
  listingsVersion: number
}) {
  const [detailPath, setDetailPath] = useState<string | null>(null)
  const [detailStatus, setDetailStatus] = useState<
    Record<string, 'loading' | 'error'>
  >({})

  const prefetchDetail = (item: CapabilityAdminItem) => {
    const hash = item.manifestHash
    if (hash) {
      const cached = readCapabilityDetail(makeCapabilityDetailKey(item.path, hash))
      if (cached) return
    }
    setDetailStatus((current) => ({ ...current, [item.path]: 'loading' }))
    capabilityAdminApi
      .detail(item.path)
      .then((detail) => {
        if (hash) {
          cacheCapabilityDetail(makeCapabilityDetailKey(item.path, hash), detail)
        }
        setDetailStatus((current) => {
          const next = { ...current }
          delete next[item.path]
          return next
        })
      })
      .catch(() =>
        setDetailStatus((current) => ({ ...current, [item.path]: 'error' })),
      )
  }

  const openDetail = (item: CapabilityAdminItem) => {
    setDetailPath(item.path)
    prefetchDetail(item)
  }

  const closeDetail = () => setDetailPath(null)

  const detailStateOf = (item: CapabilityAdminItem): DetailState | undefined => {
    const status = detailStatus[item.path]
    if (status === 'loading') return { status: 'loading' }
    if (status === 'error') return { status: 'error' }
    const hash = item.manifestHash
    if (hash) {
      const cached = readCapabilityDetail(makeCapabilityDetailKey(item.path, hash))
      if (cached) return { status: 'ready', detail: cached }
    }
    return undefined
  }

  const detailItem = useMemo(() => {
    if (!detailPath) return null
    const inCurrent = (listing?.items ?? []).find(
      (item) => item.path === detailPath,
    )
    if (inCurrent) return inCurrent
    void listingsVersion
    const snap = readCapabilityCenterCache()
    for (const entry of Object.values(snap.listings)) {
      const found = entry.data.items.find((item) => item.path === detailPath)
      if (found) return found
    }
    return null
  }, [detailPath, listing, listingsVersion])

  return {
    detailPath,
    detailItem,
    detailStateOf,
    prefetchDetail,
    openDetail,
    closeDetail,
  }
}

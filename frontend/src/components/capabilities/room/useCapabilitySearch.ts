import { useMemo, useState } from 'react'
import {
  capabilityAdminApi,
  type CapabilityAdminListing,
  type CapabilityTreeNode,
} from '@/api/irisApi'
import {
  cacheCapabilityListing,
  readCapabilityCenterCache,
  readCapabilityListing,
} from '@/domain/capability/capabilityCenterCache'
import { searchCapabilities, type SearchResult } from './CapabilitySearch'

/**
 * 跨目录搜索状态（docs/39 §2「找」）：query、已加载范围内的结果、
 * 「搜索全部目录」按需拉齐。命中打开由壳层编排（跳目录 + 开详情）。
 */
export function useCapabilitySearch({
  tree,
  listing,
  listingsVersion,
  chainTitleOf,
  onListingsChanged,
}: {
  tree: CapabilityTreeNode | null
  listing: CapabilityAdminListing | null
  listingsVersion: number
  chainTitleOf: (path: string) => string
  /** 拉齐全部目录后通知壳层 bump listingsVersion，驱动结果重算。 */
  onListingsChanged: () => void
}) {
  const [query, setQuery] = useState('')
  const [searchedAll, setSearchedAll] = useState(false)
  const [searchingAll, setSearchingAll] = useState(false)

  const isSearching = query.trim().length > 0

  const result: SearchResult | null = useMemo(() => {
    if (!isSearching) return null
    void listingsVersion
    const snap = readCapabilityCenterCache()
    const listings: Record<string, CapabilityAdminListing> = {}
    for (const [path, entry] of Object.entries(snap.listings)) {
      listings[path] = entry.data
    }
    if (listing) listings[listing.path] = listing
    return searchCapabilities({ listings, tree, query, titleOf: chainTitleOf })
  }, [isSearching, query, listingsVersion, listing, tree, chainTitleOf])

  /** 「搜索全部目录」：拉齐未加载目录的清单（搜索是低频主动作，可接受）。 */
  const searchAllDirs = () => {
    if (!tree || searchingAll) return
    setSearchingAll(true)
    const paths: string[] = []
    const walk = (node: CapabilityTreeNode) => {
      paths.push(node.path)
      node.children.forEach(walk)
    }
    walk(tree)
    const missing = paths.filter((path) => !readCapabilityListing(path))
    void Promise.allSettled(
      missing.map((path) =>
        capabilityAdminApi
          .items(path)
          .then((data) => cacheCapabilityListing(path, data)),
      ),
    ).then(() => {
      onListingsChanged()
      setSearchedAll(true)
      setSearchingAll(false)
    })
  }

  const clear = () => setQuery('')
  const resetScope = () => setSearchedAll(false)

  return {
    query,
    setQuery,
    isSearching,
    result,
    searchedAll,
    searchingAll,
    searchAllDirs,
    clear,
    resetScope,
  }
}

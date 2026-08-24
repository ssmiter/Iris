import type {
  CapabilityAdminItem,
  CapabilityAdminListing,
  CapabilityTreeNode,
} from '@/api/irisApi'

/**
 * 能力房跨目录搜索（docs/39 §2「找」心境）：纯函数。
 * 范围诚实原则——默认只搜已加载进缓存的目录清单，目录名匹配走整棵树
 * （树本身一次性全量加载）；「搜索全部目录」由调用方拉齐缓存后再跑一次。
 */

export interface SearchDirHit {
  path: string
  title: string
}

export interface SearchGroup {
  dirPath: string
  dirTitle: string
  items: CapabilityAdminItem[]
}

export interface SearchResult {
  dirs: SearchDirHit[]
  groups: SearchGroup[]
  totalItems: number
}

export function fuzzyMatch(haystack: string, needle: string): boolean {
  const text = haystack.toLowerCase()
  const tokens = needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  return tokens.every((token) => text.includes(token))
}

function walkTree(
  node: CapabilityTreeNode,
  visit: (node: CapabilityTreeNode) => void,
): void {
  visit(node)
  for (const child of node.children) walkTree(child, visit)
}

export function searchCapabilities({
  listings,
  tree,
  query,
  titleOf,
}: {
  /** 已加载的目录清单（path → listing）。 */
  listings: Record<string, CapabilityAdminListing>
  tree: CapabilityTreeNode | null
  query: string
  /** 目录路径 → 展示名（面包屑用）。 */
  titleOf: (path: string) => string
}): SearchResult {
  const needle = query.trim()
  if (!needle) return { dirs: [], groups: [], totalItems: 0 }

  const dirs: SearchDirHit[] = []
  if (tree) {
    walkTree(tree, (node) => {
      if (node.path === '/') return
      if (fuzzyMatch(`${node.title} ${node.name}`, needle)) {
        dirs.push({ path: node.path, title: node.title || node.name })
      }
    })
  }

  const groups: SearchGroup[] = []
  let totalItems = 0
  for (const path of Object.keys(listings).sort()) {
    const listing = listings[path]
    const hits = listing.items.filter((item) =>
      fuzzyMatch(`${item.name} ${item.description ?? ''} ${item.path}`, needle),
    )
    if (hits.length === 0) continue
    groups.push({ dirPath: path, dirTitle: titleOf(path), items: hits })
    totalItems += hits.length
  }
  return { dirs, groups, totalItems }
}

export interface HighlightPart {
  text: string
  match: boolean
}

/**
 * 名称高亮：query 各 token 的大小写不敏感命中区间合并后切片，
 * 交给 <mark> 渲染（搜索结果是低频主动作，O(n·m) 足够）。
 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0 || !text) return [{ text, match: false }]

  const lower = text.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const token of tokens) {
    let from = 0
    for (;;) {
      const idx = lower.indexOf(token, from)
      if (idx < 0) break
      ranges.push([idx, idx + token.length])
      from = idx + token.length
    }
  }
  if (ranges.length === 0) return [{ text, match: false }]

  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }

  const parts: HighlightPart[] = []
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), match: false })
    parts.push({ text: text.slice(start, end), match: true })
    cursor = end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false })
  return parts
}

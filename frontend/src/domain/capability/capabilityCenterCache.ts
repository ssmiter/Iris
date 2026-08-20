import type {
  CapabilityAdminListing,
  CapabilityAdminProblem,
  CapabilityTreeNode,
  SkillView,
} from '@/api/irisApi'

/**
 * 能力中心的会话级缓存（docs/36 §2-M14-B2）：Modal 关闭再打开时不重新
 * 拉取、不闪烁，目录选中/展开状态保留。纯缓存——不加轮询、不订阅 SSE；
 * 数据刷新由用户点「刷新」按钮或变更操作（启停/保存）触发。
 */
export interface CapabilityCenterCache {
  tree: CapabilityTreeNode | null
  treeFailed: boolean
  /** 首拉完成（无论成败）后置真，重开 Modal 不再自动拉取。 */
  treeLoaded: boolean
  skills: SkillView[]
  skillsLoaded: boolean
  problems: CapabilityAdminProblem[]
  problemsLoaded: boolean
  /** 按目录路径缓存的清单，选中目录回切不闪烁。 */
  listings: Record<string, CapabilityAdminListing>
  selectedPath: string
  expanded: string[]
}

let cache: CapabilityCenterCache = {
  tree: null,
  treeFailed: false,
  treeLoaded: false,
  skills: [],
  skillsLoaded: false,
  problems: [],
  problemsLoaded: false,
  listings: {},
  selectedPath: '/',
  expanded: ['/'],
}

export function readCapabilityCenterCache(): CapabilityCenterCache {
  return cache
}

export function writeCapabilityCenterCache(
  patch: Partial<CapabilityCenterCache>,
): void {
  cache = { ...cache, ...patch }
}

/** 目录清单整体失效（手动刷新或变更操作后强制重拉）。 */
export function invalidateCapabilityListings(): void {
  cache = { ...cache, listings: {} }
}

export function cacheCapabilityListing(
  path: string,
  listing: CapabilityAdminListing,
): void {
  cache = { ...cache, listings: { ...cache.listings, [path]: listing } }
}

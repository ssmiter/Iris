import type {
  CapabilityAdminDetail,
  CapabilityAdminListing,
  CapabilityAdminProblem,
  CapabilityPin,
  CapabilityTreeNode,
  SkillView,
} from '@/api/irisApi'

/**
 * 能力中心的会话级缓存（docs/37 §2.5）：generation 感知，Modal 关闭再打开时
 * 先比对服务端 generation，命中则零请求渲染；目录选中/展开状态保留。
 * 纯缓存——不加轮询、不订阅 SSE；数据刷新由用户点「刷新」按钮或变更操作触发。
 */
export interface CapabilityCenterCache {
  tree: CapabilityTreeNode | null
  /** 当前缓存 tree 对应的服务端 generation；null 表示未初始化或已失效。 */
  treeGeneration: number | null
  treeFailed: boolean
  /** 首拉完成（无论成败）后置真，重开 Modal 不再自动拉取。 */
  treeLoaded: boolean
  skills: SkillView[]
  skillsLoaded: boolean
  problems: CapabilityAdminProblem[]
  problemsLoaded: boolean
  /** 按目录路径缓存的清单，附带服务端 generation 用于失效判断。 */
  listings: Record<string, { generation: number; data: CapabilityAdminListing }>
  /** 按 path + manifestHash 缓存的详情；item hash 变化后 key 自然失效。 */
  details: Record<string, CapabilityAdminDetail>
  /** 收藏钉选（docs/37 §2.4）。 */
  pins: CapabilityPin[]
  pinsLoaded: boolean
  selectedPath: string
  expanded: string[]
}

let cache: CapabilityCenterCache = {
  tree: null,
  treeGeneration: null,
  treeFailed: false,
  treeLoaded: false,
  skills: [],
  skillsLoaded: false,
  problems: [],
  problemsLoaded: false,
  listings: {},
  details: {},
  pins: [],
  pinsLoaded: false,
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

/**
 * 与服务端 generation 比对。若不同，tree 与全部 listings 失效；details 按
 * manifestHash 自校验，不必主动清除。
 */
export function syncWithGeneration(serverGeneration: number): void {
  if (cache.treeGeneration !== serverGeneration) {
    cache = {
      ...cache,
      tree: null,
      treeGeneration: null,
      treeLoaded: false,
      listings: {},
    }
  }
}

export function cacheCapabilityListing(
  path: string,
  listing: CapabilityAdminListing,
): void {
  cache = {
    ...cache,
    listings: {
      ...cache.listings,
      [path]: { generation: listing.generation, data: listing },
    },
  }
}

export function readCapabilityListing(path: string): CapabilityAdminListing | null {
  return cache.listings[path]?.data ?? null
}

export function cacheCapabilityDetail(
  key: string,
  detail: CapabilityAdminDetail,
): void {
  cache = { ...cache, details: { ...cache.details, [key]: detail } }
}

export function readCapabilityDetail(key: string): CapabilityAdminDetail | null {
  return cache.details[key] ?? null
}

/** 收藏钉选缓存读写。 */
export function cacheCapabilityPins(pins: CapabilityPin[]): void {
  cache = { ...cache, pins, pinsLoaded: true }
}

export function readCapabilityPins(): CapabilityPin[] {
  return cache.pins
}

/** 详情缓存 key：path + manifestHash。 */
export function makeCapabilityDetailKey(
  path: string,
  manifestHash: string,
): string {
  return `${path}::${manifestHash}`
}

/** 目录清单整体失效（变更操作后强制重拉当前目录）。 */
export function invalidateCapabilityListings(): void {
  cache = { ...cache, listings: {} }
}

/** 手动全量刷新：清空全部缓存数据，保留 UI 状态（selectedPath/expanded）。 */
export function invalidateAll(): void {
  cache = {
    ...cache,
    tree: null,
    treeGeneration: null,
    treeLoaded: false,
    listings: {},
    details: {},
    skills: [],
    skillsLoaded: false,
    problems: [],
    problemsLoaded: false,
    pins: [],
    pinsLoaded: false,
  }
}

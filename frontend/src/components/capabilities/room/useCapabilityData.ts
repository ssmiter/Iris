import { useEffect, useMemo, useState } from 'react'
import {
  capabilityAdminApi,
  capabilityManagementApi,
  type CapabilityAdminItem,
  type CapabilityAdminListing,
  type CapabilityAdminProblem,
  type CapabilityPin,
  type CapabilityTreeNode,
  type SkillView,
} from '@/api/irisApi'
import { notify } from '@/components/ui'
import {
  cacheCapabilityListing,
  cacheCapabilityPins,
  invalidateAll,
  readCapabilityCenterCache,
  readCapabilityListing,
  syncWithGeneration,
  writeCapabilityCenterCache,
} from '@/domain/capability/capabilityCenterCache'

/**
 * 能力房数据加载（docs/39 §6 从壳拆出；加载语义与缓存协议 docs/37 §2.5
 * 完全不动，纯移动）：tree / listing / skills / problems / pins 的首拉、
 * generation 探针、手动全量刷新、收藏与 Skill 启停写操作。
 */
export function useCapabilityData() {
  const snapshot = useMemo(readCapabilityCenterCache, [])
  const [tree, setTree] = useState<CapabilityTreeNode | null>(snapshot.tree)
  const [treeFailed, setTreeFailed] = useState(snapshot.treeFailed)
  const [selectedPath, setSelectedPath] = useState(snapshot.selectedPath)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(snapshot.expanded),
  )
  const [listing, setListing] = useState<CapabilityAdminListing | null>(
    snapshot.listings[snapshot.selectedPath]?.data ?? null,
  )
  const [listingLoading, setListingLoading] = useState(
    !snapshot.listings[snapshot.selectedPath]?.data,
  )
  const [skills, setSkills] = useState<SkillView[]>(snapshot.skills)
  const [problems, setProblems] = useState<CapabilityAdminProblem[]>(
    snapshot.problems,
  )
  const [pins, setPins] = useState<CapabilityPin[]>(snapshot.pins)
  const [refreshing, setRefreshing] = useState(false)
  const [rotation, setRotation] = useState(0)
  const [generationSynced, setGenerationSynced] = useState(false)
  /** 任意目录清单写入缓存后 +1，驱动跨目录搜索/详情重算（缓存是模块级的）。 */
  const [listingsVersion, setListingsVersion] = useState(0)
  const bumpListings = () => setListingsVersion((v) => v + 1)

  const reloadTree = () =>
    capabilityAdminApi
      .tree()
      .then(({ generation, root }) => {
        setTree(root)
        setTreeFailed(false)
        writeCapabilityCenterCache({
          tree: root,
          treeGeneration: generation,
          treeFailed: false,
          treeLoaded: true,
        })
      })
      .catch((error: Error) => {
        setTreeFailed(true)
        writeCapabilityCenterCache({ treeFailed: true, treeLoaded: true })
        notify.error('能力目录暂时不可用', { description: error.message })
      })

  const reloadSkills = () =>
    capabilityManagementApi
      .listSkills()
      .then((next) => {
        setSkills(next)
        writeCapabilityCenterCache({ skills: next, skillsLoaded: true })
      })
      .catch(() => setSkills([]))

  const reloadProblems = () =>
    capabilityAdminApi
      .problems()
      .then((next) => {
        setProblems(next)
        writeCapabilityCenterCache({ problems: next, problemsLoaded: true })
      })
      .catch(() => setProblems([]))

  const reloadPins = () =>
    capabilityAdminApi
      .pins()
      .then(({ pins: next }) => {
        setPins(next)
        cacheCapabilityPins(next)
      })
      .catch(() => {
        setPins([])
        cacheCapabilityPins([])
      })

  const reloadListing = (path: string, force = false) => {
    if (!force) {
      const cached = readCapabilityListing(path)
      if (cached) {
        setListing(cached)
        setListingLoading(false)
        return Promise.resolve()
      }
    }
    setListingLoading(true)
    return capabilityAdminApi
      .items(path)
      .then((next) => {
        setListing(next)
        cacheCapabilityListing(path, next)
        bumpListings()
      })
      .catch((error: Error) =>
        notify.error('没有读到该目录的能力', { description: error.message }),
      )
      .finally(() => setListingLoading(false))
  }

  const refreshAll = () => {
    setRefreshing(true)
    setRotation((r) => r + 360)
    invalidateAll()
    void Promise.allSettled([
      reloadTree(),
      reloadSkills(),
      reloadProblems(),
      reloadPins(),
      reloadListing(selectedPath),
    ]).finally(() => setRefreshing(false))
  }

  const togglePin = async (path: string) => {
    const nextPaths = pins.some((p) => p.path === path)
      ? pins.filter((p) => p.path !== path).map((p) => p.path)
      : [...pins.map((p) => p.path), path]
    try {
      const { pins: updated } = await capabilityAdminApi.setPins(nextPaths)
      setPins(updated)
      cacheCapabilityPins(updated)
    } catch (error) {
      notify.error('收藏更新失败', { description: (error as Error).message })
    }
  }

  const reorderPins = async (paths: string[]) => {
    try {
      const { pins: updated } = await capabilityAdminApi.setPins(paths)
      setPins(updated)
      cacheCapabilityPins(updated)
    } catch (error) {
      notify.error('收藏排序失败', { description: (error as Error).message })
    }
  }

  const isPinned = (path: string) => pins.some((p) => p.path === path)

  const toggleSkillEnabled = async (
    item: CapabilityAdminItem,
    skill: SkillView,
  ) => {
    const next = { ...skill, enabled: !skill.enabled }
    setSkills((items) =>
      items.map((entry) => (entry.skillId === skill.skillId ? next : entry)),
    )
    try {
      const updated = await capabilityManagementApi.setSkillEnabled(
        skill,
        !skill.enabled,
      )
      setSkills((items) => {
        const nextItems = items.map((entry) =>
          entry.skillId === skill.skillId ? updated : entry,
        )
        writeCapabilityCenterCache({ skills: nextItems })
        return nextItems
      })
      await reloadListing(selectedPath, true)
    } catch (error) {
      setSkills((items) =>
        items.map((entry) => (entry.skillId === skill.skillId ? skill : entry)),
      )
      notify.error('没有改变 Skill 状态', {
        description: (error as Error).message,
      })
    }
  }

  // generation 探针：命中则零请求渲染，不命中则失效重拉。
  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      try {
        const { generation } = await capabilityAdminApi.generation()
        if (cancelled) return
        syncWithGeneration(generation)
      } catch {
        // 探针失败时回退到 loaded 标志，避免阻塞已有缓存的渲染。
      }
      if (!cancelled) setGenerationSynced(true)
    }
    probe()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    writeCapabilityCenterCache({ selectedPath })
    if (!generationSynced) return
    const after = readCapabilityCenterCache()
    if (!after.treeLoaded) void reloadTree()
    if (!after.skillsLoaded) void reloadSkills()
    if (!after.problemsLoaded) void reloadProblems()
    if (!after.pinsLoaded) void reloadPins()
    void reloadListing(selectedPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationSynced, selectedPath])

  useEffect(() => {
    writeCapabilityCenterCache({ expanded: [...expanded] })
  }, [expanded])

  return {
    tree,
    treeFailed,
    selectedPath,
    setSelectedPath,
    expanded,
    setExpanded,
    listing,
    listingLoading,
    skills,
    problems,
    pins,
    refreshing,
    rotation,
    listingsVersion,
    bumpListings,
    reloadTree,
    reloadSkills,
    reloadPins,
    reloadListing,
    refreshAll,
    togglePin,
    reorderPins,
    isPinned,
    toggleSkillEnabled,
  }
}

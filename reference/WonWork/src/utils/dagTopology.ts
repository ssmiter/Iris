/**
 * DAG 拓扑工具
 * 从 agentSwarmEngine.ts 的 executeDag 中提取并泛化
 */

export function buildTopologicalWaves<T>(
  items: T[],
  getId: (item: T) => string,
  getDependencies: (item: T) => string[]
): T[][] {
  const waves: T[][] = []
  const remaining = new Map(items.map((item) => [getId(item), item]))

  while (remaining.size > 0) {
    const ready: T[] = []
    for (const item of remaining.values()) {
      const deps = getDependencies(item)
      if (deps.every((dep) => !remaining.has(dep))) {
        ready.push(item)
      }
    }

    if (ready.length === 0) {
      // 存在循环依赖，将剩余任务全部放入下一波次并终止
      ready.push(...remaining.values())
      waves.push(ready)
      break
    }

    waves.push(ready)
    for (const item of ready) {
      remaining.delete(getId(item))
    }
  }

  return waves
}

export function buildWavesFromEdges<T extends { id: string }>(
  items: T[],
  edges: { source: string; target: string }[]
): T[][] {
  const depsMap = new Map<string, string[]>()

  for (const item of items) {
    depsMap.set(item.id, [])
  }

  for (const edge of edges) {
    const deps = depsMap.get(edge.target)
    if (deps) {
      deps.push(edge.source)
    }
  }

  return buildTopologicalWaves(items, (item) => item.id, (item) => depsMap.get(item.id) || [])
}

export function getUpstreamNodes(
  nodeId: string,
  edges: { source: string; target: string }[]
): string[] {
  return edges.filter((e) => e.target === nodeId).map((e) => e.source)
}

export function getDownstreamNodes(
  nodeId: string,
  edges: { source: string; target: string }[]
): string[] {
  return edges.filter((e) => e.source === nodeId).map((e) => e.target)
}

export function detectCycle<T extends { id: string }>(
  items: T[],
  edges: { source: string; target: string }[]
): boolean {
  const visited = new Set<string>()
  const recStack = new Set<string>()
  const adj = new Map<string, string[]>()

  for (const item of items) {
    adj.set(item.id, [])
  }
  for (const edge of edges) {
    const list = adj.get(edge.source)
    if (list) {
      list.push(edge.target)
    }
  }

  function dfs(id: string): boolean {
    visited.add(id)
    recStack.add(id)
    for (const neighbor of adj.get(id) || []) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) return true
      } else if (recStack.has(neighbor)) {
        return true
      }
    }
    recStack.delete(id)
    return false
  }

  for (const item of items) {
    if (!visited.has(item.id)) {
      if (dfs(item.id)) return true
    }
  }
  return false
}

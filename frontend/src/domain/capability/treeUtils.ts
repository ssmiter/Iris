import type { CapabilityAdminItem, CapabilityTreeNode } from '@/api/irisApi'

/**
 * 能力树的路径与真相关型工具（docs/39 §6：从 CapabilityExplorer 巨石抽出，
 * 供舞台 / 详情层 / 搜索共用，纯函数无副作用）。
 */

export function findNode(
  node: CapabilityTreeNode,
  path: string,
): CapabilityTreeNode | null {
  if (node.path === path) return node
  for (const child of node.children) {
    const found = findNode(child, path)
    if (found) return found
  }
  return null
}

/** 从根到 path 的祖先链（含根 '/'，不含 path 自身）。 */
export function ancestorsOf(path: string): string[] {
  const result = ['/']
  const segments = path.split('/').filter(Boolean)
  let current = ''
  for (const segment of segments.slice(0, -1)) {
    current += `/${segment}`
    result.push(current)
  }
  return result
}

export function parentPathOf(path: string): string {
  if (path === '/') return '/'
  const idx = path.lastIndexOf('/')
  return idx <= 0 ? '/' : path.slice(0, idx)
}

export function fileNameOf(path: string): string {
  if (path === '/') return ''
  const idx = path.lastIndexOf('/')
  return idx < 0 ? path : path.slice(idx + 1)
}

/** path 的直接子路径拼接（根目录下不出现双斜杠）。 */
export function childPathOf(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`
}

export function isValidMachineName(value: string): boolean {
  return /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(value) && value.length > 0
}

const FILE_TRUTH_KINDS = new Set(['process', 'template', 'skill', 'knowledge'])

export function isFileTruth(item: CapabilityAdminItem): boolean {
  return FILE_TRUTH_KINDS.has(item.kind) && item.sourceFile != null
}

export function isDbTruth(item: CapabilityAdminItem): boolean {
  return ['skill_store', 'mcp', 'schedule', 'pipeline'].includes(item.origin)
}

export function isKernelTool(item: CapabilityAdminItem): boolean {
  return (
    item.kind === 'kernel_tool' ||
    item.origin === 'kernel' ||
    item.path.startsWith('/system/')
  )
}

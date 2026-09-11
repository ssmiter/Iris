import type { KnowledgeDocumentSummary } from '@/types/knowledge'

export interface KnowledgeResourceNode {
  id: string
  name: string
  path: string
  kind: 'collection' | 'folder' | 'document' | 'heading'
  children: KnowledgeResourceNode[]
  document?: KnowledgeDocumentSummary
}

const cleanPath = (value: string) => value.replace(/\\/g, '/').split('/').map((part) => part.trim()).filter(Boolean).join('/')

export function parentResourcePath(locator: string) {
  const normalized = cleanPath(locator)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

function stableId(kind: KnowledgeResourceNode['kind'], path: string) {
  return `${kind}:${path || '/'}`
}

function ensurePath(root: KnowledgeResourceNode, folderPath: string) {
  let current = root
  let accumulated = ''
  for (const part of cleanPath(folderPath).split('/').filter(Boolean)) {
    accumulated = accumulated ? `${accumulated}/${part}` : part
    let child = current.children.find((node) => node.kind === 'folder' && node.path === accumulated)
    if (!child) {
      child = { id: stableId('folder', accumulated), name: part, path: accumulated, kind: 'folder', children: [] }
      current.children.push(child)
    }
    current = child
  }
  return current
}

function addHeadingTree(documentNode: KnowledgeResourceNode, headingPaths: string[]) {
  for (const headingPath of headingPaths || []) {
    let current = documentNode
    let accumulated = ''
    for (const part of headingPath.split(/\s*\/\s*/).map((item) => item.trim()).filter(Boolean)) {
      accumulated = accumulated ? `${accumulated}/${part}` : part
      let child = current.children.find((node) => node.kind === 'heading' && node.path.endsWith(`#${accumulated}`))
      if (!child) {
        child = { id: stableId('heading', `${documentNode.path}#${accumulated}`), name: part, path: `${documentNode.path}#${accumulated}`, kind: 'heading', children: [] }
        current.children.push(child)
      }
      current = child
    }
  }
}

function sortNodes(nodes: KnowledgeResourceNode[]) {
  nodes.sort((left, right) => {
    const rank = { folder: 0, document: 1, heading: 2, collection: 3 }
    return rank[left.kind] - rank[right.kind] || left.name.localeCompare(right.name, 'zh-CN')
  })
  nodes.forEach((node) => sortNodes(node.children))
}

export function buildKnowledgeResourceTree(collectionName: string, documents: KnowledgeDocumentSummary[], rootDirectoryLabel: string) {
  const root: KnowledgeResourceNode = { id: stableId('collection', collectionName), name: collectionName, path: '', kind: 'collection', children: [] }
  for (const document of documents) {
    const locator = cleanPath(document.sourceLocator)
    const parent = ensurePath(root, parentResourcePath(locator))
    const node: KnowledgeResourceNode = {
      id: stableId('document', document.id),
      name: document.title,
      path: locator,
      kind: 'document',
      document,
      children: [],
    }
    addHeadingTree(node, document.headingPaths || [])
    parent.children.push(node)
  }
  sortNodes(root.children)
  return root
}

export function findResourceNode(root: KnowledgeResourceNode, path: string): KnowledgeResourceNode | undefined {
  if (root.path === path) return root
  for (const child of root.children) {
    const match = findResourceNode(child, path)
    if (match) return match
  }
  return undefined
}

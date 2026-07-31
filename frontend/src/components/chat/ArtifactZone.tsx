import { useState } from 'react'
import type { ArtifactNode } from '@/domain/chat/models'
import { ArtifactCard } from './ArtifactCard'
import { cn } from '@/lib/cn'

interface ArtifactZoneProps {
  nodes: ArtifactNode[]
  /** 所属 Round 仍活跃：新发布的卡片播出生动画；水合/历史一律静默 */
  live: boolean
}

/**
 * 产物区（docs/24 §13 第三轮，对齐 WonWork wf-artifact-zone）。
 *
 * artifact 节点不是过程步骤，而是过程的结果——从脊柱提升至此，
 * 无论过程区折叠与否始终可见，位置在回答之后（回答常常引用它们）。
 * 卡片在链内不再重复渲染（RoundSection 已把 artifact 节点滤出链条）。
 */
export function ArtifactZone({ nodes, live }: ArtifactZoneProps) {
  if (nodes.length === 0) return null
  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {nodes.map((node) => (
        <ZoneItem key={node.nodeId} live={live} node={node} />
      ))}
    </div>
  )
}

/** 已播过出生动画的产物卡（会话级，不持久化），防虚拟列表重放 */
const bornArtifactIds = new Set<string>()

function ZoneItem({ node, live }: { node: ArtifactNode; live: boolean }) {
  const [born] = useState(() => {
    if (!live || bornArtifactIds.has(node.nodeId)) return false
    bornArtifactIds.add(node.nodeId)
    if (bornArtifactIds.size > 2048) {
      const oldest = bornArtifactIds.values().next().value
      if (oldest) bornArtifactIds.delete(oldest)
    }
    return true
  })
  return (
    <div className={cn(born && 'animate-node-enter motion-reduce:animate-none')}>
      <ArtifactCard node={node} />
    </div>
  )
}

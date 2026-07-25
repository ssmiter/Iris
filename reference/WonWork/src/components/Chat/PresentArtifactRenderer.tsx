import { memo } from 'react'
import { ArtifactSkeleton } from './ArtifactSkeleton'
import { FileCard } from './FileCard'
import { extractArtifact } from '@/types/artifact'
import { toFileCardArtifact } from '@/types/artifactDock'
import type { ToolResultRendererProps } from '@/agent/tools/toolRenderRegistry'

export const PresentArtifactRenderer = memo(function PresentArtifactRenderer({
  message,
}: ToolResultRendererProps) {
  if (message.toolCallStatus === 'calling') {
    return <ArtifactSkeleton variant="image" />
  }

  const artifact = extractArtifact(message.structuredData)
  if (!artifact) {
    return (
      <div className="mt-2 rounded-xl border border-surface-200 bg-white p-4">
        <pre className="text-xs text-surface-600 overflow-auto">{JSON.stringify(message.structuredData, null, 2)}</pre>
      </div>
    )
  }

  return <FileCard artifact={toFileCardArtifact(artifact)} />
})

import { memo } from 'react'
import { cn } from '@/utils'

type SkeletonVariant = 'image' | 'table'

interface ArtifactSkeletonProps {
  variant?: SkeletonVariant
}

/**
 * present_artifact 调用中的骨架屏。
 *
 * 用近似最终布局的灰块暗示内容形态，而不是通用 spinner。
 * 遵循 prefers-reduced-motion：有动效偏好时退化为无动画。
 */
export const ArtifactSkeleton = memo(function ArtifactSkeleton({
  variant = 'image',
}: ArtifactSkeletonProps) {
  const baseBlock = 'bg-surface-200 rounded motion-safe:animate-pulse'

  if (variant === 'image') {
    return (
      <div className="mt-2 rounded-xl border border-surface-200 bg-white p-4 space-y-3">
        <div className={cn(baseBlock, 'h-40 w-full')} />
        <div className={cn(baseBlock, 'h-5 w-2/3')} />
        <div className={cn(baseBlock, 'h-3 w-1/2')} />
        <div className="flex items-center gap-2 pt-1">
          <div className={cn(baseBlock, 'h-7 w-16')} />
          <div className={cn(baseBlock, 'h-7 w-24')} />
        </div>
      </div>
    )
  }

  return (
    <div className="mt-2 rounded-xl border border-surface-200 bg-white p-4 space-y-3">
      <div className={cn(baseBlock, 'h-5 w-2/3')} />
      <div className="space-y-2">
        <div className={cn(baseBlock, 'h-6 w-full')} />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={cn(baseBlock, 'h-4 w-full')} />
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <div className={cn(baseBlock, 'h-7 w-16')} />
        <div className={cn(baseBlock, 'h-7 w-32')} />
      </div>
    </div>
  )
})

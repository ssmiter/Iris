import type { ComponentProps } from 'react'

import type { Badge } from '../../components/ui/Badge'

export type BadgeTone = NonNullable<ComponentProps<typeof Badge>['tone']>

/**
 * 风险四档的唯一真相源（docs/32 §5：管理页与对话内工具卡片同色同文案）。
 * 对话区 FlowNode 与能力中心 CapabilityTreeView 都必须引用本表，
 * 不得再各自声明。
 */
export const RISK_META: Record<string, { label: string; tone: BadgeTone }> = {
  read_only: { label: '只读', tone: 'success' },
  standard: { label: '标准', tone: 'neutral' },
  elevated: { label: '提权', tone: 'warning' },
  destructive: { label: '破坏性', tone: 'danger' },
}

export function riskMeta(riskLevel: string | undefined | null): { label: string; tone: BadgeTone } {
  return (riskLevel && RISK_META[riskLevel]) || { label: '标准', tone: 'neutral' }
}

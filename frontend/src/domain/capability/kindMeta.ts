import {
  BookOpen,
  Box,
  Clock,
  Cog,
  GitBranch,
  LayoutTemplate,
  Plug,
  Puzzle,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { BadgeTone } from './riskMeta'

/**
 * kind 文案 / 语义色 / 图标的唯一真相源（docs/32 §5、docs/36 §2-M14）：
 * 过滤 chip、卡片徽标、卡片图标砖共用，任何地方不得再直渲染英文枚举串。
 * DB 技能库与文件技能以 origin 区分（kind=skill + origin=skill_store）。
 */
export interface KindMeta {
  label: string
  tone: BadgeTone
  Icon: LucideIcon
  /** 图标砖的 soft 底 + 前景（W1）；静态类名表，保证 Tailwind 可扫描。 */
  tileClass: string
}

const TILE_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-surface-muted text-ink-subtle',
  info: 'bg-info-soft text-info-foreground',
  success: 'bg-success-soft text-success-foreground',
  warning: 'bg-warning-soft text-warning-foreground',
  danger: 'bg-danger-soft text-danger-foreground',
  violet: 'bg-violet-soft text-violet-foreground',
  teal: 'bg-teal-soft text-teal-foreground',
}

function meta(label: string, tone: BadgeTone, Icon: LucideIcon): KindMeta {
  return { label, tone, Icon, tileClass: TILE_TONE[tone] }
}

export function kindMeta(item: {
  kind: string
  origin?: string | null
}): KindMeta {
  switch (item.kind) {
    case 'kernel_tool':
      return meta('内核', 'neutral', Wrench)
    case 'process':
      return meta('进程', 'info', Cog)
    case 'template':
      return meta('模板', 'info', LayoutTemplate)
    case 'skill':
      return item.origin === 'skill_store'
        ? meta('技能库', 'teal', Puzzle)
        : meta('技能', 'success', Puzzle)
    case 'knowledge':
      return meta('知识', 'violet', BookOpen)
    case 'mcp_tool':
    case 'mcp':
      return meta('MCP', 'warning', Plug)
    case 'pipeline':
      return meta('流水线', 'neutral', GitBranch)
    case 'schedule':
      return meta('定时', 'info', Clock)
    default:
      return meta(item.kind, 'neutral', Box)
  }
}

/** 过滤 chip 用：无 origin 上下文的纯 kind 中文文案。 */
export function kindLabel(kind: string): string {
  return kindMeta({ kind }).label
}

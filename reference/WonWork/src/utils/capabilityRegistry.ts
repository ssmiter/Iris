/**
 * WonWork 能力清单（Capability Registry）
 *
 * 作为 AI 自我认知的单一事实源（Single Source of Truth）。
 * 所有身份提示词、能力声明均由运行时能力清单驱动，避免写死 prompt。
 *
 * 设计预留：
 * - 未来后端根治（P1-007）后，可将后端动态能力合并到 backendCapabilities 字段。
 * - 新增能力只需在 ALL_CAPABILITIES 中注册，buildCapabilityRegistry 自动计算可用性。
 */

import type { RuntimeMode } from '@/utils/runtimeMode'
import type { ConnectionStatus } from '@/types/webbridge'

// ==================== 类型定义 ====================

export type CapabilityCategory = 'core' | 'webbridge' | 'mes' | 'file' | 'agent' | 'cron' | 'tool'

export interface CapabilityItem {
  id: string
  name: string
  description: string
  category: CapabilityCategory
  requires?: string[] // 依赖的其他 capability id
}

export interface CapabilityRegistry {
  available: CapabilityItem[]
  unavailable: CapabilityItem[]
  mode: RuntimeMode
  webBridge: { status: ConnectionStatus; isAvailable: boolean }
  mes: { isLoggedIn: boolean; canAccessData: boolean }
  /** 预留：后端动态能力清单（P1-007 根治后填充） */
  backendCapabilities?: unknown[]
}

// ==================== 静态能力清单 ====================

const ALL_CAPABILITIES: CapabilityItem[] = [
  {
    id: 'chat',
    name: '通用 AI 对话',
    description: '回答工业、生产管理、MES 相关的通用知识问题，进行文本生成、分析、翻译、总结等。',
    category: 'core',
  },
  {
    id: 'file',
    name: '本地文件处理',
    description: '处理用户上传的本地文件（Word/Excel/PPT/图片/PDF 等），提取内容、分析数据、生成报告。',
    category: 'file',
  },
  {
    id: 'webbridge',
    name: '浏览器自动化',
    description: '通过 WebBridge 自动化浏览器操作：访问网页、提取数据、填写表单、截图、执行自动化测试等。',
    category: 'webbridge',
    requires: ['webbridge_connected'],
  },
  {
    id: 'cron',
    name: '定时任务',
    description: '创建和管理定时任务（Cron），按计划自动执行提醒、数据抓取、报告生成等操作。',
    category: 'cron',
  },
  {
    id: 'local_frontend_tools',
    name: '前端本地工具',
    description: '在前端本地执行文件处理（read_file / write_file / list_files / glob / grep / delete_file）等工具，无需等待后端响应。',
    category: 'tool',
  },
  {
    id: 'web_tools',
    name: '网络搜索与网页抓取',
    description: '通过本地 WebBridge daemon 执行 web_search / web_fetch，无需 API Key；搜索结果与网页原文写入工作区 /workspace/scratch/web_cache/，模型可通过 read_file 深读。',
    category: 'tool',
  },
  {
    id: 'agent_swarm',
    name: 'Agent Swarm',
    description: '多 Agent 协作 swarm，分解复杂任务为子任务，由多个专业 Agent 并行或串行执行。',
    category: 'agent',
  },
  {
    id: 'mes_query',
    name: 'MES 数据查询',
    description: '查询企业 MES 数据库：生产订单、工单进度、设备状态、质量数据、库存信息等。',
    category: 'mes',
    requires: ['mes_logged_in', 'mescli_online'],
  },
  {
    id: 'mes_workflow',
    name: 'MES 工作流执行',
    description: '执行 MES 业务工作流：报工、质检、物料流转、工艺路线执行等。',
    category: 'mes',
    requires: ['mes_logged_in', 'mescli_online'],
  },
  {
    id: 'mes_report',
    name: '生产报表生成',
    description: '基于 MES 数据生成生产报表：产量统计、质量分析、设备 OEE、人员绩效等。',
    category: 'mes',
    requires: ['mes_logged_in', 'mescli_online'],
  },
]

// ==================== 构建函数 ====================

export interface BuildRegistryInput {
  mode: RuntimeMode
  webBridgeStatus: ConnectionStatus
  isMesLoggedIn: boolean
  /** 预留：后端动态能力数据（P1-007 根治后传入） */
  backendCapabilities?: unknown[]
}

/**
 * 根据运行时状态构建能力清单。
 *
 * 规则：
 * 1. core / file / agent / cron 能力在所有模式下均可用。
 * 2. webbridge 仅在 WebBridge 已连接（connected）时可用。
 * 3. mes_* 能力仅在 mescli-online 模式且用户已登录 MES 时可用。
 */
export function buildCapabilityRegistry(input: BuildRegistryInput): CapabilityRegistry {
  const { mode, webBridgeStatus, isMesLoggedIn, backendCapabilities } = input

  const webBridgeIsAvailable = webBridgeStatus === 'connected'
  const canAccessMes = mode === 'mescli-online' && isMesLoggedIn

  const available: CapabilityItem[] = []
  const unavailable: CapabilityItem[] = []

  for (const cap of ALL_CAPABILITIES) {
    let isAvailable = true
    let reason = ''

    if (cap.id === 'local_frontend_tools') {
      if (mode !== 'standalone' && mode !== 'mescli-local' && mode !== 'website-online') {
        isAvailable = false
        reason = '当前为 MESCLI 在线模式，前端本地工具由后端 MES 工具接管；如需使用本地文件/搜索工具，请切换到 MESCLI 本地模式、Standalone 模式或官网在线模式。'
      }
    }

    if (cap.id === 'webbridge') {
      if (!webBridgeIsAvailable) {
        isAvailable = false
        reason = `WebBridge 当前未连接（状态：${webBridgeStatus}），无法执行浏览器自动化。`
      }
    }

    if (cap.id === 'web_tools') {
      if (!webBridgeIsAvailable) {
        isAvailable = false
        reason = `WebBridge 当前未连接（状态：${webBridgeStatus}），web_search / web_fetch 不可用。请启动本地 WebBridge daemon。`
      }
    }

    if (cap.category === 'mes') {
      if (mode !== 'mescli-online') {
        isAvailable = false
        reason = `当前为 ${mode === 'standalone' ? 'Standalone 本地模式' : 'MESCLI 本地模式'}，无法访问企业 MES 数据。该功能仅在 MESCLI 在线模式下可用。`
      } else if (!isMesLoggedIn) {
        isAvailable = false
        reason = '当前用户未登录 MES，无法访问企业 MES 数据。请先登录 MES。'
      }
    }

    if (isAvailable) {
      available.push(cap)
    } else {
      unavailable.push({ ...cap, description: `${cap.description}\n\n（不可用原因：${reason}）` })
    }
  }

  return {
    available,
    unavailable,
    mode,
    webBridge: { status: webBridgeStatus, isAvailable: webBridgeIsAvailable },
    mes: { isLoggedIn: isMesLoggedIn, canAccessData: canAccessMes },
    backendCapabilities,
  }
}

/**
 * 快速检查某能力是否可用。
 */
export function hasCapability(registry: CapabilityRegistry, capabilityId: string): boolean {
  return registry.available.some((c) => c.id === capabilityId)
}

/**
 * 获取某能力的描述（无论可用或不可用）。
 */
export function getCapabilityDescription(
  registry: CapabilityRegistry,
  capabilityId: string
): string | undefined {
  const cap =
    registry.available.find((c) => c.id === capabilityId) ||
    registry.unavailable.find((c) => c.id === capabilityId)
  return cap?.description
}

/**
 * 生成能力清单的 Markdown 文本描述，用于注入系统提示词。
 */
export function formatCapabilityList(registry: CapabilityRegistry): string {
  const lines: string[] = []

  if (registry.available.length > 0) {
    lines.push('**当前可用能力：**')
    for (const cap of registry.available) {
      lines.push(`- ${cap.name}：${cap.description.split('\n')[0]}`)
    }
  }

  if (registry.unavailable.length > 0) {
    lines.push('')
    lines.push('**当前不可用能力：**')
    for (const cap of registry.unavailable) {
      const firstLine = cap.description.split('\n')[0]
      lines.push(`- ${cap.name}：${firstLine}`)
    }
  }

  return lines.join('\n')
}

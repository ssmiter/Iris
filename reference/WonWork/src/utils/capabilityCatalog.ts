import { toolApi, dagWorkflowApi } from '@/api/client'
import { skillApi } from '@/api/skillApi'
import { DAG_NODE_TYPES, type DagNodeType, type DagWorkflow } from '@/types/dagWorkflow'
import type { ToolCatalogItem } from '@/types/mescli'
import type { SkillManifest } from '@/types/skill'

export interface CatalogTool {
  name: string
  description: string
  parameters?: unknown
  source: 'backend'
}

export interface CatalogSkill {
  id: string
  name: string
  description: string
  keywords: string[]
  source: 'skill'
}

export interface CatalogWorkflow {
  id: string
  name: string
  description: string
  nodeTypes: string[]
  source: 'workflow'
}

export interface CapabilityCatalog {
  tools: CatalogTool[]
  skills: CatalogSkill[]
  workflows: CatalogWorkflow[]
  nodeTypes: DagNodeType[]
}

function skillToCatalogSkill(skill: SkillManifest): CatalogSkill {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    keywords: skill.trigger?.keywords || skill.tags || [],
    source: 'skill',
  }
}

function workflowToCatalogWorkflow(wf: DagWorkflow): CatalogWorkflow {
  return {
    id: wf.id,
    name: wf.name,
    description: wf.description || '',
    nodeTypes: [...new Set(wf.nodes.map((n) => n.type))],
    source: 'workflow',
  }
}

function backendToolToCatalogTool(tool: ToolCatalogItem): CatalogTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    source: 'backend',
  }
}

/**
 * 拉取后端可用能力目录。
 * 任何一项查询失败都不会阻塞其他项，返回已获取的部分。
 */
export async function buildCapabilityCatalog(systemCode?: string): Promise<CapabilityCatalog> {
  const catalog: CapabilityCatalog = {
    tools: [],
    skills: [],
    workflows: [],
    nodeTypes: [...DAG_NODE_TYPES],
  }

  try {
    const tools = await toolApi.capabilities(systemCode)
    catalog.tools = tools.map(backendToolToCatalogTool)
  } catch (err) {
    console.warn('[CapabilityCatalog] 获取后端 tools 失败:', err)
  }

  try {
    const skills = await skillApi.listSkills()
    catalog.skills = skills.map(skillToCatalogSkill)
  } catch (err) {
    console.warn('[CapabilityCatalog] 获取 skills 失败:', err)
  }

  try {
    const workflows = await dagWorkflowApi.getAll()
    catalog.workflows = workflows.map(workflowToCatalogWorkflow)
  } catch (err) {
    console.warn('[CapabilityCatalog] 获取 workflows 失败:', err)
  }

  return catalog
}

export function formatCatalogForPrompt(catalog: CapabilityCatalog): string {
  const lines: string[] = []

  if (catalog.tools.length > 0) {
    lines.push('## 可用后端工具（优先使用）')
    for (const tool of catalog.tools) {
      lines.push(`- ${tool.name}: ${tool.description}`)
    }
    lines.push('')
  }

  if (catalog.skills.length > 0) {
    lines.push('## 可用技能')
    for (const skill of catalog.skills) {
      lines.push(`- ${skill.name} (${skill.id}): ${skill.description}`)
    }
    lines.push('')
  }

  if (catalog.workflows.length > 0) {
    lines.push('## 已保存工作流')
    for (const wf of catalog.workflows) {
      lines.push(`- ${wf.name} (${wf.id}): ${wf.description}`)
    }
    lines.push('')
  }

  lines.push('## 可用节点类型（仅当没有可用工具/工作流时才使用）')
  lines.push(catalog.nodeTypes.join(', '))

  return lines.join('\n')
}

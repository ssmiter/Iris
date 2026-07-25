/**
 * 系统提示词结构化构建器
 *
 * 将原本散落在 chatStore 中的字符串拼接（identity + webbridge + formatting + memory + skill）
 * 改造为带优先级和 section 标记的结构化数组。这样便于：
 * 1. 上下文截断时按优先级保留/丢弃某一段 system prompt。
 * 2. 观察 DevTools 时 system 消息按职责分段，而不是一个巨大字符串。
 * 3. 未来向后端动态 capabilities、memory、skill 注入预留扩展点。
 *
 * 设计借鉴 Claude Code 的 system prompt 分段思想，但只保留 WonWork 当前需要的段。
 */

import type { Message } from '@/types/mescli'
import type { FrontendToolRegistry } from '@/agent/toolRegistry'
import type { CapabilityRegistry } from '@/utils/capabilityRegistry'
import { getIdentityPrompt, getModeBoundaryTable, getModeMarketingPrompt } from '@/utils/identityPrompt'
import { getWebBridgeSystemPrompt } from '@/utils/webbridgePrompt'
import { getFormattingPrompt } from '@/utils/formattingPrompt'
import { getArtifactPresentationPrompt } from '@/utils/artifactPrompt'
import { formatCapabilityList } from '@/utils/capabilityRegistry'
import { buildToolPromptSections } from '@/utils/localToolPrompt'
import { getAllFiles } from '@/services/fileSystem'
import { buildWorkspaceDirsGuide, buildProjectGuide } from '@/config/workspaceDirs'
import { useProjectStore } from '@/stores/projectStore'

export type SystemPromptSectionName =
  | 'identity'
  | 'mode_boundary_table'
  | 'domain_insight'
  | 'capabilities'
  | 'tool_usage'
  | 'file_handling'
  | 'safety'
  | 'platform_composition'
  | 'workspace_manifest'
  | 'webbridge'
  | 'formatting'
  | 'marketing'
  | 'memory'
  | 'skill'

export interface SystemPromptSection {
  role: 'system'
  content: string
  section: SystemPromptSectionName
  /** 越小越优先保留；截断时按 priority 从大到小丢弃 */
  priority: number
}

/** 将能力清单注册表转换为结构化系统提示片段 */
export async function buildSystemPromptSections(
  registry: CapabilityRegistry,
  toolRegistry: FrontendToolRegistry,
  domainContext?: { systemCode?: string; domainInsight?: string }
): Promise<SystemPromptSection[]> {
  const sections: SystemPromptSection[] = []

  sections.push({
    role: 'system',
    content: getIdentityPrompt(registry, false),
    section: 'identity',
    priority: 1,
  })

  sections.push({
    role: 'system',
    content: getModeBoundaryTable(registry),
    section: 'mode_boundary_table',
    priority: 2,
  })

  // 业务域宏观洞察（domain_insight）：后端按当前登录域实时生成的目录统计自然语言，
  // 让模型在浏览任何目录之前就知道"这个域按什么流程组织、每段大约多少工具"，
  // 从而把意图直接定位到工序段，避免对几百个工具的盲目展开。
  const domainInsight = domainContext?.domainInsight?.trim()
  if (registry.mode === 'mescli-online' && domainInsight) {
    sections.push({
      role: 'system',
      content: `## 当前业务域概览（domain_insight）

${domainInsight}

以上是后端能力目录的实时统计。其他业务域的工具已按登录域隔离——既不会出现在你的能力目录中，也无法被调用，不要尝试按名猜测调用。
回答业务问题时：先按上述工序/业务对象分布判断目标工具最可能在哪个目录，再用 list_capabilities 浏览该目录、read_capability 读取具体工具的完整 schema 后调用；不要把所有目录全部展开。`,
      section: 'domain_insight',
      priority: 2,
    })
  }

  sections.push({
    role: 'system',
    content: formatCapabilityList(registry),
    section: 'capabilities',
    priority: 3,
  })

  const toolSections = buildToolPromptSections({
    mode: registry.mode,
    registry: toolRegistry,
    capabilities: registry,
  })
  for (const ts of toolSections) {
    sections.push({
      role: 'system',
      content: ts.content,
      section: ts.section,
      priority: 4,
    })
  }

  const artifactPrompt = getArtifactPresentationPrompt(toolRegistry)
  if (artifactPrompt) {
    sections.push({
      role: 'system',
      content: artifactPrompt,
      section: 'tool_usage',
      priority: 4,
    })
  }

  sections.push({
    role: 'system',
    content: getWebBridgeSystemPrompt(registry),
    section: 'webbridge',
    priority: 5,
  })

  sections.push({
    role: 'system',
    content: await buildWorkspaceManifestPrompt(),
    section: 'workspace_manifest',
    priority: 6,
  })

  sections.push({
    role: 'system',
    content: getFormattingPrompt(),
    section: 'formatting',
    priority: 7,
  })

  const marketingPrompt = getModeMarketingPrompt(registry)
  if (marketingPrompt) {
    sections.push({
      role: 'system',
      content: marketingPrompt,
      section: 'marketing',
      priority: 9,
    })
  }

  return sections
}

async function buildWorkspaceManifestPrompt(): Promise<string> {
  // S4：仅在选定项目时注入 /project 轨说明；未选定时逐字节不变
  const activeProject = useProjectStore.getState().activeProject
  const projectGuide = activeProject ? '\n' + buildProjectGuide(activeProject.path) + '\n' : ''
  try {
    const entries = await getAllFiles()
    const today = new Date()
    const dateDir = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

    const recent = entries
      .filter((e) => e.path.startsWith('/workspace/'))
      .sort((a, b) => {
        const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
        const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
        return tb - ta
      })
      .slice(0, 10)

    const lines = recent.map((e) => {
      const size = typeof e.size === 'number' ? `${e.size} bytes` : 'unknown'
      const updated = e.updatedAt ? new Date(e.updatedAt).toISOString() : 'unknown'
      return `- ${e.path} (size: ${size}, updated: ${updated})`
    })

    return `## 工作区清单（workspace_manifest）

当前工作区统一命名空间为 "/workspace/"。

${buildWorkspaceDirsGuide(dateDir)}
${projectGuide}
${recent.length > 0 ? '最近更新文件（最多 10 个）：\n' + lines.join('\n') : '当前工作区暂无文件。'}

你可以使用 list_files、read_file、execute_python_script 等工具操作这些文件。只读/计算类工具可自主组合；写文件、删文件、SQL 写操作等副作用工具必须遵守 read-before-write 与审批规则。`
  } catch (err) {
    return `## 工作区清单（workspace_manifest）

当前工作区统一命名空间为 "/workspace/"。

${buildWorkspaceDirsGuide(new Date().toISOString().slice(0, 10).replace(/-/g, ''))}
${projectGuide}
（工作区索引暂时不可用，请使用 list_files('/workspace') 重新发现文件。）`
  }
}

/** 把 memory 文本包装为结构化 system section */
export function buildMemorySection(memoryPrompt: string): SystemPromptSection | null {
  if (!memoryPrompt.trim()) return null
  return {
    role: 'system',
    content: memoryPrompt,
    section: 'memory',
    priority: 7,
  }
}

/** 把 skill prompts 包装为结构化 system sections */
export function buildSkillSections(skillPrompts: string[]): SystemPromptSection[] {
  return skillPrompts.map((content) => ({
    role: 'system',
    content,
    section: 'skill',
    priority: 8,
  }))
}

/** 将结构化 sections 转为后端/模型所需的 Message[] */
export function sectionsToMessages(sections: SystemPromptSection[]): Message[] {
  return sections.map((s) => ({
    role: s.role,
    content: s.content,
  }))
}

/** 按优先级排序：数字小的在前；同优先级保持原顺序 */
export function sortSectionsByPriority(sections: SystemPromptSection[]): SystemPromptSection[] {
  return [...sections].sort((a, b) => a.priority - b.priority)
}

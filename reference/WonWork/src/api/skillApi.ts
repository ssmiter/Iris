import type { SkillManifest, SkillPackage } from '@/types/skill'
import { fetchApi } from './client'
import { standaloneSkillApi } from './standaloneSkillApi'
import { parseSkillMdToManifest, skillToMarkdown } from '@/utils/workspaceStorage'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

/**
 * MESCLI 模式技能 API：通过后端 /api/skills 读写技能文件。
 * 后端默认将技能存储在 {InstallDir}\workspace\skills 下，无需用户手动选择文件夹。
 *
 * 单个 Skill 的读写/导入统一使用 text/markdown 格式（SKILL.md），列表仍返回 JSON 元数据。
 */
const mescliSkillApi = {
  listSkills: (): Promise<SkillManifest[]> =>
    fetchApi<SkillManifest[]>('/api/skills'),

  readSkill: async (id: string): Promise<SkillManifest | null> => {
    try {
      const text = await fetchApi<string>(`/api/skills/${encodeURIComponent(id)}`, {
        headers: { Accept: 'text/markdown' },
      })
      const manifest = parseSkillMdToManifest(text, id)
      return manifest
    } catch (err: any) {
      if (err.status === 404) return null
      throw err
    }
  },

  writeSkill: (skill: SkillManifest): Promise<SkillManifest> =>
    fetchApi<SkillManifest>(`/api/skills/${encodeURIComponent(skill.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      body: skillToMarkdown(skill),
    }),

  deleteSkill: (id: string): Promise<void> =>
    fetchApi<void>(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),

  importPackage: (pkg: SkillPackage): Promise<SkillManifest> =>
    fetchApi<SkillManifest>('/api/skills/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pkg),
    }),

  importMarkdown: (text: string): Promise<SkillManifest> =>
    fetchApi<SkillManifest>('/api/skills/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
      body: text,
    }),
}

export const skillApi = IS_STANDALONE ? standaloneSkillApi : mescliSkillApi

// 额外导出 MESCLI 专用方法，供 skillStore 在导入时使用
export async function importSkillPackage(pkg: SkillPackage): Promise<SkillManifest> {
  if (IS_STANDALONE) {
    const skill = {
      ...pkg.manifest,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await standaloneSkillApi.writeSkill(skill)
    return skill
  }
  return mescliSkillApi.importPackage(pkg)
}

export async function importMarkdownSkill(text: string): Promise<SkillManifest> {
  if (IS_STANDALONE) {
    const manifest = parseSkillMdToManifest(text, '')
    if (!manifest || !manifest.id) {
      throw new Error('无效的 Skill 文件')
    }
    const skill = {
      ...manifest,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await standaloneSkillApi.writeSkill(skill)
    return skill
  }
  return mescliSkillApi.importMarkdown(text)
}

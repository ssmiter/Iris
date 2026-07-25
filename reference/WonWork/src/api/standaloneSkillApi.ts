import type { SkillManifest } from '@/types/skill'
import {
  listSkills as fsListSkills,
  readSkill as fsReadSkill,
  writeSkill as fsWriteSkill,
  deleteSkill as fsDeleteSkill,
} from '@/utils/workspaceStorage'

/**
 * Standalone 模式技能 API：直接通过浏览器 File System Access API 读写本地目录。
 */
export const standaloneSkillApi = {
  listSkills: fsListSkills,

  readSkill: fsReadSkill,

  writeSkill: fsWriteSkill,

  deleteSkill: fsDeleteSkill,
}

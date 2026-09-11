import type { SkillManifest } from '@/types/skill'
import { getDomainPackEntry, listDomainPackNames } from '@/agent/domainPacks'

/**
 * 域知识包技能化（2026-08-09 S4 拍板）：让主 Agent 也能读到域知识。
 *
 * 背景：domain pack 原本只随 state agent（裁判）的系统提示注入，主 Agent（运动员）
 * 没有域知识，会先向用户自信报错（把引擎的状态谎报当真）再被对账纠正改口。
 *
 * 形态：不新增"知识库域"——skill 通道本质就是「元数据常驻 + 正文按需加载」的
 * 渐进披露管道，工艺与知识都适用；新增第二套发现通道才是额外负担。
 * 这里把 domainPacks 注册表里的每个包程序化生成一个内置技能条目：
 * - 单一事实来源仍是 domainPacks.ts 常量（state agent 注入不变），一处改、两个读者；
 * - 版本号=包版本：改包 bump version 后，skillStore 内置同步自动覆盖旧条目；
 * - userInvocable=false：领域知识不是用户动作，不进斜杠菜单；
 *   模型经元数据清单发现、文件原语读 SKILL.md 正文（层级 1→2 渐进披露）；
 * - 与后续沉淀的 APS 工艺类技能共存：元数据（whenToUse/keywords）负责区分，
 *   模型按 id 精确加载单个技能，不会一次读入多个。
 */

/** 各包的技能条目外观（正文与版本来自注册表，这里只给展示层信息） */
const PACK_SKILL_PRESENTATION: Record<
  string,
  {
    id: string
    name: string
    description: string
    whenToUse: string
    keywords: string[]
    icon: string
  }
> = {
  aps: {
    id: 'aps-domain-knowledge',
    name: 'APS 排产领域知识',
    description:
      '硫化排产的领域知识：排产链各角色分工、引擎脾气与状态谎报、完成判定真相、数据口径、写安全与发布判据。',
    // whenToUse 用「模式触发」而非示例提问（2026-08-25 用户拍板）：例子举不完且收窄想象，
    // 模式才抓得住——打算用 APS 工具的那一刻就是该读它的时刻（六个常驻 APS 工具首轮
    // 就在上下文，模型首轮必做这个判断，模糊提问零领域词也命中）。
    whenToUse:
      '判断标志很简单：你接下来打算调用 APS 排产相关工具（iris_aps_*）时，先读它再动手——它讲这套系统的分工、引擎的脾气与判据，不读就按字面理解引擎状态和业务对象，几乎必走岔。涉及排产、硫化、交期、齐套、模具机台、计划发布/下发的任务都算。',
    keywords: ['APS', '排产', '硫化', '粗排', '精排', '齐套', '胎胚', '模具', '机台', '发布', '下发', '交期'],
    icon: 'BookOpen',
  },
}

/** 由 domainPacks 注册表生成内置技能条目（skillStore 内置同步的数据源之一） */
export function buildDomainPackSkills(): SkillManifest[] {
  const skills: SkillManifest[] = []
  for (const packName of listDomainPackNames()) {
    const entry = getDomainPackEntry(packName)
    const presentation = PACK_SKILL_PRESENTATION[packName]
    if (!entry || !presentation) continue
    skills.push({
      id: presentation.id,
      name: presentation.name,
      description: presentation.description,
      whenToUse: presentation.whenToUse,
      domain: 'industrial',
      keywords: presentation.keywords,
      version: entry.version,
      author: 'WonWork',
      icon: presentation.icon,
      prompt: entry.content,
      enabled: true,
      userInvocable: false,
      installedAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      source: 'built-in',
    })
  }
  return skills
}

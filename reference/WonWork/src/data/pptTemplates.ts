/**
 * PPT 模板元数据
 * 对应 public/skills/pptx-presentation.SKILL.md 中的 5 套主题
 */

export interface PptTemplate {
  id: string
  name: string
  description: string
  /** 对应 create_pptx_document 工具的 template 参数值 */
  toolValue: string
  /** 适用场景标签 */
  tags: string[]
  /** 主题色板 */
  colors: {
    primary: string
    secondary: string
    accent: string
    background: string
    text: string
    cardBg: string
  }
}

export const PPT_TEMPLATES: PptTemplate[] = [
  {
    id: 'business-report',
    name: '商务汇报',
    description: '咨询锋锐风，适合工作汇报、年度总结、项目复盘',
    toolValue: 'business',
    tags: ['工作汇报', '年度总结'],
    colors: {
      primary: '#0A3161',
      secondary: '#E2E8F0',
      accent: '#0066CC',
      background: '#FFFFFF',
      text: '#1A202C',
      cardBg: '#FFFFFF',
    },
  },
  {
    id: 'academic',
    name: '学术报告',
    description: '经典灰雅风，适合论文答辩、学术分享、研究报告',
    toolValue: 'academic',
    tags: ['论文答辩', '学术分享'],
    colors: {
      primary: '#455A64',
      secondary: '#546E7A',
      accent: '#90A4AE',
      background: '#F5F7F8',
      text: '#37474F',
      cardBg: '#FFFFFF',
    },
  },
  {
    id: 'brand-promotion',
    name: '品牌推广',
    description: '午夜奢华风，适合品牌发布、产品推介、高端营销',
    toolValue: 'brand',
    tags: ['品牌发布', '产品推介'],
    colors: {
      primary: '#1A1A1A',
      secondary: '#8B7355',
      accent: '#C4A87C',
      background: '#F0EBE3',
      text: '#1A1A1A',
      cardBg: '#FFFFFF',
    },
  },
  {
    id: 'strategic',
    name: '战略规划',
    description: '午夜蓝铜风，适合战略会议、投资路演、董事会汇报',
    toolValue: 'strategy',
    tags: ['战略会议', '投资路演'],
    colors: {
      primary: '#0C1B33',
      secondary: '#1B3A5C',
      accent: '#B87333',
      background: '#FAFAF7',
      text: '#1A1A1A',
      cardBg: '#F0EDE8',
    },
  },
  {
    id: 'general',
    name: '通用展示',
    description: '蔚蓝冲击风，适合通用商务、产品介绍、培训课件',
    toolValue: 'general',
    tags: ['产品介绍', '培训课件'],
    colors: {
      primary: '#4F81BD',
      secondary: '#C0504D',
      accent: '#9BBB59',
      background: '#F8F9FA',
      text: '#333333',
      cardBg: '#FFFFFF',
    },
  },
]

export const PPT_SKILL_ID = 'pptx-presentation'

/** 触发 PPT 模板选择的关键词 */
export const PPT_TRIGGER_KEYWORDS = [
  'ppt', 'pptx', '幻灯片', '演示文稿', 'presentation', 'powerpoint', '生成ppt', '做ppt',
]

export function isPptTriggerMessage(content: string): boolean {
  const lower = content.toLowerCase()
  return PPT_TRIGGER_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))
}

/** 根据模板元数据生成强制使用指定模板的提示语（含编号、名称、具体色值） */
export function buildPptTemplatePrompt(template: PptTemplate, index: number): string {
  const c = template.colors
  return (
    `[必须使用 主题${index} ${template.name} 模板（template=${template.toolValue}）生成演示文稿]` +
    ` 配色强制使用：主色 primary=${c.primary}，辅色 secondary=${c.secondary}，` +
    `强调色 accent=${c.accent}，背景色 background=${c.background}，` +
    `文本色 text=${c.text}，卡片色 cardBg=${c.cardBg}。` +
    `禁止改用其他模板或配色。`
  )
}

/** 模板 ID → Skill 主题名称映射 */
export const PPT_TEMPLATE_THEME_NAMES: Record<string, string> = {
  'business-report': '主题1 商务汇报',
  'academic': '主题2 学术报告',
  'brand-promotion': '主题3 品牌推广',
  'strategic': '主题4 战略规划',
  'general': '主题5 通用展示',
}

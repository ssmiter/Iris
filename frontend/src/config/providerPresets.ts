/**
 * 内置供应商预设（2026-09-07）
 *
 * 预设即数据：形状与 cc-switch 预设相同（settingsConfig.env 为载体），
 * 精选常用款，不照搬 cc-switch 的赞助商清单。API Key 一律空占位由用户填。
 * modelsUrl 仅在候选推导到不了正确端点时覆写（如智谱 paas/v4、腾讯 plan/v3）。
 */
import type { ProviderProfile, ProviderProfileCategory } from '@/types/providerProfile'

export interface ProviderPreset {
  name: string
  category: ProviderProfileCategory
  websiteUrl?: string
  /** 申请 Key 的页面（卡片"获取 Key"链接用），空则用 websiteUrl */
  apiKeyUrl?: string
  apiFormat: 'anthropic' | 'openai'
  modelsUrl?: string
  env: Record<string, string>
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    name: 'DeepSeek',
    category: 'cn_official',
    websiteUrl: 'https://platform.deepseek.com',
    apiFormat: 'openai',
    env: {
      OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
      OPENAI_API_KEY: '',
      OPENAI_MODEL: 'deepseek-v4-flash',
    },
  },
  {
    name: 'DeepSeek（Anthropic 端点）',
    category: 'cn_official',
    websiteUrl: 'https://platform.deepseek.com',
    apiFormat: 'anthropic',
    modelsUrl: 'https://api.deepseek.com/models',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
    },
  },
  {
    name: 'Kimi',
    category: 'cn_official',
    websiteUrl: 'https://platform.kimi.com',
    apiFormat: 'openai',
    env: {
      OPENAI_BASE_URL: 'https://api.moonshot.cn/v1',
      OPENAI_API_KEY: '',
      OPENAI_MODEL: 'kimi-k2.6',
    },
  },
  {
    // 开放平台（按量计费线）的 Anthropic 兼容端点，与 Kimi For Coding 包月订阅
    // 是两条产品线、Key 不通用——已分别设预设，勿合并（2026-09-08 对照 cc-switch 核实）
    name: 'Kimi（Anthropic 端点）',
    category: 'cn_official',
    websiteUrl: 'https://platform.kimi.com',
    apiFormat: 'anthropic',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: 'kimi-k2.7-code',
    },
  },
  {
    name: 'Kimi For Coding',
    category: 'cn_official',
    websiteUrl: 'https://www.kimi.com/code/',
    apiFormat: 'anthropic',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.kimi.com/coding/',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: 'kimi-for-coding',
    },
  },
  {
    name: '智谱 GLM',
    category: 'cn_official',
    websiteUrl: 'https://open.bigmodel.cn',
    apiFormat: 'anthropic',
    modelsUrl: 'https://open.bigmodel.cn/api/paas/v4/models',
    env: {
      ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: 'glm-5.3',
    },
  },
  {
    name: '火山 Coding Plan',
    category: 'cn_official',
    websiteUrl: 'https://www.volcengine.com/product/ark',
    apiFormat: 'anthropic',
    env: {
      ANTHROPIC_BASE_URL: 'https://ark.cn-beijing.volces.com/api/coding',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: 'ark-code-latest',
    },
  },
  {
    name: '腾讯 Token Plan',
    category: 'cn_official',
    websiteUrl: 'https://cloud.tencent.com/product/tokenhub',
    apiFormat: 'anthropic',
    modelsUrl: 'https://api.lkeap.cloud.tencent.com/plan/v3/models',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.lkeap.cloud.tencent.com/plan/anthropic',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: 'tc-code-latest',
    },
  },
  {
    name: 'SiliconFlow',
    category: 'aggregator',
    websiteUrl: 'https://siliconflow.cn',
    apiFormat: 'openai',
    env: {
      OPENAI_BASE_URL: 'https://api.siliconflow.cn/v1',
      OPENAI_API_KEY: '',
      OPENAI_MODEL: 'Pro/MiniMaxAI/MiniMax-M2.5',
    },
  },
  {
    name: 'OpenRouter',
    category: 'aggregator',
    websiteUrl: 'https://openrouter.ai',
    apiFormat: 'openai',
    env: {
      OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENAI_API_KEY: '',
      OPENAI_MODEL: 'anthropic/claude-sonnet-5',
    },
  },
  {
    name: '自定义 Anthropic 兼容',
    category: 'custom',
    apiFormat: 'anthropic',
    env: {
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_MODEL: '',
    },
  },
  {
    name: '自定义 OpenAI 兼容',
    category: 'custom',
    apiFormat: 'openai',
    env: {
      OPENAI_BASE_URL: '',
      OPENAI_API_KEY: '',
      OPENAI_MODEL: '',
    },
  },
]

/** 预设 → 新 profile 草稿（未入库，编辑面板填好后保存） */
export function presetToProfileDraft(preset: ProviderPreset, id: string): ProviderProfile {
  return {
    id,
    name: preset.name,
    category: preset.category,
    websiteUrl: preset.websiteUrl,
    settingsConfig: { env: { ...preset.env } },
    meta: { apiFormat: preset.apiFormat, modelsUrl: preset.modelsUrl },
    createdAt: Date.now(),
  }
}

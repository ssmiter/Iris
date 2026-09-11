/**
 * 供应商预设表（自 standaloneApi.ts 迁出，2026-09 standalone 死代码清理）。
 *
 * 原 standaloneApi.ts 是 WonWork standalone 模式（IndexedDB 本地历史 + 直连 Provider）
 * 的实现，Iris 下 IS_STANDALONE 恒 false、整体为死代码；唯一仍被活代码消费的
 * 是这份供应商预设（name/baseUrl/defaultModel）：
 * - ChatView 用 baseUrl/defaultModel 做内置供应商补齐目录；
 * - client.ts 的 normalizeBackendProviderConfig 用 defaultModel 做旧模型升级判断。
 *
 * 因此把"预设常量"单独留在这里，直连 Provider 的请求构造/流解析随 standaloneApi
 * 一并删除（接口字段保留，便于后续恢复直连或给 UI 展示用）。
 */

export interface ProviderPreset {
  name: string
  baseUrl: string
  defaultModel: string
  /** 是否支持 function calling（OpenAI 兼容 provider 默认 true） */
  supportsTools?: boolean
}

const openai = (name: string, baseUrl: string, defaultModel: string): ProviderPreset => ({
  name,
  baseUrl,
  defaultModel,
  supportsTools: true,
})

const anthropic = (name: string, baseUrl: string, defaultModel: string): ProviderPreset => ({
  name,
  baseUrl,
  defaultModel,
  supportsTools: true,
})

export const PROVIDERS: Record<string, ProviderPreset> = {
  openai: openai('OpenAI', 'https://api.openai.com/v1', 'gpt-5.5'),
  kimi: openai('Kimi', 'https://api.moonshot.cn/v1', 'kimi-k2.6'),
  claude: anthropic('Claude (Anthropic)', 'https://api.anthropic.com', 'claude-sonnet-4-6'),

  // 国产模型预设（OpenAI 兼容）
  deepseek: openai('DeepSeek', 'https://api.deepseek.com', 'deepseek-v4-flash'),
  // Kimi Code 走 Anthropic 兼容端点；2026-07-28 用户拍板模型名以本机实测可用值 kimi-k2.7-code 为准
  'kimi-code': anthropic('KimiCode', 'https://api.kimi.com/coding/', 'kimi-k2.7-code'),

  qwen: openai('Qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus'),
  zhipu: openai('Zhipu GLM', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4.7'),
  baichuan: openai('Baichuan', 'https://api.baichuan-ai.com/v1', 'Baichuan4'),
  spark: openai('Spark', 'https://spark-api-open.xf-yun.com/v1', 'generalv4'),
  hunyuan: openai('Hunyuan', 'https://api.hunyuan.cloud.tencent.com/v1', 'hunyuan-turbos-latest'),
  doubao: openai('Doubao', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-2-1-pro'),
  ernie: openai('ERNIE', 'https://qianfan.baidubce.com/v2', 'ernie-5.1'),

  // 火山方舟 Ark Code（OpenAI 兼容协议）
  'ark-code-latest': openai('Ark Code', 'https://ark.cn-beijing.volces.com/api/coding/v1', 'ark-code-latest'),

  // 私有化/自建 OpenAI 兼容端点（cc-switch 式自定义 API 配置入口）
  custom: { name: 'Custom (OpenAI-compatible)', baseUrl: '', defaultModel: '', supportsTools: true },
}

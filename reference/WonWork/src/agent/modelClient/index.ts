import {
  createModelClient as createModelClientBase,
  registerModelClient,
  isAnthropicCompatibleProvider,
  modelClientSupportsTools,
  providerSupportsDeferredLoading,
} from './modelClient'
import { createOpenAIModelClient } from './openaiModelClient'
import { createAnthropicModelClient } from './anthropicModelClient'
import { createLocalModelClient } from './localModelClient'

// 注册云端 OpenAI 兼容 Provider
registerModelClient('openai', (baseUrl) => createOpenAIModelClient('openai', baseUrl))
registerModelClient('kimi', (baseUrl) => createOpenAIModelClient('kimi', baseUrl))
registerModelClient('deepseek', (baseUrl) => createOpenAIModelClient('deepseek', baseUrl))
registerModelClient('qwen', (baseUrl) => createOpenAIModelClient('qwen', baseUrl))
registerModelClient('zhipu', (baseUrl) => createOpenAIModelClient('zhipu', baseUrl))
registerModelClient('baichuan', (baseUrl) => createOpenAIModelClient('baichuan', baseUrl))
registerModelClient('spark', (baseUrl) => createOpenAIModelClient('spark', baseUrl))
registerModelClient('hunyuan', (baseUrl) => createOpenAIModelClient('hunyuan', baseUrl))
registerModelClient('doubao', (baseUrl) => createOpenAIModelClient('doubao', baseUrl))
registerModelClient('ernie', (baseUrl) => createOpenAIModelClient('ernie', baseUrl))
registerModelClient('custom', (baseUrl) => createOpenAIModelClient('custom', baseUrl))

// 注册 Anthropic 兼容 Provider
registerModelClient('claude', (baseUrl) => createAnthropicModelClient('claude', baseUrl))
registerModelClient('kimi-code', (baseUrl) => createAnthropicModelClient('kimi-code', baseUrl))
registerModelClient('anthropic', (baseUrl) => createAnthropicModelClient('anthropic', baseUrl))

// 注册本地模型 Provider
registerModelClient('ollama', (baseUrl) => createLocalModelClient('ollama', baseUrl))
registerModelClient('lmstudio', (baseUrl) => createLocalModelClient('lmstudio', baseUrl))
registerModelClient('webllm', (baseUrl) => createLocalModelClient('webllm', baseUrl))

export const createModelClient = createModelClientBase
export {
  isAnthropicCompatibleProvider,
  modelClientSupportsTools,
  providerSupportsDeferredLoading,
}
export type { ModelClient, ModelClientRequest, ModelClientStreamCallbacks } from './modelClient'

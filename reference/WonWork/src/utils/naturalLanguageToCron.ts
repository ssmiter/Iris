import { chatApi, userConfigApi } from '@/api/client'
import { useChatStore } from '@/stores/chatStore'
import { useApiKeyStore } from '@/stores/apiKeyStore'
import type { Message } from '@/types/mescli'
import CronExpressionParser from 'cron-parser'

const SYSTEM_PROMPT = `You are a cron expression assistant. Convert the user's natural language schedule description into a standard 5-field cron expression.

Output ONLY a JSON object with this exact schema (no markdown, no explanation):

{
  "expression": "0 9 * * 1-5",
  "description": "Every weekday at 9:00 AM"
}

Rules:
- The expression must have exactly 5 fields: minute hour day-of-month month day-of-week.
- minute: 0-59
- hour: 0-23
- day-of-month: 1-31 or *
- month: 1-12 or *
- day-of-week: 0-7 (0 and 7 both mean Sunday) or *; use 1-5 for Monday-Friday.
- Prefer standard patterns:
  - Every minute: "* * * * *"
  - Every 5 minutes: "*/5 * * * *"
  - Every hour at :00: "0 * * * *"
  - Every day at 9:00 AM: "0 9 * * *"
  - Every weekday at 9:00 AM: "0 9 * * 1-5"
  - Every Monday at 2:30 AM: "30 2 * * 1"
  - 1st of every month at midnight: "0 0 1 * *"
  - Every Sunday at midnight: "0 0 * * 0"
- If the request is ambiguous, choose the most common interpretation.
- Do not include seconds field.
- The description should be a short human-readable summary in the same language as the user's input.`

export interface NaturalLanguageCronResult {
  expression: string
  description: string
}

function extractJson(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) return codeBlockMatch[1].trim()
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1)
  }
  return text.trim()
}

export function getNextRunTimes(expression: string, count = 5): string[] {
  try {
    const interval = CronExpressionParser.parse(expression)
    const times: string[] = []
    for (let i = 0; i < count; i++) {
      const next = interval.next().toISOString()
      if (next) times.push(next)
    }
    return times
  } catch {
    return []
  }
}

export function isValidCron(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression)
    return true
  } catch {
    return false
  }
}

export async function generateCronFromNaturalLanguage(
  description: string
): Promise<NaturalLanguageCronResult> {
  const provider = useChatStore.getState().activeProvider
  if (!provider) {
    throw new Error('未配置 AI 模型，请先在对话中选择一个模型')
  }

  let apiKey: string | undefined
  let baseUrl: string | undefined
  const defaultByok = useApiKeyStore.getState().getDefaultApiKey('chat')
  if (defaultByok && !defaultByok.isPlatformManaged) {
    apiKey = defaultByok.key
    baseUrl = defaultByok.baseUrl
  } else {
    try {
      const keyResult = await userConfigApi.getApiKey(provider.provider)
      apiKey = keyResult.apiKey
    } catch {
      // ignore
    }
  }

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: description },
  ]

  return new Promise((resolve, reject) => {
    let accumulated = ''
    const abort = chatApi.streamChat(
      {
        provider: provider.provider,
        model: provider.model,
        baseUrl: baseUrl || provider.baseUrl,
        apiKey,
        messages,
      },
      (chunk) => {
        if (chunk.type === 'content') {
          accumulated += chunk.content || ''
        }
      },
      (error) => reject(error),
      () => {
        try {
          const jsonText = extractJson(accumulated)
          const parsed = JSON.parse(jsonText) as Partial<NaturalLanguageCronResult>
          const expression = parsed.expression?.trim() || ''
          if (!isValidCron(expression)) {
            throw new Error(`生成的 Cron 表达式无效：${expression}`)
          }
          resolve({
            expression,
            description: parsed.description?.trim() || description,
          })
        } catch (err) {
          reject(err instanceof Error ? err : new Error('解析生成的 Cron 失败'))
        }
      }
    )

    setTimeout(() => {
      abort()
      reject(new Error('生成 Cron 超时'))
    }, 60000)
  })
}

import type { PromptContext, PromptSectionDef } from './types'

/**
 * 提示词组合器：
 * 1. 按 when 过滤出本次注入的小节；
 * 2. 按数组顺序自动编号（### n. 标题）——重排小节只需挪动数组行，不会产生悬空引用；
 * 3. 解析正文中的 {ref:id} / {ref:id|兜底文案} 交叉引用为实际节号（目标节未注入时用兜底文案）；
 * 4. 缓存分层检查：session 节出现在 static 节之前时 console.warn（不阻断）。
 */
export function composeSections(ctx: PromptContext, defs: PromptSectionDef[]): string {
  const active = defs.filter((d) => !d.when || d.when(ctx))
  const numbers = new Map(active.map((d, i) => [d.id, i + 1]))

  let seenSession = false
  for (const d of active) {
    if (d.stability === 'session') seenSession = true
    else if (seenSession) {
      console.warn(`[prompt] static 小节 "${d.id}" 排在 session 小节之后——会破坏前缀缓存分层，请调整 sections 数组顺序`)
    }
  }

  return active
    .map((d) => {
      const n = numbers.get(d.id)!
      const body = d
        .build(ctx)
        .replace(/\{ref:([\w-]+)(?:\|([^}]*))?\}/g, (raw, id: string, fallback?: string) => {
          const target = numbers.get(id)
          if (target) return `§${target}`
          if (fallback) return fallback
          console.warn(`[prompt] 小节 "${d.id}" 引用了未注入的小节 "${id}"，且无兜底文案`)
          return raw
        })
      return `### ${n}. ${d.title}\n${body.replace(/^\n+/, '')}`
    })
    .join('\n\n')
}

import type { PipelineDefinition, PipelineTransportOptions } from '@/agent/pipelineRunner'
import { createPipelineTransport, runPipeline } from '@/agent/pipelineRunner'
import type { MemoryFileType } from '@/types/memoryFile'
import { MEMORY_FILE_TYPES, buildMemoryFileContent, memoryFileName } from '@/types/memoryFile'
import { useFileMemoryStore } from '@/stores/fileMemoryStore'
import { buildMemoryRememberPrompt } from './prompt'

/**
 * 手动记忆誊写 pipeline（记忆之野 2026-07-31；2026-09-03 重指文件存储）。
 *
 * 触发入口唯一化：用户选中正文后**显式点击**"收入记忆"（选中本身零副作用——
 * 划词是阅读习惯，绝不能选中即触发）。模型侧的 memory_write 工具已随记忆
 * 文件化退役：模型要记东西，用文件原语直接写 ~/.wonwork/memory/，不再过本管线。
 *
 * prompt 职责不变：不判断该不该记（来源已初筛），只做改写、归类、查重合并。
 * 落库形态：ADD=新文件+索引行；MERGE=改写目标文件+更新索引行；
 * 失败兜底存原文——尊重收入意图，不丢。
 */

// ───────────────────────── 敏感黑名单（代码兜底，提示词是第一道） ─────────────────────────
// （2026-09-03 从 memoryExtraction 迁入——自动提取管线已删除，本闸门仍是誊写入口的硬地板）

const SENSITIVE_PATTERNS: RegExp[] = [
  /(password|passwd|pwd|密码|口令)\s*[:：=]?\s*\S{4,}/i,
  /(api[_-]?key|secret|token|密钥|令牌|凭据)\s*[:：=]?\s*[A-Za-z0-9_\-]{8,}/i,
  /\b\d{17}[\dXx]\b/, // 身份证
  /\b1[3-9]\d{9}\b/, // 手机号
  /\b\d{16,19}\b/, // 银行卡号
]

/** 敏感内容判定：密钥/证件号等永不入库，即使用户明选（跨会话扩散面太大） */
export function isSensitiveContent(text: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(text))
}

export interface MemoryRememberInput {
  selectedText: string
  contextMessages: Array<{ role: 'user' | 'assistant'; text: string }>
  /** 近义/近期旧记忆清单（查重依据）：id=文件相对路径——MERGE 要基于旧条目改写，只给摘要会盲改丢信息 */
  existingMemories: Array<{ id: string; type: string; content: string }>
}

export interface MemoryRememberOutput {
  action: 'ADD' | 'MERGE' | 'SKIP'
  /** 仅 SKIP：一句给用户看的温和理由 */
  reason?: string
  /** 仅 MERGE：目标记忆文件相对路径 */
  target_id?: string
  content: string
  type: MemoryFileType
  /** 一句话速览（索引行 description） */
  summary?: string
}

const VALID_TYPES = new Set<string>(MEMORY_FILE_TYPES)

export const memoryRememberPipeline: PipelineDefinition<MemoryRememberInput, MemoryRememberOutput> = {
  name: 'memory_remember',
  buildPrompt: buildMemoryRememberPrompt,
  output: {
    kind: 'json',
    parse: (value) => {
      if (!value || typeof value !== 'object') return null
      const d = value as Record<string, unknown>
      const action = typeof d.action === 'string' ? d.action.toUpperCase() : ''
      if (action !== 'ADD' && action !== 'MERGE' && action !== 'SKIP') return null
      if (action === 'SKIP') {
        return {
          action: 'SKIP',
          reason: typeof d.reason === 'string' && d.reason.trim() ? d.reason.trim().slice(0, 60) : undefined,
          content: '',
          type: 'project',
        }
      }
      if (typeof d.content !== 'string' || d.content.trim().length < 2) return null
      if (action === 'MERGE' && (typeof d.target_id !== 'string' || !d.target_id.trim())) return null
      const type = typeof d.type === 'string' && VALID_TYPES.has(d.type) ? (d.type as MemoryFileType) : 'project'
      return {
        action,
        target_id: typeof d.target_id === 'string' ? d.target_id.trim() : undefined,
        content: d.content.trim().slice(0, 500),
        type,
        summary: typeof d.summary === 'string' && d.summary.trim() ? d.summary.trim().slice(0, 60) : undefined,
      }
    },
  },
  maxTokens: 4096,
  temperature: 0.2,
  maxRetries: 1,
  timeoutMs: 45_000,
}

export interface RememberSelectionResult {
  ok: boolean
  merged?: boolean
  skipped?: boolean
  /** 模型判断不值得记（用户可在 UI 上推翻，force 重试） */
  declined?: boolean
  /** SKIP 时模型给用户看的理由 */
  reason?: string
  summary?: string
  /** 落桶（用户反馈用："已收入 · 反馈"） */
  bucket?: MemoryFileType
}

/** 30 秒同文短路：重复点击不重复跑 pipeline（防呆第二层）。
 * 纪律：只在落库成功后写入——失败/挂起后立刻重试必须真跑，否则会把"没存上"误报成 duplicate */
let lastRemember: { text: string; at: number } | null = null
const markRemembered = (text: string): void => {
  lastRemember = { text, at: Date.now() }
}

/** 索引行 description 的兜底：summary 缺省时取正文首句 */
function descOf(summary: string | undefined, content: string): string {
  return (summary || content).slice(0, 30)
}

/**
 * 手动收入记忆：LLM 誊写 → ADD/MERGE 落文件；失败兜底存原文。
 * 永不抛出——调用方根据返回值出 toast 即可。
 */
export async function rememberSelection(
  selectedText: string,
  conversationId: number | null,
  contextMessages: MemoryRememberInput['contextMessages'],
  transportOpts: Omit<PipelineTransportOptions, 'conversationId'>,
  opts?: { force?: boolean }
): Promise<RememberSelectionResult> {
  const text = selectedText.trim().slice(0, 500)
  if (text.length < 2) return { ok: false, skipped: true }

  const now = Date.now()
  if (!opts?.force && lastRemember && lastRemember.text === text && now - lastRemember.at < 30_000) {
    return { ok: true, skipped: true }
  }

  if (isSensitiveContent(text)) {
    console.warn('[memoryRemember] 敏感内容闸门拦截，未入库（命中密码/密钥/证件号类正则）')
    return { ok: false }
  }

  const store = useFileMemoryStore.getState()
  await store.initialize()

  try {
    // 查重依据：近期文件（mtime 倒序前 12 条）+ 与选中文字有词面重叠的文件（最多 8 条）。
    // 语义检索已随 embedding 退役；记忆文件量级在 200 上限内，词面重叠足够捞起近义候选。
    const byRecency = store.entries.slice(0, 12)
    const byOverlap = store.searchMemoryFiles(text, 8)
    const seen = new Set<string>()
    const existingMemories: MemoryRememberInput['existingMemories'] = []
    for (const e of [...byOverlap, ...byRecency]) {
      if (seen.has(e.relativePath)) continue
      seen.add(e.relativePath)
      existingMemories.push({
        id: e.relativePath,
        type: e.type || 'note',
        content: (e.content || e.description || '').slice(0, 200),
      })
    }

    const transport = createPipelineTransport({
      ...transportOpts,
      ...(conversationId != null ? { conversationId } : {}),
    })
    const result = await runPipeline(
      memoryRememberPipeline,
      { selectedText: text, contextMessages, existingMemories },
      transport
    )

    if (result.ok && result.value) {
      const v = result.value
      // SKIP：模型判断不值得记——除非用户已明确推翻（force），否则尊重判断并回传理由
      if (v.action === 'SKIP' && !opts?.force) {
        return { ok: true, declined: true, reason: v.reason }
      }
      if (v.action === 'MERGE' && v.target_id) {
        const target = useFileMemoryStore
          .getState()
          .entries.find((e) => e.relativePath === v.target_id)
        if (target) {
          const name = target.name || (v.summary ?? v.content.slice(0, 20))
          await useFileMemoryStore
            .getState()
            .writeMemoryFile(
              target.relativePath,
              buildMemoryFileContent(name, descOf(v.summary, v.content), v.type, v.content)
            )
          await useFileMemoryStore
            .getState()
            .upsertIndexLine(target.relativePath, name, descOf(v.summary, v.content))
          markRemembered(text)
          return { ok: true, merged: true, summary: v.summary || v.content.slice(0, 30), bucket: v.type }
        }
        // target 找不到 → 降级 ADD
      }
      // force + SKIP：模型仍坚持不记，但用户已拍板——存原文，尊重用户主权
      const content = v.action === 'SKIP' ? text : v.content
      const type = v.action === 'SKIP' ? undefined : v.type
      const name = (v.summary ?? content.slice(0, 20)).trim()
      const path = uniqueName(name)
      const ok = await useFileMemoryStore
        .getState()
        .writeMemoryFile(path, buildMemoryFileContent(name, descOf(v.summary, content), type, content))
      if (ok) {
        await useFileMemoryStore.getState().upsertIndexLine(path, name, descOf(v.summary, content))
        markRemembered(text)
        return { ok: true, summary: v.summary || content.slice(0, 30), bucket: type }
      }
    }
  } catch (err) {
    console.warn('[memoryRemember] pipeline 失败，兜底存原文:', err)
  }

  // 兜底：pipeline 不可用（无凭据/超时/解析失败）时存原文——收入意图明确，不丢
  const ok = await useFileMemoryStore.getState().addQuickNote(text)
  if (ok) {
    markRemembered(text)
    return { ok: true, summary: text.slice(0, 30) }
  }
  return { ok: false }
}

/** 文件名去重（与 fileMemoryStore 内部同律，此处需要路径先行故外露一层） */
function uniqueName(name: string): string {
  const entries = useFileMemoryStore.getState().entries
  const base = memoryFileName(name || 'note')
  const taken = new Set(entries.map((e) => e.relativePath))
  if (!taken.has(base)) return base
  const stem = base.replace(/\.md$/, '')
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem}-${i}.md`
    if (!taken.has(candidate)) return candidate
  }
  return `${stem}-${Date.now()}.md`
}

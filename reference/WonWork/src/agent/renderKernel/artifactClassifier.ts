/**
 * artifactClassifier — 产物单一分类器（纯函数、可单测）
 *
 * 替换 agenticLoop / WaterfallTurn / renderNodeBuilder 三处不一致的分类逻辑。
 * 新增产物类型只需注册 detector + 注册 View 两处改动。
 *
 * 设计依据：wonwork-终态转移总体设计-v3.0.md 系统二 §2.2
 */

import type { ArtifactType } from '@/types/chat'

// ── 类型 ────────────────────────────────────────────────

export interface ClassifyContext {
  toolName?: string
  toolCallId?: string
}

export interface ClassifiedArtifact {
  artifactType: ArtifactType
  title: string
  payload: unknown
}

type Detector = (data: unknown, ctx: ClassifyContext) => ClassifiedArtifact | null

// ── 检测器注册表 ─────────────────────────────────────────

const detectors: Detector[] = []

export function registerDetector(d: Detector): void {
  detectors.push(d)
}

// ── 公共入口 ─────────────────────────────────────────────

export function classifyArtifact(
  data: unknown,
  ctx: ClassifyContext = {}
): ClassifiedArtifact | null {
  if (!data || typeof data !== 'object') return null
  // 有些工具把实际数据包在 .data / .result / .output 里
  const inner = (data as Record<string, unknown>).data
    ?? (data as Record<string, unknown>).result
    ?? (data as Record<string, unknown>).output
  for (const d of detectors) {
    // 外层命中
    const hit = d(data, ctx)
    if (hit) return hit
    // 内层命中
    if (inner && typeof inner === 'object' && inner !== data) {
      const innerHit = d(inner, ctx)
      if (innerHit) return innerHit
    }
  }
  return null
}

// ── 五个内置检测器（注册顺序 = 优先级：先特异性后通用） ──

// 1. browser — webbridge 执行结果
registerDetector((data, ctx) => {
  if (ctx.toolName === 'webbridge_execute' || ctx.toolName === 'playwright_navigate' || ctx.toolName === 'browser_navigate') {
    const d = data as Record<string, unknown>
    const steps = d.steps || d.workflow || (d as Record<string, unknown>).actions
    return {
      artifactType: 'browser' as ArtifactType,
      title: '浏览器操作',
      payload: {
        steps: steps ?? [],
        finalUrl: d.finalUrl ?? d.url ?? '',
        status: d.status ?? 'completed',
      },
    }
  }
  return null
})

// 2. image — 含 base64/URL 的图片结果
registerDetector((data) => {
  const d = data as Record<string, unknown>

  // base64 data-url
  const screenshot = d.screenshot ?? d.image ?? d.imageData ?? d.imageBase64
  if (typeof screenshot === 'string' && screenshot.startsWith('data:image/')) {
    return {
      artifactType: 'image' as ArtifactType,
      title: (d.title as string) ?? (d.caption as string) ?? '图片',
      payload: { src: screenshot, alt: (d.alt as string) ?? (d.caption as string) ?? '' },
    }
  }

  // HTTP image URL
  const imageUrl = d.imageUrl ?? d.image_url ?? d.url
  if (typeof imageUrl === 'string' && /\.(png|jpg|jpeg|webp|gif|svg)(\?|$)/i.test(imageUrl)) {
    return {
      artifactType: 'image' as ArtifactType,
      title: (d.title as string) ?? (d.caption as string) ?? '图片',
      payload: { src: imageUrl, alt: (d.alt as string) ?? '' },
    }
  }

  // mimeType 以 image/ 开头
  const mime = d.mimeType ?? d.mime_type ?? d.contentType
  if (typeof mime === 'string' && mime.startsWith('image/')) {
    const src = (d.url ?? d.downloadUrl ?? screenshot) as string | undefined
    if (src) {
      return {
        artifactType: 'image' as ArtifactType,
        title: (d.title as string) ?? '图片',
        payload: { src, alt: '' },
      }
    }
  }

  return null
})

// 3. chart — 柱状图/图表（保留现有 chartType 逻辑）
registerDetector((data) => {
  const d = data as Record<string, unknown>
  if (d.chartType || d.type === 'chart' || d.chart || d.bars) {
    const bars = d.bars ?? d.data ?? d
    if (bars && typeof bars === 'object' && Array.isArray((bars as Record<string, unknown>).bars ? (bars as Record<string, unknown>).bars : bars)) {
      return {
        artifactType: 'chart' as ArtifactType,
        title: (d.title as string) ?? (d.label as string) ?? '图表',
        payload: bars,
      }
    }
    return {
      artifactType: 'chart' as ArtifactType,
      title: (d.title as string) ?? '图表',
      payload: d,
    }
  }
  return null
})

// 4. file — 含文件信息的工具结果
registerDetector((data) => {
  const d = data as Record<string, unknown>
  const files = d.files ?? d.workspaceFiles ?? d.generatedFiles
  if (Array.isArray(files) && files.length > 0) {
    return {
      artifactType: 'file' as ArtifactType,
      title: (d.title as string) ?? `输出 ${files.length} 个文件`,
      payload: {
        files: files.map((f: Record<string, unknown>) => ({
          name: f.name ?? f.fileName ?? f.path ?? '',
          size: f.size ?? f.fileSize,
          downloadUrl: f.downloadUrl ?? f.url ?? f.download_url,
          path: f.path,
        })),
      },
    }
  }
  // 单文件直接有 downloadUrl + fileName
  if (d.downloadUrl && d.fileName) {
    return {
      artifactType: 'file' as ArtifactType,
      title: (d.fileName as string) ?? '文件',
      payload: {
        files: [{
          name: d.fileName as string,
          size: d.fileSize as number | undefined,
          downloadUrl: d.downloadUrl as string,
        }],
      },
    }
  }
  return null
})

// 5. table — 表格数据（行数 ≥ 6 才提升为产物卡）
const TABLE_MIN_ROWS = 6

function tryExtractRows(data: unknown): unknown[] | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  // 直接是数组
  if (Array.isArray(data)) return data as unknown[]
  // { rows: [...] }
  if (Array.isArray(d.rows)) return d.rows as unknown[]
  // { data: [...] }
  if (Array.isArray(d.data)) return d.data as unknown[]
  // { headers: [...], data: [...] }
  if (Array.isArray(d.headers) && Array.isArray(d.data)) return d.data as unknown[]
  return null
}

registerDetector((data) => {
  const rows = tryExtractRows(data)
  if (rows && rows.length >= TABLE_MIN_ROWS) {
    const d = data as Record<string, unknown>
    return {
      artifactType: 'table' as ArtifactType,
      title: (d.title as string) ?? (d.label as string) ?? `表格 (${rows.length} 行)`,
      payload: { rows, headers: d.headers ?? d.columns ?? null },
    }
  }
  return null
})

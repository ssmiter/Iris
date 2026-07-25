/**
 * artifactViews — 按 ArtifactType 分发的产物渲染器
 *
 * 五类视图：TableView / ChartView / ImageView / FileView / BrowserView
 * + JsonFallback 兜底
 *
 * 设计依据：wonwork-终态转移总体设计-v3.0.md 系统二 §2.2
 */

import type { ArtifactNode } from '@/types/chat'
import { extractTableRows } from './InlineTable'
import { InlineTable } from './InlineTable'

// ── Props ──────────────────────────────────────────────────

interface ArtifactViewProps {
  artifact: ArtifactNode
  onViewFullscreen?: (artifactId: string) => void
}

// ── 分发入口 ───────────────────────────────────────────────

export function renderArtifactPreview(artifact: ArtifactNode, onViewFullscreen?: (artifactId: string) => void) {
  switch (artifact.artifactType) {
    case 'table':
      return <TableView artifact={artifact} onViewFullscreen={onViewFullscreen} />
    case 'chart':
      return <ChartView artifact={artifact} onViewFullscreen={onViewFullscreen} />
    case 'image':
      return <ImageView artifact={artifact} onViewFullscreen={onViewFullscreen} />
    case 'file':
      return <FileView artifact={artifact} onViewFullscreen={onViewFullscreen} />
    case 'browser':
      return <BrowserView artifact={artifact} onViewFullscreen={onViewFullscreen} />
    default:
      return <JsonFallback artifact={artifact} />
  }
}

// ── Table ──────────────────────────────────────────────────

function TableView({ artifact, onViewFullscreen }: ArtifactViewProps) {
  const payload = artifact.payload as { rows?: unknown[]; headers?: string[] }
  const rows = payload?.rows ?? extractTableRows(artifact.payload) ?? []
  const headers = payload?.headers as string[] | undefined
  if (!rows || rows.length === 0) return null

  return (
    <div className="wf-artifact-table">
      <div style={{ maxHeight: 240, overflow: 'auto' }}>
        <InlineTable rows={rows as Record<string, unknown>[]} />
      </div>
      <div className="wf-artifact-actions">
        <button className="wf-artifact-btn" onClick={() => onViewFullscreen?.(artifact.artifactId)}>
          全屏查看
        </button>
      </div>
    </div>
  )
}

// ── Chart ──────────────────────────────────────────────────

function ChartView({ artifact, onViewFullscreen }: ArtifactViewProps) {
  const payload = artifact.payload as Record<string, unknown>
  const bars = (payload?.bars ?? payload?.data ?? []) as { label?: string; value?: number; name?: string; count?: number }[]
  if (!Array.isArray(bars) || bars.length === 0) {
    return <JsonFallback artifact={artifact} />
  }

  const maxVal = Math.max(...bars.map((b) => b.value ?? b.count ?? 0), 1)
  return (
    <div className="wf-artifact-chart">
      <div className="wf-chart-bars" style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 140, padding: '0 4px' }}>
        {bars.slice(0, 20).map((b, i) => {
          const val = b.value ?? b.count ?? 0
          const h = `${Math.max((val / maxVal) * 100, 4)}%`
          return (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
              <span style={{ fontSize: 10, color: '#64748b', marginBottom: 2 }}>{val}</span>
              <div style={{ width: '100%', height: h, background: 'linear-gradient(to top, #2563eb, #60a5fa)', borderRadius: '4px 4px 0 0', minHeight: 4 }} />
              <span style={{ fontSize: 10, color: '#94a3b8', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                {b.label ?? b.name ?? ''}
              </span>
            </div>
          )
        })}
      </div>
      <div className="wf-artifact-actions">
        <button className="wf-artifact-btn" onClick={() => onViewFullscreen?.(artifact.artifactId)}>
          全屏查看
        </button>
      </div>
    </div>
  )
}

// ── Image ──────────────────────────────────────────────────

function ImageView({ artifact, onViewFullscreen }: ArtifactViewProps) {
  const payload = artifact.payload as { src?: string; alt?: string }
  if (!payload?.src) return null

  return (
    <div className="wf-artifact-image">
      <img
        src={payload.src}
        alt={payload.alt || artifact.title}
        style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 8, cursor: 'pointer', objectFit: 'contain' }}
        onClick={() => onViewFullscreen?.(artifact.artifactId)}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none'
        }}
      />
      <div className="wf-artifact-actions">
        <button className="wf-artifact-btn" onClick={() => onViewFullscreen?.(artifact.artifactId)}>
          全屏查看
        </button>
      </div>
    </div>
  )
}

// ── File ───────────────────────────────────────────────────

interface FileEntry { name?: string; size?: number; downloadUrl?: string; path?: string }

function FileView({ artifact }: ArtifactViewProps) {
  const payload = artifact.payload as { files?: FileEntry[] }
  const files: FileEntry[] = payload?.files ?? []
  if (files.length === 0) return null

  function fmtSize(bytes?: number): string {
    if (bytes == null) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1048576).toFixed(1)} MB`
  }

  return (
    <div className="wf-artifact-files">
      {files.map((f, i) => (
        <div key={i} className="wf-file-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f1f5f9' }}>
          <span style={{ fontSize: 14 }}>📄</span>
          <span style={{ flex: 1, fontSize: 13, color: '#334155' }}>{f.name || f.path || '未知文件'}</span>
          {f.size != null && <span style={{ fontSize: 11, color: '#94a3b8' }}>{fmtSize(f.size)}</span>}
          {f.downloadUrl && (
            <a href={f.downloadUrl} download={f.name} className="wf-artifact-btn" style={{ fontSize: 12, padding: '2px 8px' }}>
              下载
            </a>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Browser (webbridge) ────────────────────────────────────

interface BrowserStep { index?: number; action?: string; url?: string; title?: string; screenshot?: string }

function BrowserView({ artifact, onViewFullscreen }: ArtifactViewProps) {
  const payload = artifact.payload as { steps?: BrowserStep[]; finalUrl?: string; status?: string }
  const steps: BrowserStep[] = payload?.steps ?? []
  const lastScreenshot = [...steps].reverse().find((s) => s.screenshot)?.screenshot

  return (
    <div className="wf-artifact-browser">
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>
        浏览器操作 · {steps.length} 个步骤 · {payload?.status ?? 'completed'}
      </div>
      {steps.length > 0 && (
        <div style={{ maxHeight: 160, overflow: 'auto', marginBottom: 8 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ fontSize: 12, padding: '3px 0', color: '#475569' }}>
              <span style={{ color: '#94a3b8', marginRight: 6 }}>#{s.index ?? i + 1}</span>
              <span>{s.action ?? ''}</span>
              {s.title && <span style={{ color: '#64748b' }}> — {s.title}</span>}
            </div>
          ))}
        </div>
      )}
      {lastScreenshot && (
        <img
          src={lastScreenshot}
          alt="浏览器截图"
          style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 6, cursor: 'pointer' }}
          onClick={() => onViewFullscreen?.(artifact.artifactId)}
        />
      )}
      {steps.length === 0 && payload?.finalUrl && (
        <div style={{ fontSize: 12, color: '#2563eb' }}>最终页面: {payload.finalUrl}</div>
      )}
      <div className="wf-artifact-actions">
        <button className="wf-artifact-btn" onClick={() => onViewFullscreen?.(artifact.artifactId)}>
          全屏查看
        </button>
      </div>
    </div>
  )
}

// ── JSON fallback ──────────────────────────────────────────

function JsonFallback({ artifact }: ArtifactViewProps) {
  const text = JSON.stringify(artifact.payload, null, 2)
  return (
    <div style={{ maxHeight: 200, overflow: 'auto', fontSize: 12, fontFamily: 'monospace', background: '#f8fafc', padding: 10, borderRadius: 8, color: '#475569' }}>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{text.slice(0, 2000)}{text.length > 2000 ? '…' : ''}</pre>
    </div>
  )
}

/**
 * PreviewPane — 预览面板（坞内「预览」tab 内容）
 *
 * 根据 FileCardArtifact.kind 渲染全量预览：
 * - chart:   大柱状图（有 chartData）或 fallback 图片（通过 previewUrl 加载）
 * - table:   全量滚动表格
 * - doc:     HTML / 富文本
 * - image:   <img> 全宽
 * - unknown: 文件 icon + 元数据，图片类走 previewUrl 展示
 *
 * 核心设计：previewUrl 指向 workspace 真实文件下载端点，
 * 富数据（chartData/tableData/docHtml）是可选的增强渲染，
 * 缺失时一律 fallback 到 previewUrl 直出。
 */

import { memo, useCallback, useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type { FileCardArtifact } from '@/types/artifactDock'
import { getKindLabel } from '@/types/artifactDock'
import { useArtifactDockStore } from '@/stores/artifactDockStore'
import { workspaceApi } from '@/api/client'
import { downloadFile } from '@/utils/downloadFile'
import { normalizeMarkdown } from '@/utils/markdownNormalizer'
import { Portal } from '@/components/common/Portal'

/** 获取用于下载的最终 URL（/api/workspace/download，attachment 强制下载） */
function getDownloadUrl(artifact: FileCardArtifact): string {
  const workspaceUrl = workspaceApi.downloadUrl
    ? workspaceApi.downloadUrl(artifact.path)
    : null

  // 校验 URL 是否合法（Standalone 模式下可能返回虚拟 path）
  if (workspaceUrl) {
    try {
      // 尝试解析为 URL，若失败则说明是相对路径或虚拟路径
      new URL(workspaceUrl, window.location.origin)
      // 额外检查：Standalone 模式下 workspaceApi.downloadUrl 可能直接返回虚拟 path
      // 若 URL 以 / 开头但不是有效的 HTTP URL，则可能是虚拟路径
      if (workspaceUrl.startsWith('/') && !workspaceUrl.startsWith('/api/')) {
        // 虚拟路径，fallback 到 previewUrl
        return artifact.previewUrl
      }
      return workspaceUrl
    } catch {
      // 解析失败，fallback 到 previewUrl
      return artifact.previewUrl
    }
  }

  return artifact.previewUrl
}

/**
 * 获取用于内联展示的 URL（/api/workspace/preview，正确 Content-Type、无 attachment）。
 * 所有 <img src> / fetch 展示用途一律走此函数；下载按钮走 getDownloadUrl。
 */
function getPreviewUrl(artifact: FileCardArtifact): string {
  const workspaceUrl = workspaceApi.previewUrl
    ? workspaceApi.previewUrl(artifact.path)
    : null

  if (workspaceUrl) {
    try {
      new URL(workspaceUrl, window.location.origin)
      if (workspaceUrl.startsWith('/') && !workspaceUrl.startsWith('/api/')) {
        // Standalone 虚拟路径，fallback 到 previewUrl
        return artifact.previewUrl
      }
      return workspaceUrl
    } catch {
      return artifact.previewUrl
    }
  }

  return artifact.previewUrl
}

// ── 大图表 ────────────────────────────────────────────────

function BigChart({ artifact }: { artifact: FileCardArtifact }) {
  const bars = artifact.chartData?.bars
  const title = artifact.chartData?.title

  // 有富数据 → CSS 柱状图
  if (bars && bars.length > 0) {
    const max = Math.max(...bars.map((b) => b[1]))
    return (
      <>
        {title && <div className="wf-chart-title">{title}</div>}
        <div className="wf-big-chart">
          {bars.map((bar, i) => {
            const h = max > 0 ? Math.round((bar[1] / max) * 150) : 8
            return (
              <div className="wf-big-col" key={i}>
                <div className="wf-big-bar" style={{ height: `${Math.max(h, 8)}px` }}>
                  <span>{bar[1]}</span>
                </div>
                <div className="wf-big-x">{bar[0]}</div>
              </div>
            )
          })}
        </div>
      </>
    )
  }

  // 无富数据 → fallback 到 previewUrl 展示图表图片
  const url = getPreviewUrl(artifact)
  if (url) {
    return (
      <ZoomableImage
        url={url}
        alt={artifact.caption || artifact.fileName}
        caption={title || artifact.caption}
      />
    )
  }

  return <div className="wf-pv-note">暂无图表数据</div>
}

// ── 大表格 ────────────────────────────────────────────────

function BigTable({ artifact }: { artifact: FileCardArtifact }) {
  const { columns, rows } = artifact.tableData || { columns: [], rows: [] as string[][] }
  const [fetchedData, setFetchedData] = useState<{ columns: string[]; rows: string[][] } | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [isFetching, setIsFetching] = useState(false)

  // 若无 tableData，尝试 fetch previewUrl 解析
  useEffect(() => {
    if (columns.length > 0 || fetchedData || isFetching) return

    const url = getPreviewUrl(artifact)
    if (!url) return

    setIsFetching(true)
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((text) => {
        // 尝试解析为 CSV
        const lines = text.trim().split('\n')
        if (lines.length === 0) {
          setFetchError('文件为空')
          return
        }

        // 简单 CSV 解析（假设第一行是表头）
        const headers = lines[0].split(',').map((h) => h.trim())
        const dataRows = lines.slice(1).map((line) => line.split(',').map((cell) => cell.trim()))

        setFetchedData({ columns: headers, rows: dataRows })
      })
      .catch((e) => {
        setFetchError(e.message)
      })
      .finally(() => {
        setIsFetching(false)
      })
  }, [columns.length, fetchedData, isFetching, artifact])

  // 使用 fetchedData 或原始 tableData
  const displayColumns = fetchedData?.columns || columns
  const displayRows = fetchedData?.rows || rows

  if (isFetching) {
    return <div className="wf-pv-note">加载表格数据中...</div>
  }

  if (fetchError) {
    return (
      <div className="wf-pv-note">
        表格数据加载失败：{fetchError}
        <br />
        <a href={getDownloadUrl(artifact)} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb' }}>
          ⤓ 直接下载查看
        </a>
      </div>
    )
  }

  if (displayColumns.length === 0) {
    return <div className="wf-pv-note">暂无表格数据</div>
  }

  return (
    <table className="wf-big-table">
      <thead>
        <tr>{displayColumns.map((c, i) => <th key={i}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {displayRows.map((row, ri) => (
          <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  )
}

// ── 文档视图 ──────────────────────────────────────────────

function DocView({ artifact }: { artifact: FileCardArtifact }) {
  // docHtml（来自后端 Markdown→HTML 预渲染）优先
  if (artifact.docHtml) {
    return <div className="wf-doc-view" dangerouslySetInnerHTML={{ __html: artifact.docHtml }} />
  }

  // 尝试用 previewUrl 拉取 Markdown 原文渲染
  const url = getPreviewUrl(artifact)
  if (url) {
    return <DocFetchView url={url} caption={artifact.caption} />
  }

  return (
    <div className="wf-doc-view">
      <p>{artifact.caption || '文档内容待加载'}</p>
    </div>
  )
}

/** 轻量 fetch + ReactMarkdown 渲染，带 loading/error 态 */
function DocFetchView({ url, caption }: { url: string; caption: string }) {
  const [md, setMd] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((text) => { if (!cancelled) setMd(text) })
      .catch((e) => { if (!cancelled) setErr(e.message) })
    return () => { cancelled = true }
  }, [url])

  if (err) {
    return (
      <div className="wf-doc-view">
        <p className="wf-pv-note">文档加载失败：{err}</p>
        <p style={{ marginTop: 8 }}>
          <a href={url} target="_blank" rel="noopener noreferrer" className="wf-pv-act" style={{ color: '#2563eb' }}>
            ⤓ 直接下载查看
          </a>
        </p>
      </div>
    )
  }

  if (md === null) {
    return (
      <div className="wf-doc-view">
        <p className="wf-pv-note">加载中...</p>
      </div>
    )
  }

  return (
    <div className="wf-doc-view">
      {caption && <p className="wf-doc-caption">{caption}</p>}
      <div className="wf-prose">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
          {normalizeMarkdown(md)}
        </ReactMarkdown>
      </div>
    </div>
  )
}

// ── 图片灯箱（点击放大到页面中央查看，Esc/点击空白关闭） ──────────────

function ZoomableImage({ url, alt, caption }: { url: string; alt: string; caption?: string }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <div className="wf-pv-image wf-pv-image-zoomable" onClick={() => setOpen(true)} title="点击放大查看">
        <img
          src={url}
          alt={alt}
          style={{ maxWidth: '100%', borderRadius: 8 }}
        />
        <div className="wf-pv-zoom-hint">⤢ 点击放大</div>
      </div>
      {open && (
        <Portal>
          <div className="wf-lightbox" onClick={() => setOpen(false)}>
            <button className="wf-lightbox-close" aria-label="关闭" onClick={() => setOpen(false)}>✕</button>
            <img
              src={url}
              alt={alt}
              className="wf-lightbox-img"
              onClick={(e) => e.stopPropagation()}
            />
            {caption && <div className="wf-lightbox-caption">{caption}</div>}
          </div>
        </Portal>
      )}
    </>
  )
}

// ── 图片视图 ──────────────────────────────────────────────

function ImageView({ artifact }: { artifact: FileCardArtifact }) {
  const url = getPreviewUrl(artifact)
  return (
    <ZoomableImage
      url={url}
      alt={artifact.caption || artifact.fileName}
      caption={artifact.caption}
    />
  )
}

// ── 未知类型 ──────────────────────────────────────────────

function UnknownView({ artifact }: { artifact: FileCardArtifact }) {
  // 如果 MIME 是图片或文件扩展名是图片格式，用 previewUrl 直接展示
  const isImageLike =
    artifact.mimeType?.startsWith('image/') ||
    /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i.test(artifact.fileName)

  if (isImageLike) {
    const url = getPreviewUrl(artifact)
    if (url) {
      return (
        <ZoomableImage
          url={url}
          alt={artifact.caption || artifact.fileName}
          caption={artifact.caption}
        />
      )
    }
  }

  // 文本类文件尝试 fetch 展示
  const isTextLike =
    artifact.mimeType?.startsWith('text/') ||
    /\.(md|markdown|txt|json|csv|xml|yaml|yml|log|sql|py|ts|tsx|jsx|css|html|ini|cfg)$/i.test(artifact.fileName)

  if (isTextLike) {
    const url = getPreviewUrl(artifact)
    if (url) {
      return <DocFetchView url={url} caption={artifact.caption} />
    }
  }

  return (
    <div className="wf-pv-unknown">
      <div className="wf-pv-icon">📄</div>
      <p>{artifact.fileName}</p>
      <p className="wf-pv-note">{artifact.mimeType || '未知类型'}</p>
    </div>
  )
}

// ── PreviewPane ───────────────────────────────────────────

export const PreviewPane = memo(function PreviewPane({
  artifact,
}: {
  artifact: FileCardArtifact
}) {
  const open = useArtifactDockStore((s) => s.open)

  const handleDownload = useCallback(() => {
    const url = getDownloadUrl(artifact)
    if (url) {
      downloadFile(url, artifact.fileName)
    }
  }, [artifact.path, artifact.previewUrl, artifact.fileName])

  const handleCopyPath = useCallback(() => {
    navigator.clipboard?.writeText(artifact.path)
  }, [artifact.path])

  const handleLocate = useCallback(() => {
    open(artifact.id, 'files')
  }, [artifact.id, open])

  const renderContent = () => {
    switch (artifact.kind) {
      case 'chart':
        return <BigChart artifact={artifact} />
      case 'table':
        return <BigTable artifact={artifact} />
      case 'doc':
        return <DocView artifact={artifact} />
      case 'image':
        return <ImageView artifact={artifact} />
      default:
        return <UnknownView artifact={artifact} />
    }
  }

  const typeLabel = artifact.typeLabel || getKindLabel(artifact.kind)

  return (
    <div className="wf-pv-wrap">
      {/* Head */}
      <div className="wf-pv-head">
        <span
          className="wf-pv-type"
          style={{ color: artifact.accent, background: artifact.accentBg }}
        >
          {typeLabel}
        </span>
        <div className="wf-pv-caption">{artifact.caption}</div>
        <div className="wf-pv-meta">
          {artifact.fileName}
          {artifact.size && <> · {artifact.size}</>}
          {artifact.path && <> · {artifact.path}</>}
        </div>
      </div>

      {/* Actions */}
      <div className="wf-pv-actions">
        <button className="wf-pv-act" onClick={handleDownload}>
          ⤓ 下载
        </button>
        <button className="wf-pv-act" onClick={handleCopyPath}>
          ⧉ 复制路径
        </button>
        <button className="wf-pv-act" onClick={handleLocate}>
          ⌖ 在工作区中定位
        </button>
      </div>

      {/* Content */}
      <div className="wf-pv-content">{renderContent()}</div>
    </div>
  )
})

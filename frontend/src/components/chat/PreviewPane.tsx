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
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
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
import { WorkflowGraph } from '@/components/chat/WorkflowGraph'
import { workflowApi } from '@/api/workflowApi'

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
  const { t } = useTranslation()
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

  return <div className="wf-pv-note">{t('chat.previewPane.noChartData')}</div>
}

// ── 大表格 ────────────────────────────────────────────────

function BigTable({ artifact }: { artifact: FileCardArtifact }) {
  const { t } = useTranslation()
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
          setFetchError(t('chat.previewPane.fileEmpty'))
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
    return <div className="wf-pv-note">{t('chat.previewPane.loadingTable')}</div>
  }

  if (fetchError) {
    return (
      <div className="wf-pv-note">
        {t('chat.previewPane.tableLoadFailed', { error: fetchError })}
        <br />
        <a href={getDownloadUrl(artifact)} target="_blank" rel="noopener noreferrer" className="wf-pv-link">
          ⤓ {t('chat.previewPane.downloadToView')}
        </a>
      </div>
    )
  }

  if (displayColumns.length === 0) {
    return <div className="wf-pv-note">{t('chat.previewPane.noTableData')}</div>
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
  const { t } = useTranslation()
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
      <p>{artifact.caption || t('chat.previewPane.docPending')}</p>
    </div>
  )
}

/** 轻量 fetch + ReactMarkdown 渲染，带 loading/error 态 */
function DocFetchView({ url, caption }: { url: string; caption: string }) {
  const { t } = useTranslation()
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
        <p className="wf-pv-note">{t('chat.previewPane.docLoadFailed', { error: err })}</p>
        <p style={{ marginTop: 8 }}>
          <a href={url} target="_blank" rel="noopener noreferrer" className="wf-pv-act wf-pv-link">
            ⤓ {t('chat.previewPane.downloadToView')}
          </a>
        </p>
      </div>
    )
  }

  if (md === null) {
    return (
      <div className="wf-doc-view">
        <p className="wf-pv-note">{t('chat.previewPane.loading')}</p>
      </div>
    )
  }

  return (
    <div className="wf-doc-view">
      {caption && <p className="wf-doc-caption">{caption}</p>}
      <div className="wf-prose wf-md">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
          {normalizeMarkdown(md)}
        </ReactMarkdown>
      </div>
    </div>
  )
}

// ── 图片灯箱（点击放大到页面中央查看，Esc/点击空白关闭） ──────────────

export function ZoomableImage({ url, alt, caption }: { url: string; alt: string; caption?: string }) {
  const { t } = useTranslation()
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
      <div className="wf-pv-image wf-pv-image-zoomable" onClick={() => setOpen(true)} title={t('chat.previewPane.clickToZoom')}>
        <img
          src={url}
          alt={alt}
          style={{ maxWidth: '100%', borderRadius: 8 }}
        />
        <div className="wf-pv-zoom-hint">⤢ {t('chat.previewPane.zoomHint')}</div>
      </div>
      {open && (
        <Portal>
          <div className="wf-lightbox" onClick={() => setOpen(false)}>
            <button className="wf-lightbox-close" aria-label={t('chat.previewPane.close')} onClick={() => setOpen(false)}>✕</button>
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

// ── Office 预览（xlsx → SheetJS 表格；docx → mammoth HTML；pptx → 下载型） ──

/** 按扩展名识别 Office 类型——优先于 kind 路由，防止 docx 被当文本抓取出现乱码 */
function officeTypeOf(fileName: string): 'xlsx' | 'docx' | 'pptx' | null {
  if (/\.(xlsx|xls)$/i.test(fileName)) return 'xlsx'
  if (/\.docx$/i.test(fileName)) return 'docx'
  if (/\.(pptx|ppt)$/i.test(fileName)) return 'pptx'
  return null
}

/** 拉取文件二进制（arrayBuffer），供 SheetJS / mammoth 解析 */
async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.arrayBuffer()
}

function OfficeFetchError({ artifact, error }: { artifact: FileCardArtifact; error: string }) {
  const { t } = useTranslation()
  return (
    <div className="wf-pv-note">
      {t('chat.previewPane.previewParseFailed', { error })}
      <br />
      <a href={getDownloadUrl(artifact)} target="_blank" rel="noopener noreferrer" className="wf-pv-link">
        ⤓ {t('chat.previewPane.openInOffice')}
      </a>
    </div>
  )
}

/** Excel 预览：首个工作表渲染为表格（前 100 行），多表给出提示 */
function ExcelPreview({ artifact }: { artifact: FileCardArtifact }) {
  const { t } = useTranslation()
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; error: string }
    | { status: 'done'; columns: string[]; rows: string[][]; totalRows: number; sheetName: string; sheetCount: number }
  >({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const url = getPreviewUrl(artifact)
    ;(async () => {
      try {
        const buf = await fetchArrayBuffer(url)
        const XLSX = await import('xlsx')
        const wb = XLSX.read(buf, { type: 'array' })
        const sheetName = wb.SheetNames[0]
        const sheet = wb.Sheets[sheetName]
        // header:1 → 二维数组；raw:false 让单元格按显示文本取值（日期/数字格式友好）
        const grid = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
          header: 1,
          raw: false,
          defval: '',
        })
        const MAX_COLS = 30
        const MAX_ROWS = 100
        const columns = (grid[0] ?? []).slice(0, MAX_COLS).map((c, i) => String(c ?? '') || t('chat.previewPane.columnN', { n: i + 1 }))
        const dataRows = grid
          .slice(1)
          .filter((r) => r.some((c) => c !== '' && c != null))
        const rows = dataRows
          .slice(0, MAX_ROWS)
          .map((r) => columns.map((_, ci) => String(r[ci] ?? '')))
        if (!cancelled) {
          setState({
            status: 'done',
            columns,
            rows,
            totalRows: dataRows.length,
            sheetName,
            sheetCount: wb.SheetNames.length,
          })
        }
      } catch (e) {
        if (!cancelled) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => { cancelled = true }
  }, [artifact])

  if (state.status === 'loading') return <div className="wf-pv-note">{t('chat.previewPane.parsingExcel')}</div>
  if (state.status === 'error') return <OfficeFetchError artifact={artifact} error={state.error} />

  const sheetHint = state.sheetCount > 1
    ? t('chat.previewPane.sheetCountHint', { count: state.sheetCount })
    : ''
  const rowsHint = state.totalRows > state.rows.length
    ? t('chat.previewPane.showingRows', { shown: state.rows.length, total: state.totalRows })
    : t('chat.previewPane.totalRows', { count: state.totalRows })

  return (
    <div>
      <div className="wf-pv-note" style={{ marginBottom: 6 }}>
        {t('chat.previewPane.sheetName', { name: state.sheetName })}{sheetHint}{rowsHint}
      </div>
      <table className="wf-big-table">
        <thead>
          <tr>{state.columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {state.rows.map((row, ri) => (
            <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Word 预览：mammoth 转 HTML 直接渲染（docx 是二进制，绝不能按文本抓取——否则满屏乱码） */
function DocxPreview({ artifact }: { artifact: FileCardArtifact }) {
  const { t } = useTranslation()
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; error: string } | { status: 'done'; html: string }
  >({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    const url = getPreviewUrl(artifact)
    ;(async () => {
      try {
        const buf = await fetchArrayBuffer(url)
        const mammoth = await import('mammoth')
        const result = await mammoth.convertToHtml({ arrayBuffer: buf })
        if (!cancelled) setState({ status: 'done', html: result.value })
      } catch (e) {
        if (!cancelled) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => { cancelled = true }
  }, [artifact])

  if (state.status === 'loading') return <div className="wf-pv-note">{t('chat.previewPane.parsingWord')}</div>
  if (state.status === 'error') return <OfficeFetchError artifact={artifact} error={state.error} />
  return <div className="wf-doc-view wf-prose wf-md" dangerouslySetInnerHTML={{ __html: state.html }} />
}

/** 下载型视图：暂不支持在线预览的格式（pptx 等），明确告知而不是显示乱码或空白 */
function DownloadOnlyView({ artifact }: { artifact: FileCardArtifact }) {
  const { t } = useTranslation()
  return (
    <div className="wf-pv-unknown">
      <div className="wf-pv-icon">📄</div>
      <p>{artifact.fileName}</p>
      <p className="wf-pv-note">{t('chat.previewPane.unsupportedFormat')}</p>
    </div>
  )
}

// ── 未知类型 ──────────────────────────────────────────────

function UnknownView({ artifact }: { artifact: FileCardArtifact }) {
  const { t } = useTranslation()
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
      <p className="wf-pv-note">{artifact.mimeType || t('chat.previewPane.unknownType')}</p>
    </div>
  )
}

// ── 工作流视图（WorkFlow JSON → 地铁图投影） ─────────────────────

function WorkflowView({ artifact }: { artifact: FileCardArtifact }) {
  const { t } = useTranslation()
  const [hydrated, setHydrated] = useState<{ doc: import('@/types/workflow').WorkflowDoc; errors: string[] } | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  // 会话水合路径只有索引行（无内嵌 doc）：按 id 从工作流目录重读
  useEffect(() => {
    if (artifact.workflowData || hydrated || loadFailed) return
    const id = artifact.fileName.replace(/\.json$/i, '')
    let cancelled = false
    workflowApi
      .readWorkflow(id)
      .then((doc) => {
        if (cancelled) return
        if (doc) setHydrated({ doc, errors: [] })
        else setLoadFailed(true)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [artifact, hydrated, loadFailed])

  const data = artifact.workflowData ?? hydrated
  if (!data) {
    return (
      <div className="wf-pv-note">
        {loadFailed ? t('chat.previewPane.workflowLoadFailed') : t('chat.previewPane.loading')}
      </div>
    )
  }
  return <WorkflowGraph doc={data.doc} errors={data.errors} />
}

// ── PreviewPane ───────────────────────────────────────────

export const PreviewPane = memo(function PreviewPane({
  artifact,
}: {
  artifact: FileCardArtifact
}) {
  const { t } = useTranslation()
  const open = useArtifactDockStore((s) => s.open)
  const removeArtifact = useArtifactDockStore((s) => s.removeArtifact)

  // 从坞中移除：移除当前预览产物（自然关预览，墓碑防水合复活）
  const handleRemoveFromDock = useCallback(() => {
    removeArtifact(artifact.id)
  }, [removeArtifact, artifact.id])

  const handleDownload = useCallback(() => {
    const url = getDownloadUrl(artifact)
    if (url) {
      downloadFile(url, artifact.fileName)
    }
  }, [artifact.path, artifact.previewUrl, artifact.fileName])

  const handleCopyPath = useCallback(() => {
    navigator.clipboard?.writeText(artifact.path)
      .then(() => toast.success(t('chat.workspaceFilesPanel.copied')))
      .catch(() => toast.error(t('chat.workspaceFilesPanel.copyFailed')))
  }, [artifact.path, t])

  const handleLocate = useCallback(() => {
    open(artifact.id, 'files')
  }, [artifact.id, open])

  const renderContent = () => {
    // Office 二进制按扩展名优先路由：xlsx/docx 有专用解析器，pptx 等走下载型；
    // 不能落到 doc/unknown 的文本抓取路径（二进制当文本渲染 = 乱码）
    switch (officeTypeOf(artifact.fileName)) {
      case 'xlsx':
        return <ExcelPreview artifact={artifact} />
      case 'docx':
        return <DocxPreview artifact={artifact} />
      case 'pptx':
        return <DownloadOnlyView artifact={artifact} />
    }
    switch (artifact.kind) {
      case 'workflow':
        return <WorkflowView artifact={artifact} />
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
      <div className="wf-pv-head relative">
        <span
          className="wf-pv-type"
          style={{ color: artifact.accent, background: artifact.accentBg }}
        >
          {typeLabel}
        </span>
        <div className="wf-pv-caption pr-9">{artifact.caption}</div>
        <div className="wf-pv-meta">
          {artifact.fileName}
          {artifact.size && <> · {artifact.size}</>}
          {artifact.path && <> · {artifact.path}</>}
        </div>
        <button
          className="wf-fabtn wf-press absolute right-3 top-3"
          onClick={handleRemoveFromDock}
          title={t('chat.board.removeProd')}
          aria-label={t('chat.board.removeProd')}
        >
          ✕
        </button>
      </div>

      {/* Actions（工作流无下载——不走 workspace 下载链） */}
      <div className="wf-pv-actions">
        {artifact.kind !== 'workflow' && (
          <button className="wf-pv-act" onClick={handleDownload}>
            ⤓ {t('chat.fileActions.download')}
          </button>
        )}
        <button className="wf-pv-act" onClick={handleCopyPath}>
          ⧉ {t('chat.fileActions.copyPath')}
        </button>
        <button className="wf-pv-act" onClick={handleLocate}>
          ⌖ {t('chat.fileActions.locateInWorkspace')}
        </button>
      </div>

      {/* Content */}
      <div className="wf-pv-content">{renderContent()}</div>
    </div>
  )
})

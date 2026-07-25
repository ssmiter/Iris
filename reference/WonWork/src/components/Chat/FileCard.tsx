/**
 * FileCard — 统一文件卡片（嵌入 answer 下方）
 *
 * 对应 v7 原型中的 .fcard 组件：
 * - 左侧：mini 预览（chart bars / table rows / doc skeleton）
 * - 中间：typeLabel + caption + fileName · size
 * - 右侧：垂直操作按钮（下载 / 复制路径 / 定位）
 *
 * 挂载时自动注册到 artifactDockStore，点击打开预览坞。
 */

import { memo, useEffect, useCallback, useRef, useLayoutEffect } from 'react'
import type { FileCardArtifact } from '@/types/artifactDock'
import { useArtifactDockStore } from '@/stores/artifactDockStore'
import { workspaceApi } from '@/api/client'
import { downloadFile } from '@/utils/downloadFile'

// ── Mini 预览（内联渲染） ──────────────────────────────────

/** CSS 柱状图缩略（128px 宽容器内） */
function MiniChart({ bars, accent }: { bars: [string, number][]; accent: string }) {
  if (!bars || bars.length === 0) {
    return <div className="wf-mini-doc"><i /><i /><i /></div>
  }
  const max = Math.max(...bars.map((b) => b[1]))
  return (
    <div className="wf-mini-chart" style={{ color: accent }}>
      {bars.map((bar, i) => {
        const h = max > 0 ? Math.round((bar[1] / max) * 56) : 4
        return <i key={i} style={{ height: `${Math.max(h, 4)}px` }} />
      })}
    </div>
  )
}

/** 表格缩略（前 3 行） */
function MiniTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const displayRows = rows.slice(0, 3)
  return (
    <table className="wf-mini-table">
      <tbody>
        {displayRows.map((row, ri) => (
          <tr key={ri}>
            {row.slice(0, columns.length || row.length).map((cell, ci) => (
              <td key={ci}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** 文档线条骨架 */
function MiniDoc() {
  return (
    <div className="wf-mini-doc">
      <i /><i /><i />
    </div>
  )
}

/** mini 预览分发 */
function MiniPreview({ artifact }: { artifact: FileCardArtifact }) {
  if (artifact.kind === 'chart' && artifact.chartData?.bars) {
    return <MiniChart bars={artifact.chartData.bars} accent={artifact.accent} />
  }
  if (artifact.kind === 'table' && artifact.tableData?.rows) {
    return <MiniTable columns={artifact.tableData.columns} rows={artifact.tableData.rows} />
  }
  if (artifact.kind === 'image' && artifact.previewUrl) {
    return (
      <img
        src={artifact.previewUrl}
        alt={artifact.caption || artifact.fileName}
        className="wf-mini-img"
        loading="lazy"
      />
    )
  }
  return <MiniDoc />
}

// ── FileCard 组件 ──────────────────────────────────────────

export const FileCard = memo(function FileCard({
  artifact,
}: {
  artifact: FileCardArtifact
}) {
  const open = useArtifactDockStore((s) => s.open)
  const isPreviewing =
    useArtifactDockStore((s) => s.isOpen && s.currentArtifactId === artifact.id)
  const registerArtifact = useArtifactDockStore((s) => s.registerArtifact)
  const registeredRef = useRef(false)

  // 使用 useLayoutEffect 确保在浏览器绘制前完成注册，避免竞态
  useLayoutEffect(() => {
    if (!registeredRef.current) {
      registeredRef.current = true
      registerArtifact(artifact)
    }
  }, [artifact, registerArtifact])

  // 下载
  const handleDownload = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const workspaceUrl = workspaceApi.downloadUrl
        ? workspaceApi.downloadUrl(artifact.path)
        : null

      // 校验 URL 是否合法（Standalone 模式下可能返回虚拟 path）
      let url: string | null = null
      if (workspaceUrl) {
        try {
          new URL(workspaceUrl, window.location.origin)
          // Standalone 模式下 workspaceApi.downloadUrl 可能直接返回虚拟 path
          if (workspaceUrl.startsWith('/') && !workspaceUrl.startsWith('/api/')) {
            url = artifact.previewUrl
          } else {
            url = workspaceUrl
          }
        } catch {
          url = artifact.previewUrl
        }
      } else {
        url = artifact.previewUrl
      }

      if (url) {
        downloadFile(url, artifact.fileName)
      }
    },
    [artifact.path, artifact.previewUrl, artifact.fileName],
  )

  // 复制路径
  const handleCopyPath = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      navigator.clipboard?.writeText(artifact.path)
    },
    [artifact.path],
  )

  // 在工作区中定位
  const handleLocate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      open(artifact.id, 'files')
    },
    [artifact.id, open],
  )

  // 点击卡片 → 预览
  const handleClick = useCallback(() => {
    open(artifact.id, 'preview')
  }, [artifact.id, open])

  return (
    <div
      className={`wf-fcard${isPreviewing ? ' previewing' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleClick()
      }}
    >
      {/* 左侧 mini 预览 */}
      <div className="wf-fcard-preview" style={{ color: artifact.accent }}>
        <MiniPreview artifact={artifact} />
      </div>

      {/* 中间信息 */}
      <div className="wf-fcard-main">
        <span className="wf-fcard-type" style={{ color: artifact.accent }}>
          {artifact.typeLabel} · 文件卡片
        </span>
        <span className="wf-fcard-caption">{artifact.caption}</span>
        <span className="wf-fcard-meta">
          <span className="wf-fcard-fname">{artifact.fileName}</span>
          {artifact.size && <> · {artifact.size}</>}
        </span>
      </div>

      {/* 右侧操作按钮 */}
      <div className="wf-fcard-actions">
        <button
          className="wf-fabtn"
          onClick={handleDownload}
          title="下载"
          aria-label="下载文件"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
          </svg>
        </button>
        <button
          className="wf-fabtn"
          onClick={handleCopyPath}
          title="复制路径"
          aria-label="复制文件路径"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        </button>
        <button
          className="wf-fabtn"
          onClick={handleLocate}
          title="在工作区中定位"
          aria-label="在工作区中定位"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="7" />
            <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
        </button>
      </div>
    </div>
  )
})

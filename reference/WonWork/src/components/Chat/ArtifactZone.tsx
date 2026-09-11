import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { ArtifactNode } from '@/types/chat'
import { renderArtifactPreview } from './artifactViews'
import { extractTableRows } from './InlineTable'

interface ArtifactZoneProps {
  artifacts: ArtifactNode[]
  /** 点击全屏查看时的回调 */
  onViewFullscreen?: (artifactId: string) => void
}

/** Toast 提示（轻量内联，不依赖全局 toast 系统） */
function toast(msg: string) {
  // 使用临时 DOM 元素模拟 toast
  const el = document.createElement('div')
  el.textContent = msg
  el.style.cssText = `
    position: fixed; left: 50%; bottom: 110px; transform: translateX(-50%);
    background: var(--wf-capsule-bg); color: var(--wf-capsule-ink); font-size: 12.5px;
    padding: 8px 16px; border-radius: 999px; z-index: 200;
    opacity: 0; transition: opacity .25s; pointer-events: none;
  `
  document.body.appendChild(el)
  requestAnimationFrame(() => { el.style.opacity = '1' })
  setTimeout(() => {
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 300)
  }, 1800)
}

/**
 * 产物区：从脊柱提升至此，始终可见。
 * 参考 prototype-v3 的 .artifact-zone + .artifact-card 设计。
 */
export function ArtifactZone({ artifacts, onViewFullscreen }: ArtifactZoneProps) {
  if (artifacts.length === 0) return null

  return (
    <div className="wf-artifact-zone">
      {artifacts.map((a) => (
        <ArtifactCard key={a.artifactId} artifact={a} onViewFullscreen={onViewFullscreen} />
      ))}
    </div>
  )
}

function ArtifactCard({
  artifact,
  onViewFullscreen,
}: {
  artifact: ArtifactNode
  onViewFullscreen?: (artifactId: string) => void
}) {
  const { t } = useTranslation()
  const handleExportCSV = useCallback(() => {
    const csvText = buildCSV(artifact.payload)
    if (!csvText) { toast(t('chat.artifactZone.noExportableData')); return }
    const blob = new Blob(['﻿' + csvText], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = (artifact.title || 'data') + '.csv'
    a.click()
    URL.revokeObjectURL(a.href)
    toast(t('chat.artifactZone.exportedCsv'))
  }, [artifact.title, artifact.payload, t])

  const handleCopyData = useCallback(() => {
    const text = buildCopyText(artifact.payload)
    navigator.clipboard?.writeText(text).then(
      () => toast(t('chat.artifactZone.dataCopied')),
      () => toast(t('chat.artifactZone.copyFailed'))
    )
  }, [artifact.payload, t])

  const handleFullscreen = useCallback(() => {
    if (onViewFullscreen) {
      onViewFullscreen(artifact.artifactId)
    } else {
      toast(t('chat.artifactZone.fullscreenComing'))
    }
  }, [artifact.artifactId, onViewFullscreen, t])

  return (
    <div className="wf-artifact-card">
      <div className="wf-artifact-head">
        <span className="wf-artifact-title">{artifact.title}</span>
        {artifact.version != null && artifact.version > 1 && (
          <span className="wf-artifact-ver">v{artifact.version}</span>
        )}
        <div className="wf-artifact-actions">
          <button className="wf-a-btn" onClick={handleExportCSV} title={t('chat.artifactZone.exportCsv')}>⤓ 导出 CSV</button>
          <button className="wf-a-btn" onClick={handleCopyData} title={t('chat.artifactZone.copyData')}>⧉ 复制数据</button>
          <button className="wf-a-btn" onClick={handleFullscreen} title={t('chat.artifactZone.fullscreen')}>⛶ 全屏</button>
        </div>
      </div>
      <div className="wf-artifact-body">
        <ArtifactPreview artifact={artifact} onViewFullscreen={onViewFullscreen} />
      </div>
    </div>
  )
}

// ── 数据导出 helpers ──

interface BarItem { label: string; val: number; disp?: string; color?: string }

function extractBars(payload: unknown): BarItem[] | null {
  if (!payload || typeof payload !== 'object') return null
  const obj = payload as Record<string, unknown>
  // 直接 bars 数组
  if (Array.isArray(obj.bars) && obj.bars.length > 0) {
    const first = obj.bars[0]
    if (typeof first === 'object' && first !== null && 'label' in first && 'val' in first) {
      return obj.bars as BarItem[]
    }
  }
  // { data: [{ label, value }] } → 自动转换
  if (Array.isArray(obj.data) && obj.data.length > 0) {
    const first = obj.data[0]
    if (typeof first === 'object' && first !== null) {
      const f = first as Record<string, unknown>
      const labelKey = Object.keys(f).find(k => typeof f[k] === 'string') || Object.keys(f)[0]
      const valKey = Object.keys(f).find(k => typeof f[k] === 'number') || Object.keys(f)[1]
      if (labelKey && valKey && labelKey !== valKey) {
        return (obj.data as Record<string, unknown>[]).map((row, i) => ({
          label: String(row[labelKey] ?? ''),
          val: Number(row[valKey]) || 0,
          disp: String(row[valKey] ?? ''),
          color: ['#2563eb', '#4b83ee', '#6f9af1', '#93b1f4', '#b7c9f8'][i % 5],
        }))
      }
    }
  }
  // { rows } with numeric column
  if (Array.isArray(obj.rows) && obj.rows.length > 0) {
    const first = obj.rows[0] as Record<string, unknown>
    const labelKey = Object.keys(first).find(k => typeof first[k] === 'string') || Object.keys(first)[0]
    const valKey = Object.keys(first).find(k => typeof first[k] === 'number') || Object.keys(first)[1]
    if (labelKey && valKey && labelKey !== valKey) {
      return (obj.rows as Record<string, unknown>[]).map((row, i) => ({
        label: String(row[labelKey] ?? ''),
        val: Number(row[valKey]) || 0,
        disp: String(row[valKey] ?? ''),
        color: ['#2563eb', '#4b83ee', '#6f9af1', '#93b1f4', '#b7c9f8'][i % 5],
      }))
    }
  }
  return null
}

function buildCSV(payload: unknown): string | null {
  const rows = extractTableRows(payload)
  if (rows && rows.length > 0) {
    const cols = Object.keys(rows[0])
    const header = cols.join(',')
    const body = rows.map(r => cols.map(c => {
      const v = r[c]
      if (typeof v === 'string' && (v.includes(',') || v.includes('"'))) return `"${v.replace(/"/g, '""')}"`
      return String(v ?? '')
    }).join(',')).join('\n')
    return header + '\n' + body
  }
  const bars = extractBars(payload)
  if (bars) {
    return 'label,value\n' + bars.map(b => `${b.label},${b.val}`).join('\n')
  }
  return null
}

function buildCopyText(payload: unknown): string {
  const rows = extractTableRows(payload)
  if (rows && rows.length > 0) {
    const cols = Object.keys(rows[0])
    return rows.map(r => cols.map(c => `${c}: ${r[c]}`).join(' · ')).join('\n')
  }
  const bars = extractBars(payload)
  if (bars) {
    return bars.map(b => `${b.label}: ${b.disp || b.val}`).join(' · ')
  }
  try { return JSON.stringify(payload, null, 2) } catch { return String(payload) }
}

// ── 预览 ──

function ArtifactPreview({ artifact, onViewFullscreen }: { artifact: ArtifactNode; onViewFullscreen?: (artifactId: string) => void }) {
  return <>{renderArtifactPreview(artifact, onViewFullscreen)}</>
}

// ── CSS 柱状图（纯 CSS，匹配 prototype-v3） ──

function ChartBars({ bars }: { bars: BarItem[] }) {
  const max = Math.max(...bars.map(b => b.val), 1)

  return (
    <div className="wf-chart-bars">
      {bars.map((b, i) => (
        <div key={i} className="wf-chart-col">
          <span className="wf-chart-val">{b.disp || b.val}</span>
          <div
            className="wf-chart-bar"
            style={{
              height: `${(b.val / max) * 110}px`,
              background: b.color || 'var(--wf-accent)',
            }}
          />
          <span className="wf-chart-x">{b.label}</span>
        </div>
      ))}
    </div>
  )
}

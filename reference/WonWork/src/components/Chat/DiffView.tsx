import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { diffText } from '@/utils/diffText'
import type { ToolResultRendererProps } from '@/agent/tools/toolRenderRegistry'

/**
 * DiffView —— hunk 级行差异视图（2026-09-01 二阶段切片3）。
 *
 * 共用面：审批卡（FloatingActionBar，操作前看改动）与写工具结果留痕
 * （WriteDiffResult，操作后看改了什么）。纯展示零 store 依赖，
 * 配色全走 wf token（--wf-ok/--wf-err 系），深浅主题自适应。
 */

/** 超过该行数默认折叠（头部仍可见，点击展开全文） */
const COLLAPSE_THRESHOLD_LINES = 40

/** 写改动模式：决定头部注记措辞 */
export type WriteDiffMode = 'create' | 'overwrite' | 'append' | 'replace' | 'replaceAll'

export interface WriteDiffData {
  path: string
  oldText: string
  newText: string
  mode: WriteDiffMode
}

interface DiffViewProps extends WriteDiffData {
  /** 覆盖头部注记（如 replace_all 执行后带实际处数）；缺省按 mode 出文案 */
  note?: string
}

export function DiffView({ path, oldText, newText, mode, note }: DiffViewProps) {
  const { t } = useTranslation()
  const diff = useMemo(() => diffText(oldText, newText), [oldText, newText])
  const totalLines = diff.hunks.reduce((s, h) => s + h.lines.length, 0)
  const collapsible = totalLines > COLLAPSE_THRESHOLD_LINES
  const [expanded, setExpanded] = useState(!collapsible)

  const modeNote =
    note ??
    (mode === 'create'
      ? t('chat.diff.newFile')
      : mode === 'append'
        ? t('chat.diff.append')
        : mode === 'replaceAll'
          ? t('chat.diff.replaceAll')
          : null)

  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        fontSize: 12,
        color: 'var(--wf-mut)',
        cursor: collapsible ? 'pointer' : undefined,
        userSelect: 'none',
      }}
      onClick={collapsible ? () => setExpanded((v) => !v) : undefined}
      title={collapsible ? t(expanded ? 'chat.diff.collapse' : 'chat.diff.expand') : undefined}
    >
      {path && (
        <span
          style={{
            color: 'var(--wf-sub)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '60%',
          }}
        >
          {path}
        </span>
      )}
      <span style={{ color: 'var(--wf-ok-ink)' }}>+{diff.additions}</span>
      <span style={{ color: 'var(--wf-err-ink)' }}>−{diff.deletions}</span>
      {diff.coarse && <span>{t('chat.diff.coarse')}</span>}
      {modeNote && <span>{modeNote}</span>}
      {collapsible && <span style={{ marginLeft: 'auto' }}>{expanded ? '▴' : '▾'}</span>}
    </div>
  )

  return (
    <div
      style={{
        border: '1px solid var(--wf-line)',
        borderRadius: 8,
        background: 'var(--wf-card-bg)',
        padding: '6px 0',
      }}
    >
      <div style={{ padding: '0 10px' }}>{header}</div>
      {expanded && (
        <div
          style={{
            marginTop: 6,
            maxHeight: 320,
            overflow: 'auto',
            fontFamily: 'var(--wf-mono, ui-monospace, Consolas, monospace)',
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {diff.hunks.map((h, hi) => {
            let oldNo = h.oldStart
            let newNo = h.newStart
            return (
              <div key={hi}>
                {hi > 0 && (
                  <div
                    style={{
                      padding: '0 10px',
                      color: 'var(--wf-mut)',
                      borderTop: '1px dashed var(--wf-line)',
                      borderBottom: '1px dashed var(--wf-line)',
                      fontSize: 11,
                    }}
                  >
                    ⋯
                  </div>
                )}
                {h.lines.map((l, li) => {
                  const oldLabel = l.type !== 'add' ? String(oldNo++) : ''
                  const newLabel = l.type !== 'del' ? String(newNo++) : ''
                  const isAdd = l.type === 'add'
                  const isDel = l.type === 'del'
                  return (
                    <div
                      key={li}
                      style={{
                        display: 'flex',
                        whiteSpace: 'pre',
                        background: isAdd
                          ? 'var(--wf-ok-bg)'
                          : isDel
                            ? 'var(--wf-err-bg)'
                            : undefined,
                        color: isAdd
                          ? 'var(--wf-ok-ink)'
                          : isDel
                            ? 'var(--wf-err-ink)'
                            : 'var(--wf-sub)',
                      }}
                    >
                      <span
                        style={{
                          flex: '0 0 3.2em',
                          textAlign: 'right',
                          paddingRight: 6,
                          color: 'var(--wf-mut)',
                          userSelect: 'none',
                        }}
                      >
                        {oldLabel}
                      </span>
                      <span
                        style={{
                          flex: '0 0 3.2em',
                          textAlign: 'right',
                          paddingRight: 6,
                          color: 'var(--wf-mut)',
                          userSelect: 'none',
                          borderRight: '1px solid var(--wf-line)',
                          marginRight: 6,
                        }}
                      >
                        {newLabel}
                      </span>
                      <span style={{ userSelect: 'none', marginRight: 4 }}>
                        {isAdd ? '+' : isDel ? '−' : ' '}
                      </span>
                      <span>{l.text}</span>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * 从写工具参数提取 diff 输入（审批卡 rawParams 与结果留痕 argsText 共用）。
 * 提取不出（参数残缺/非写工具）返回 null，调用方回退默认展示。
 */
export function extractWriteDiff(
  toolName: string,
  params: Record<string, unknown>
): WriteDiffData | null {
  const path = typeof params.path === 'string' ? params.path : ''
  if (toolName === 'str_replace') {
    if (typeof params.old_string !== 'string' || typeof params.new_string !== 'string') return null
    return {
      path,
      oldText: params.old_string,
      newText: params.new_string,
      mode: params.replace_all === true ? 'replaceAll' : 'replace',
    }
  }
  if (toolName === 'write_file') {
    if (typeof params.content !== 'string') return null
    if (params.append === true) {
      // 追加模式：旧文本未知（无 expectedContent 约定），按纯新增展示
      return { path, oldText: '', newText: params.content, mode: 'append' }
    }
    // 覆盖已存在文件时工具有 expectedContent 强约束；缺省=新文件（纯新增）
    const oldText = typeof params.expectedContent === 'string' ? params.expectedContent : ''
    return {
      path,
      oldText,
      newText: params.content,
      mode: typeof params.expectedContent === 'string' ? 'overwrite' : 'create',
    }
  }
  return null
}

/**
 * write_file / str_replace 结果留痕渲染器（注册进 toolRenderRegistry）。
 *
 * 数据源：argsText（ToolNode.args=模型原始参数 JSON，已随历史持久化）重建
 * 改动两侧——结果对象刻意不含文件内容（防模型上下文膨胀），diff 是渲染期计算。
 * 参数解析失败/非成功结果返回默认摘要行，不留空白。
 */
export function WriteDiffResultRenderer({ message, argsText }: ToolResultRendererProps) {
  const { t } = useTranslation()
  const sd = (message.structuredData ?? undefined) as Record<string, unknown> | undefined

  let data: WriteDiffData | null = null
  if (argsText) {
    try {
      const params = JSON.parse(argsText) as Record<string, unknown>
      data = extractWriteDiff(message.toolCallName ?? '', params)
    } catch {
      // 参数不是合法 JSON（历史数据/截断）——落回摘要行
    }
  }

  if (!data) {
    if (!message.content) return null
    return (
      <div style={{ fontSize: 13, color: 'var(--wf-sub)', whiteSpace: 'pre-wrap' }}>
        {message.content}
      </div>
    )
  }

  // str_replace replace_all 执行后结果带 replacements 实数，注记升级为带次数版
  const replacements =
    typeof sd?.replacements === 'number' && sd.replacements > 1 ? sd.replacements : undefined
  const note =
    data.mode === 'replaceAll' && replacements
      ? t('chat.diff.replaceAllCount', { count: replacements })
      : undefined

  return (
    <DiffView
      path={data.path}
      oldText={data.oldText}
      newText={data.newText}
      mode={data.mode}
      note={note}
    />
  )
}

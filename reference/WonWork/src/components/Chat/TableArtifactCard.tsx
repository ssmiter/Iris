import { memo, useMemo, useState } from 'react'
import { ArrowUpDown, Download, FolderOpen, Search, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ArtifactCardShell } from './ArtifactCardShell'
import { useWorkspaceFileStore } from '@/stores/workspaceFileStore'
import { resolveDownloadUrl } from '@/utils/fileReader'
import { formatFileSize } from '@/utils/formatFileSize'
import { cn } from '@/utils'
import type { TableArtifact } from '@/types/artifact'

interface TableArtifactCardProps {
  artifact: TableArtifact
}

type SortDirection = 'asc' | 'desc' | null

export const TableArtifactCard = memo(function TableArtifactCard({
  artifact,
}: TableArtifactCardProps) {
  const { t } = useTranslation()
  const { selectPath, expandPath, previewFile } = useWorkspaceFileStore()

  const [filter, setFilter] = useState('')
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>(null)

  const fileName = useMemo(
    () => artifact.fileName || artifact.path.split('/').pop() || artifact.path,
    [artifact.fileName, artifact.path]
  )

  const filteredRows = useMemo(() => {
    const text = filter.trim().toLowerCase()
    if (!text) return artifact.rows
    return artifact.rows.filter((row) =>
      Object.values(row).some((val) => String(val ?? '').toLowerCase().includes(text)
      )
    )
  }, [artifact.rows, filter])

  const sortedRows = useMemo(() => {
    if (!sortColumn || !sortDirection) return filteredRows
    return [...filteredRows].sort((a, b) => {
      const av = a[sortColumn]
      const bv = b[sortColumn]
      const as = String(av ?? '')
      const bs = String(bv ?? '')
      // 优先按数字比较
      const an = Number(as.replace(/,/g, ''))
      const bn = Number(bs.replace(/,/g, ''))
      if (!Number.isNaN(an) && !Number.isNaN(bn) && as !== '' && bs !== '') {
        return sortDirection === 'asc' ? an - bn : bn - an
      }
      return sortDirection === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as)
    })
  }, [filteredRows, sortColumn, sortDirection])

  const handleSort = (column: string) => {
    if (sortColumn !== column) {
      setSortColumn(column)
      setSortDirection('asc')
    } else if (sortDirection === 'asc') {
      setSortDirection('desc')
    } else {
      setSortColumn(null)
      setSortDirection(null)
    }
  }

  const handleLocate = () => {
    selectPath(artifact.path)
    const parts = artifact.path.split('/').filter(Boolean)
    let acc = ''
    for (const part of parts.slice(0, -1)) {
      acc += '/' + part
      expandPath(acc)
    }
    previewFile(artifact.path)
  }

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(artifact.path)
      toast.success(t('chat.artifactCard.copied'))
    } catch {
      toast.error(t('chat.artifactCard.copyFailed'))
    }
  }

  const showingCount = sortedRows.length
  const hasMore = artifact.totalRows > showingCount

  return (
    <ArtifactCardShell className="overflow-visible">
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="space-y-0.5">
            {artifact.caption && (
              <p className="text-base font-semibold text-surface-900 leading-snug">{artifact.caption}</p>
            )}
            <p className="text-xs text-surface-500">
              {t('chat.artifactCard.totalRows', { count: artifact.totalRows })}
              {hasMore && ` · ${t('chat.artifactCard.showingTopRows', { count: showingCount })}`}
            </p>
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('chat.artifactCard.filterPlaceholder')}
              className={cn(
                'pl-8 pr-3 py-1.5 w-full sm:w-56 rounded-lg text-xs',
                'border border-surface-200 bg-white text-surface-700',
                'placeholder:text-surface-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500'
              )}
            />
          </div>
        </div>

        <div className="rounded-lg border border-surface-200 overflow-hidden">
          <div className="overflow-x-auto max-h-80">
            <table className="min-w-full text-xs">
              <thead className="bg-surface-100 sticky top-0 z-10">
                <tr>
                  {artifact.columns.map((col) => (
                    <th
                      key={col}
                      scope="col"
                      onClick={() => handleSort(col)}
                      className={cn(
                        'px-3 py-2 text-left font-semibold text-surface-700 border-b border-surface-200',
                        'cursor-pointer select-none hover:bg-surface-200 transition-colors'
                      )}
                    >
                      <div className="flex items-center gap-1">
                        <span className="truncate max-w-[160px]">{col}</span>
                        <ArrowUpDown
                          size={12}
                          className={cn(
                            'flex-shrink-0 text-surface-400',
                            sortColumn === col && 'text-primary-600'
                          )}
                        />
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bg-white">
                {sortedRows.map((row, i) => (
                  <tr key={i} className="hover:bg-surface-50 transition-colors">
                    {artifact.columns.map((col) => (
                      <td
                        key={col}
                        className="px-3 py-2 border-b border-surface-100 text-surface-700 whitespace-nowrap"
                      >
                          {String(row[col] ?? '')}
                        </td>
                    ))}
                  </tr>
                ))}
                {sortedRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={artifact.columns.length}
                      className="px-3 py-4 text-center text-surface-400"
                    >
                      {t('chat.messageBubble.noResult')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="px-3 py-2 bg-surface-50 border-t border-surface-200 text-xs text-surface-500">
              {t('chat.artifactCard.showingTopRows', { count: showingCount })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs text-surface-500 truncate max-w-[260px]" title={fileName}>
            {fileName}
            {artifact.sizeBytes > 0 && ` · ${formatFileSize(artifact.sizeBytes)}`}
          </div>
          <div className="flex items-center gap-2">
            <a
              href={resolveDownloadUrl(artifact.previewUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium',
                'bg-surface-100 text-surface-700 hover:bg-surface-200 transition-colors'
              )}
            >
              <Download size={14} />
              {t('chat.artifactCard.download')}
            </a>
            <button
              type="button"
              onClick={handleCopyPath}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium',
                'bg-surface-100 text-surface-700 hover:bg-surface-200 transition-colors'
              )}
            >
              <Copy size={14} />
              {t('chat.artifactCard.copyPath')}
            </button>
            <button
              type="button"
              onClick={handleLocate}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium',
                'bg-primary-50 text-primary-700 hover:bg-primary-100 transition-colors'
              )}
            >
              <FolderOpen size={14} />
              {t('chat.artifactCard.locateInWorkspace')}
            </button>
          </div>
        </div>
      </div>
    </ArtifactCardShell>
  )
})

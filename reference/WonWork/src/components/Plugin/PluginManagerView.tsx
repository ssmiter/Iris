import { useTranslation } from 'react-i18next'
import { useState, useEffect, useRef } from 'react'
import { cn } from '@/utils'
import { usePluginStore } from '@/stores/pluginStore'
import type { InstalledPlugin, PluginContribution } from '@/types/plugin'
import {
  Puzzle,
  Upload,
  Trash2,
  RefreshCw,
  AlertCircle,
  Search,
  ChevronDown,
  Plus,
} from 'lucide-react'

export function PluginManagerView() {
  const { t } = useTranslation()
  const {
    plugins,
    isLoading,
    error,
    loadPlugins,
    installPlugin,
    uninstallPlugin,
    togglePlugin,
    clearError,
  } = usePluginStore()

  const [searchQuery, setSearchQuery] = useState('')
  const [isInstalling, setIsInstalling] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadPlugins()
  }, [loadPlugins])

  const handleInstall = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setIsInstalling(true)
    clearError()
    try {
      await installPlugin(file)
    } catch {
      // 错误已写入 store，UI 通过 error banner 展示
    } finally {
      setIsInstalling(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const filteredPlugins = plugins.filter(
    (p) =>
      p.manifest.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.manifest.description || '').toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div className="flex flex-col h-full bg-surface-50">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-surface-200">
        <div className="flex items-center gap-3">
          <Puzzle size={20} className="text-primary-500" />
          <h1 className="text-lg font-semibold text-surface-800">{t('plugin.manager.title')}</h1>
          <span className="text-xs text-surface-400">
            {t('plugin.manager.installed', { count: plugins.length })}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,application/json"
            className="hidden"
            onChange={handleInstall}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isInstalling}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-500 text-white text-sm rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50"
          >
            {isInstalling ? (
              <>
                <RefreshCw size={14} className="animate-spin" />
                {t('plugin.manager.installing')}
              </>
            ) : (
              <>
                <Plus size={14} />
                {t('plugin.manager.install')}
              </>
            )}
          </button>
          <button
            onClick={() => loadPlugins()}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-surface-600 hover:bg-surface-100 rounded-lg transition-colors disabled:opacity-50"
            title={t('plugin.manager.refresh')}
          >
            <RefreshCw size={14} className={cn(isLoading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center justify-between gap-2 px-6 py-2 bg-red-50 border-b border-red-200">
          <div className="flex items-center gap-2">
            <AlertCircle size={14} className="text-red-500" />
            <span className="text-xs text-red-700">{error}</span>
          </div>
          <button onClick={clearError} className="text-xs text-red-600 hover:text-red-800">
            {t('plugin.manager.dismiss')}
          </button>
        </div>
      )}

      {/* Search */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-surface-200 bg-white">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('plugin.manager.search')}
            className="pl-8 pr-3 py-1.5 text-sm bg-surface-100 rounded-lg border border-surface-200 focus:outline-none focus:border-primary-400 w-64"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-surface-400">
            <RefreshCw size={20} className="animate-spin mr-2" />
            {t('plugin.manager.loading')}
          </div>
        ) : filteredPlugins.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-surface-400 gap-2">
            <Puzzle size={48} className="text-surface-300" />
            <p className="text-sm">{searchQuery ? t('plugin.manager.noMatch') : t('plugin.manager.noPlugins')}</p>
            {!searchQuery && (
              <p className="text-xs text-surface-400">{t('plugin.manager.installHint')}</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredPlugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                onToggle={() => togglePlugin(plugin.id, !plugin.isEnabled)}
                onUninstall={() => {
                  if (confirm(t('plugin.manager.deleteConfirm', { name: plugin.manifest.name }))) {
                    uninstallPlugin(plugin.id)
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PluginCard({
  plugin,
  onToggle,
  onUninstall,
}: {
  plugin: InstalledPlugin
  onToggle: () => void
  onUninstall: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const { manifest, isEnabled } = plugin

  return (
    <div className="bg-white rounded-xl border border-surface-200 overflow-hidden hover:shadow-md transition-shadow">
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
              <Puzzle size={18} className="text-primary-500" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-surface-800 truncate">{manifest.name}</h3>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] text-surface-400">v{manifest.version}</span>
                {manifest.author && (
                  <span className="text-[10px] text-surface-400 truncate max-w-[8rem]">{manifest.author}</span>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={onToggle}
            className={cn(
              'w-8 h-5 rounded-full transition-colors relative flex-shrink-0',
              isEnabled ? 'bg-primary-500' : 'bg-surface-300'
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform',
                isEnabled ? 'left-3.5' : 'left-0.5'
              )}
            />
          </button>
        </div>

        <p className="text-xs text-surface-500 mt-3 line-clamp-2">
          {manifest.description || t('plugin.manager.noDescription')}
        </p>

        <div className="flex items-center gap-1 mt-3">
          {(manifest.contributions || []).slice(0, 4).map((c) => (
            <ContributionTag key={`${c.type}:${c.id}`} contribution={c} />
          ))}
          {(manifest.contributions || []).length > 4 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-50 text-surface-400">
              +{(manifest.contributions || []).length - 4}
            </span>
          )}
        </div>

        {expanded && (
          <div className="mt-3 pt-3 border-t border-surface-100 space-y-2">
            <div>
              <p className="text-[10px] font-medium text-surface-500 mb-1">{t('plugin.manager.pluginId')}</p>
              <p className="text-xs text-surface-600 font-mono break-all">{manifest.id}</p>
            </div>
            {manifest.targetCoreVersion && (
              <div>
                <p className="text-[10px] font-medium text-surface-500 mb-1">{t('plugin.manager.targetCoreVersion')}</p>
                <p className="text-xs text-surface-600">{manifest.targetCoreVersion}</p>
              </div>
            )}
            {(manifest.contributions || []).length > 0 && (
              <div>
                <p className="text-[10px] font-medium text-surface-500 mb-1">{t('plugin.manager.contributions')}</p>
                <ul className="text-xs text-surface-600 space-y-1">
                  {(manifest.contributions || []).map((c) => (
                    <li key={`${c.type}:${c.id}`} className="flex items-center gap-1">
                      <span className="px-1.5 py-0.5 rounded bg-surface-100 text-surface-500 text-[10px]">
                        {c.type}
                      </span>
                      <span className="font-medium">{c.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="text-[10px] text-surface-400">
              {t('plugin.manager.updatedAt', { datetime: new Date(plugin.updatedAt).toLocaleString() })}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-4 py-2 bg-surface-50 border-t border-surface-100">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-surface-500 hover:text-surface-700 transition-colors"
        >
          <ChevronDown size={12} className={cn('transition-transform', expanded && 'rotate-180')} />
          {expanded ? t('plugin.manager.collapse') : t('plugin.manager.details')}
        </button>
        <button
          onClick={onUninstall}
          className="p-1.5 rounded hover:bg-red-100 text-surface-500 hover:text-red-500 transition-colors"
          title={t('plugin.manager.uninstall')}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}

function ContributionTag({ contribution }: { contribution: PluginContribution }) {
  const labels: Record<PluginContribution['type'], string> = {
    skill: 'SKILL',
    workflow_node: 'NODE',
    webbridge_action: 'WB',
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-500">
      {labels[contribution.type]}
    </span>
  )
}

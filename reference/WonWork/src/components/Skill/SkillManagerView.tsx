import { useTranslation } from 'react-i18next'
import { useState, useEffect, useRef, useCallback } from 'react'
import { cn } from '@/utils'
import { useSkillStore } from '@/stores/skillStore'
import type { SkillManifest, SkillTriggerMode, SkillType } from '@/types/skill'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'
import {
  Wrench,
  FolderOpen,
  RefreshCw,
  Unlink,
  Plus,
  Upload,
  Download,
  Trash2,
  Edit3,
  Check,
  X,
  FileText,
  Table,
  Calendar,
  Puzzle,
  Power,
  AlertCircle,
  ChevronDown,
  Search,
} from 'lucide-react'

const TYPE_KEYS: Record<SkillType, string> = {
  'document-word': 'skill.skillManager.wordDoc',
  'document-excel': 'skill.skillManager.excelDoc',
  'document-generic': 'skill.skillManager.genericDoc',
  'custom': 'skill.skillManager.custom',
}

const TYPE_ICONS: Record<SkillType, typeof FileText> = {
  'document-word': FileText,
  'document-excel': Table,
  'document-generic': FileText,
  'custom': Puzzle,
}

export function SkillManagerView() {
  const { t } = useTranslation()
  const {
    skills,
    isLoading,
    isWorkspaceConnected,
    isFallbackMode,
    workspacePath,
    init,
    pickWorkspace,
    reconnectWorkspace,
    disconnectWorkspace,
    uninstallSkill,
    toggleSkill,
    exportToFile,
    importFromFile,
  } = useSkillStore()

  const [activeTab, setActiveTab] = useState<'installed' | 'loaded'>('installed')
  const [editingSkill, setEditingSkill] = useState<SkillManifest | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    init()
  }, [init])

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      await importFromFile(file)
      if (fileInputRef.current) fileInputRef.current.value = ''
    } catch (err) {
      alert(t('skill.skillManager.importFailed', { error: err instanceof Error ? err.message : t('skill.skillManager.unknownError') }))
    }
  }, [importFromFile, t])

  const filteredSkills = skills.filter((s) =>
    s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.description.toLowerCase().includes(searchQuery.toLowerCase())
  )

  return (
    <div className="flex flex-col h-full bg-surface-50">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 bg-white border-b border-surface-200">
        <div className="flex items-center gap-3">
          <Wrench size={20} className="text-primary-500" />
          <h1 className="text-lg font-semibold text-surface-800">{t('skill.skillManager.title')}</h1>
          <span className="text-xs text-surface-400">
            {!IS_STANDALONE
              ? t('skill.skillManager.backendStorage')
              : isWorkspaceConnected
                ? isFallbackMode
                  ? t('skill.skillManager.memoryMode')
                  : workspacePath || t('skill.skillManager.connected')
                : t('skill.skillManager.notConnected')}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {IS_STANDALONE && !isWorkspaceConnected && !isFallbackMode && (
            <button
              onClick={() => pickWorkspace()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary-500 text-white text-sm rounded-lg hover:bg-primary-600 transition-colors"
            >
              <FolderOpen size={14} />
              {t('skill.skillManager.selectWorkspace')}
            </button>
          )}
          {IS_STANDALONE && isWorkspaceConnected && !isFallbackMode && (
            <>
              <button
                onClick={() => reconnectWorkspace()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-surface-600 hover:bg-surface-100 rounded-lg transition-colors"
                title={t('skill.skillManager.reconnect')}
              >
                <RefreshCw size={14} />
              </button>
              <button
                onClick={() => disconnectWorkspace()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-surface-600 hover:bg-surface-100 rounded-lg transition-colors"
                title={t('skill.skillManager.disconnect')}
              >
                <Unlink size={14} />
              </button>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,text/markdown"
            className="hidden"
            onChange={handleImport}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-surface-600 hover:bg-surface-100 rounded-lg transition-colors"
          >
            <Upload size={14} />
            {t('skill.skillManager.import')}
          </button>
        </div>
      </div>

      {/* Workspace Status Banner */}
      {isFallbackMode && (
        <div className="flex items-center gap-2 px-6 py-2 bg-amber-50 border-b border-amber-200">
          <AlertCircle size={14} className="text-amber-500" />
          <span className="text-xs text-amber-700">
            {t('skill.skillManager.fallbackWarning')}
          </span>
        </div>
      )}

      {/* Tabs + Search */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-surface-200 bg-white">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab('installed')}
            className={cn(
              'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors',
              activeTab === 'installed'
                ? 'bg-primary-50 text-primary-600'
                : 'text-surface-500 hover:text-surface-700 hover:bg-surface-50'
            )}
          >
            {t('skill.skillManager.installed', { count: skills.length })}
          </button>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('skill.skillManager.search')}
            className="pl-8 pr-3 py-1.5 text-sm bg-surface-100 rounded-lg border border-surface-200 focus:outline-none focus:border-primary-400 w-48"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-surface-400">
            <RefreshCw size={20} className="animate-spin mr-2" />
            {t('skill.skillManager.loading')}
          </div>
        ) : !isWorkspaceConnected && !isFallbackMode ? (
          <div className="flex flex-col items-center justify-center h-full text-surface-400 gap-3">
            <FolderOpen size={48} className="text-surface-300" />
            <p className="text-sm">{t('skill.skillManager.notConnectedWorkspace')}</p>
            <p className="text-xs text-surface-400 max-w-md text-center">
              {t('skill.skillManager.workspaceHint')}
            </p>
            <button
              onClick={() => pickWorkspace()}
              className="mt-2 px-4 py-2 bg-primary-500 text-white text-sm rounded-lg hover:bg-primary-600 transition-colors"
            >
              {t('skill.skillManager.selectWorkspaceDir')}
            </button>
          </div>
        ) : activeTab === 'installed' && filteredSkills.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-surface-400 gap-2">
            <Puzzle size={40} className="text-surface-300" />
            <p className="text-sm">{t('skill.skillManager.noSkill')}</p>
            <p className="text-xs text-surface-400">{t('skill.skillManager.importHint')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
            {activeTab === 'installed' &&
              filteredSkills.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onToggle={() => toggleSkill(skill.id)}
                  onEdit={() => {
                    setEditingSkill(skill)
                    setShowEditor(true)
                  }}
                  onExport={() => exportToFile(skill.id)}
                  onDelete={() => {
                    if (confirm(t('skill.skillManager.deleteConfirm', { name: skill.name }))) {
                      uninstallSkill(skill.id)
                    }
                  }}
                />
              ))}
          </div>
        )}
      </div>

      {/* Editor Modal */}
      {showEditor && editingSkill && (
        <SkillEditorModal
          skill={editingSkill}
          onClose={() => {
            setShowEditor(false)
            setEditingSkill(null)
          }}
        />
      )}
    </div>
  )
}

// ==================== SkillCard ====================

function SkillCard({
  skill,
  onToggle,
  onEdit,
  onExport,
  onDelete,
}: {
  skill: SkillManifest
  onToggle: () => void
  onEdit: () => void
  onExport: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const Icon = TYPE_ICONS[skill.type] || Puzzle

  return (
    <div className="bg-white rounded-xl border border-surface-200 overflow-hidden hover:shadow-md transition-shadow">
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary-50 flex items-center justify-center flex-shrink-0">
              <Icon size={18} className="text-primary-500" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-surface-800 truncate">{skill.name}</h3>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-100 text-surface-500">
                  {t(TYPE_KEYS[skill.type])}
                </span>
                <span className="text-[10px] text-surface-400">v{skill.version}</span>
                {skill.source === 'built-in' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-500">
                    {t('skill.skillManager.builtIn')}
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={onToggle}
            className={cn(
              'w-8 h-5 rounded-full transition-colors relative flex-shrink-0',
              skill.enabled ? 'bg-primary-500' : 'bg-surface-300'
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform',
                skill.enabled ? 'left-3.5' : 'left-0.5'
              )}
            />
          </button>
        </div>

        <p className="text-xs text-surface-500 mt-3 line-clamp-2">{skill.description}</p>

        <div className="flex items-center gap-1 mt-3">
          {skill.tags.map((tag) => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-surface-50 text-surface-400">
              {tag}
            </span>
          ))}
        </div>

        {expanded && (
          <div className="mt-3 pt-3 border-t border-surface-100">
            <p className="text-[10px] font-medium text-surface-500 mb-1">{t('skill.skillManager.triggerMode')}</p>
            <p className="text-xs text-surface-600">
              {skill.trigger.mode === 'always'
                ? t('skill.skillManager.alwaysActive')
                : skill.trigger.mode === 'keyword'
                  ? t('skill.skillManager.keywords', { keywords: skill.trigger.keywords?.join(', ') || t('skill.skillManager.noKeywords') })
                  : t('skill.skillManager.manualLoad')}
            </p>
            <p className="text-[10px] font-medium text-surface-500 mt-2 mb-1">{t('skill.skillManager.promptPreview')}</p>
            <pre className="text-[10px] text-surface-600 bg-surface-50 rounded-lg p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">
              {skill.prompt.slice(0, 300)}{skill.prompt.length > 300 ? '...' : ''}
            </pre>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-4 py-2 bg-surface-50 border-t border-surface-100">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-surface-500 hover:text-surface-700 transition-colors"
        >
          <ChevronDown size={12} className={cn('transition-transform', expanded && 'rotate-180')} />
          {expanded ? t('skill.skillManager.collapse') : t('skill.skillManager.details')}
        </button>
        <div className="flex items-center gap-1">
          <button
            onClick={onEdit}
            className="p-1.5 rounded hover:bg-surface-200 text-surface-500 hover:text-surface-700 transition-colors"
            title={t('skill.skillManager.edit')}
          >
            <Edit3 size={12} />
          </button>
          <button
            onClick={onExport}
            className="p-1.5 rounded hover:bg-surface-200 text-surface-500 hover:text-surface-700 transition-colors"
            title={t('skill.skillManager.export')}
          >
            <Download size={12} />
          </button>
          {skill.source === 'local' && (
            <button
              onClick={onDelete}
              className="p-1.5 rounded hover:bg-red-100 text-surface-500 hover:text-red-500 transition-colors"
              title={t('skill.skillManager.delete')}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ==================== SkillEditorModal ====================

function SkillEditorModal({ skill, onClose }: { skill: SkillManifest; onClose: () => void }) {
  const { t } = useTranslation()
  const { updateSkill } = useSkillStore()
  const [form, setForm] = useState({
    name: skill.name,
    description: skill.description,
    type: skill.type,
    triggerMode: skill.trigger.mode,
    keywords: skill.trigger.keywords?.join(', ') || '',
    prompt: skill.prompt,
    enabled: skill.enabled,
  })

  const handleSave = () => {
    const keywords = form.keywords
      .split(/[,，]/)
      .map((k) => k.trim())
      .filter(Boolean)

    updateSkill(skill.id, {
      name: form.name,
      description: form.description,
      type: form.type as SkillType,
      trigger: {
        mode: form.triggerMode as SkillTriggerMode,
        keywords: form.triggerMode === 'keyword' ? keywords : undefined,
      },
      prompt: form.prompt,
      enabled: form.enabled,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-200">
          <h2 className="text-base font-semibold text-surface-800">{t('skill.skillManager.editSkill')}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-surface-100 text-surface-400">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-surface-600 mb-1">{t('skill.skillManager.name')}</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-surface-50 border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-surface-600 mb-1">{t('skill.skillManager.description')}</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-surface-50 border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-surface-600 mb-1">{t('skill.skillManager.type')}</label>
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as SkillType })}
                className="w-full px-3 py-2 text-sm bg-surface-50 border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
              >
                <option value="document-word">{t('skill.skillManager.wordDoc')}</option>
                <option value="document-excel">{t('skill.skillManager.excelDoc')}</option>
                <option value="document-generic">{t('skill.skillManager.genericDoc')}</option>
                <option value="custom">{t('skill.skillManager.custom')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-surface-600 mb-1">{t('skill.skillManager.triggerModeLabel')}</label>
              <select
                value={form.triggerMode}
                onChange={(e) => setForm({ ...form, triggerMode: e.target.value as SkillTriggerMode })}
                className="w-full px-3 py-2 text-sm bg-surface-50 border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
              >
                <option value="always">{t('skill.skillManager.alwaysActive')}</option>
                <option value="keyword">{t('skill.skillManager.keyword')}</option>
                <option value="manual">{t('skill.skillManager.manualLoad')}</option>
              </select>
            </div>
          </div>

          {form.triggerMode === 'keyword' && (
            <div>
              <label className="block text-xs font-medium text-surface-600 mb-1">
                {t('skill.skillManager.keywordSeparator')}
              </label>
              <input
                type="text"
                value={form.keywords}
                onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                placeholder={t('skill.skillManager.keywordPlaceholder')}
                className="w-full px-3 py-2 text-sm bg-surface-50 border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-surface-600 mb-1">{t('skill.skillManager.prompt')}</label>
            <textarea
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              rows={10}
              className="w-full px-3 py-2 text-sm bg-surface-50 border border-surface-200 rounded-lg focus:outline-none focus:border-primary-400 font-mono"
            />
            <p className="text-[10px] text-surface-400 mt-1">
              {t('skill.skillManager.promptHint')}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="enabled"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="rounded border-surface-300 text-primary-500 focus:ring-primary-400"
            />
            <label htmlFor="enabled" className="text-sm text-surface-600">
              {t('skill.skillManager.enableSkill')}
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-surface-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-surface-600 hover:bg-surface-100 rounded-lg transition-colors"
          >
            {t('skill.skillManager.cancel')}
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition-colors"
          >
            {t('skill.skillManager.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

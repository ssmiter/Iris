import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { connectionApi, type ConnectionConfigInfo } from '@/api/client'
import { credentialAutofillGuard, plainTextAutofillGuard } from '@/utils/autofillGuard'
import { Database, Search, Check, AlertCircle, Loader2, RotateCcw } from 'lucide-react'

type Status = 'idle' | 'busy' | 'success' | 'error'

/**
 * 开发者选项 · 数据库连接配置。
 * 输入系统代码查询当前生效连接（自定义覆盖 / 默认），可修改、测试、保存、恢复默认。
 * 服务端保存即热生效（connection-overrides.json + reloadOnChange），无需重启。
 * 仅在 devModeUnlocked 且非 standalone 时由 SettingsView 挂载。
 */
export function DatabaseSettingsView() {
  const { t } = useTranslation()
  const [systemCode, setSystemCode] = useState('')
  const [queriedCode, setQueriedCode] = useState('')
  const [current, setCurrent] = useState<ConnectionConfigInfo | null>(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ name: '', server: '', database: '', userId: '', password: '' })
  const [queryStatus, setQueryStatus] = useState<Status>('idle')
  const [actionStatus, setActionStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')

  const handleQuery = useCallback(async () => {
    const code = systemCode.trim()
    if (!code) return
    setQueryStatus('busy')
    setMessage('')
    setEditing(false)
    try {
      const info = await connectionApi.getConnection(code)
      setCurrent(info)
      setQueriedCode(code)
      setForm({ name: '', server: info.server, database: info.database, userId: info.userId, password: '' })
      setQueryStatus('idle')
    } catch (err) {
      setCurrent(null)
      setQueryStatus('error')
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }, [systemCode])

  const runAction = useCallback(
    async (action: () => Promise<{ message: string }>) => {
      setActionStatus('busy')
      setMessage('')
      try {
        const result = await action()
        setActionStatus('success')
        setMessage(result.message)
        // 保存/恢复后刷新当前配置展示（source 徽章可能变化）
        const info = await connectionApi.getConnection(queriedCode)
        setCurrent(info)
        setEditing(false)
      } catch (err) {
        setActionStatus('error')
        setMessage(err instanceof Error ? err.message : String(err))
      }
    },
    [queriedCode]
  )

  const handleTest = useCallback(() => {
    void runAction(() => connectionApi.testConnection(queriedCode, form))
  }, [runAction, queriedCode, form])

  const handleSave = useCallback(() => {
    const profileName = form.name.trim()
    void runAction(() =>
      profileName
        ? connectionApi.saveProfile(queriedCode, { ...form, name: profileName })
        : connectionApi.saveConnection(queriedCode, form)
    )
  }, [runAction, queriedCode, form])

  const handleReset = useCallback(() => {
    void runAction(() => connectionApi.resetConnection(queriedCode))
  }, [runAction, queriedCode])

  const handleActivate = useCallback(
    (profileName: string) => {
      void runAction(() => connectionApi.activateProfile(queriedCode, profileName))
    },
    [runAction, queriedCode]
  )

  const handleDeleteProfile = useCallback(
    (profileName: string) => {
      void runAction(() => connectionApi.deleteProfile(queriedCode, profileName))
    },
    [runAction, queriedCode]
  )

  const busy = actionStatus === 'busy'
  const formValid =
    form.server.trim() !== '' &&
    form.database.trim() !== '' &&
    form.userId.trim() !== '' &&
    form.password.trim() !== ''

  return (
    <div className="bg-[var(--wf-card-bg)] border border-[var(--wf-line)] rounded-xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <Database size={16} className="text-[var(--wf-mut)]" />
        <h3 className="text-sm font-semibold text-[var(--wf-sub)]">
          {t('settings.dbConfig.title', { defaultValue: '数据库连接' })}
        </h3>
        <span className="wf-badge-warn">
          {t('settings.dbConfig.devBadge', { defaultValue: '开发者选项' })}
        </span>
      </div>
      <p className="text-xs text-[var(--wf-faint)] mb-4">
        {t('settings.dbConfig.subtitle', {
          defaultValue: '按系统代码查看或修改数据库连接，保存后立即生效，无需重启',
        })}
      </p>

      {/* 系统代码查询 */}
      <div className="flex gap-2">
        <input
          type="text"
          {...plainTextAutofillGuard}
          value={systemCode}
          onChange={(e) => setSystemCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleQuery()}
          placeholder={t('settings.dbConfig.systemCodePlaceholder', { defaultValue: '输入系统代码' })}
          className="flex-1 px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400"
        />
        <button
          onClick={handleQuery}
          disabled={queryStatus === 'busy' || !systemCode.trim()}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
            queryStatus === 'busy' || !systemCode.trim()
              ? 'bg-[var(--wf-mono-bg)] text-[var(--wf-faint)] cursor-not-allowed'
              : 'bg-primary-500 text-white hover:bg-primary-600'
          )}
        >
          {queryStatus === 'busy' ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          {t('settings.dbConfig.query', { defaultValue: '查询' })}
        </button>
      </div>

      {queryStatus === 'error' && (
        <p className="mt-3 text-sm text-[var(--wf-err-ink)] flex items-center gap-1">
          <AlertCircle size={14} /> {message}
        </p>
      )}

      {/* 当前配置 */}
      {current && (
        <div className="mt-4 border border-[var(--wf-line)] rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-[var(--wf-sub)]">{queriedCode}</span>
            <div className="flex items-center gap-2">
              {current.activeProfile && (
                <span className="wf-badge-ok">
                  {current.activeProfile}
                </span>
              )}
              <span
                className={cn(
                  'text-xs px-2 py-0.5 rounded-full border',
                  current.source === 'override'
                    ? 'bg-primary-50 text-primary-600 border-primary-200'
                    : 'bg-[var(--wf-bg)] text-[var(--wf-mut)] border-[var(--wf-line)]'
                )}
              >
                {current.source === 'override'
                  ? t('settings.dbConfig.sourceOverride', { defaultValue: '自定义配置' })
                  : t('settings.dbConfig.sourceDefault', { defaultValue: '默认配置' })}
              </span>
            </div>
          </div>

          {!editing ? (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-[var(--wf-faint)]">{t('settings.dbConfig.server', { defaultValue: '服务器' })}</dt>
                <dd className="text-[var(--wf-sub)] break-all">{current.server}</dd>
                <dt className="text-[var(--wf-faint)]">{t('settings.dbConfig.database', { defaultValue: '数据库' })}</dt>
                <dd className="text-[var(--wf-sub)] break-all">{current.database}</dd>
                <dt className="text-[var(--wf-faint)]">{t('settings.dbConfig.userId', { defaultValue: '账号' })}</dt>
                <dd className="text-[var(--wf-sub)]">{current.userId}</dd>
                <dt className="text-[var(--wf-faint)]">{t('settings.dbConfig.password', { defaultValue: '密码' })}</dt>
                <dd className="text-[var(--wf-sub)]">
                  {current.hasPassword ? '********' : t('settings.dbConfig.noPassword', { defaultValue: '未配置' })}
                </dd>
              </dl>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setEditing(true)}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-500 text-white hover:bg-primary-600 transition-colors"
                >
                  {t('settings.dbConfig.edit', { defaultValue: '修改' })}
                </button>
                {current.source === 'override' && (
                  <button
                    onClick={handleReset}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm text-[var(--wf-sub)] hover:bg-[var(--wf-hover)] transition-colors"
                  >
                    <RotateCcw size={14} />
                    {t('settings.dbConfig.reset', { defaultValue: '恢复默认' })}
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <label className="block text-sm text-[var(--wf-sub)]">
                {t('settings.dbConfig.profileName', { defaultValue: '配置名称' })}
                <input
                  type="text"
                  {...plainTextAutofillGuard}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder={t('settings.dbConfig.profileNamePlaceholder', {
                    defaultValue: '如：现场生产库、公司存档库',
                  })}
                  className="mt-1 w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400"
                />
                <span className="text-xs text-[var(--wf-faint)] mt-1 block">
                  {t('settings.dbConfig.profileNameHint', {
                    defaultValue: '填写名称则保存到配置库并可随时切换；留空则仅临时生效',
                  })}
                </span>
              </label>
              <label className="block text-sm text-[var(--wf-sub)]">
                {t('settings.dbConfig.server', { defaultValue: '服务器' })}
                <input
                  type="text"
                  {...plainTextAutofillGuard}
                  value={form.server}
                  onChange={(e) => setForm((f) => ({ ...f, server: e.target.value }))}
                  placeholder="10.0.0.1"
                  className="mt-1 w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400"
                />
              </label>
              <label className="block text-sm text-[var(--wf-sub)]">
                {t('settings.dbConfig.database', { defaultValue: '数据库' })}
                <input
                  type="text"
                  {...plainTextAutofillGuard}
                  value={form.database}
                  onChange={(e) => setForm((f) => ({ ...f, database: e.target.value }))}
                  className="mt-1 w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm text-[var(--wf-sub)]">
                  {t('settings.dbConfig.userId', { defaultValue: '账号' })}
                  <input
                    type="text"
                    {...plainTextAutofillGuard}
                    value={form.userId}
                    onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))}
                    className="mt-1 w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400"
                  />
                </label>
                <label className="block text-sm text-[var(--wf-sub)]">
                  {t('settings.dbConfig.password', { defaultValue: '密码' })}
                  <input
                    type="password"
                    {...credentialAutofillGuard}
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    placeholder={t('settings.dbConfig.passwordPlaceholder', { defaultValue: '必填，加密保存' })}
                    className="mt-1 w-full px-3 py-2 border border-[var(--wf-line)] rounded-lg text-sm focus:outline-none focus:border-primary-400"
                  />
                </label>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleTest}
                  disabled={busy || !formValid}
                  className={cn(
                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors border',
                    busy || !formValid
                      ? 'border-[var(--wf-line)] text-[var(--wf-faint)] cursor-not-allowed'
                      : 'border-primary-300 text-primary-600 hover:bg-primary-50'
                  )}
                >
                  {t('settings.dbConfig.test', { defaultValue: '测试连接' })}
                </button>
                <button
                  onClick={handleSave}
                  disabled={busy || !formValid}
                  className={cn(
                    'flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                    busy || !formValid
                      ? 'bg-[var(--wf-mono-bg)] text-[var(--wf-faint)] cursor-not-allowed'
                      : 'bg-primary-500 text-white hover:bg-primary-600'
                  )}
                >
                  {busy && <Loader2 size={14} className="animate-spin" />}
                  {t('settings.dbConfig.save', { defaultValue: '保存' })}
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="px-4 py-2 rounded-lg text-sm text-[var(--wf-sub)] hover:bg-[var(--wf-hover)] transition-colors"
                >
                  {t('settings.settingsView.cancel', { defaultValue: '取消' })}
                </button>
              </div>
            </div>
          )}

          {/* 已保存的命名配置库：一键切换 / 删除 */}
          {!editing && current.profiles.length > 0 && (
            <div className="border-t border-[var(--wf-hair)] pt-3">
              <p className="text-xs text-[var(--wf-faint)] mb-2">
                {t('settings.dbConfig.savedProfiles', { defaultValue: '已保存的配置' })}
              </p>
              <div className="space-y-1.5">
                {current.profiles.map((p) => (
                  <div
                    key={p.name}
                    className={cn(
                      'flex items-center justify-between px-3 py-2 rounded-lg border text-sm',
                      p.isActive
                        ? 'border-[var(--wf-ok-line)] bg-[var(--wf-ok-bg)]'
                        : 'border-[var(--wf-line)] hover:border-primary-300'
                    )}
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-[var(--wf-sub)]">{p.name}</span>
                      <span className="text-xs text-[var(--wf-faint)] ml-2">
                        {p.server} / {p.database}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {p.isActive ? (
                        <span className="text-xs text-[var(--wf-ok-ink)] flex items-center gap-1">
                          <Check size={12} />
                          {t('settings.dbConfig.inUse', { defaultValue: '使用中' })}
                        </span>
                      ) : (
                        <button
                          onClick={() => handleActivate(p.name)}
                          disabled={busy}
                          className="text-xs px-2.5 py-1 rounded-md text-primary-600 hover:bg-primary-50 transition-colors"
                        >
                          {t('settings.dbConfig.switch', { defaultValue: '切换' })}
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteProfile(p.name)}
                        disabled={busy}
                        className="text-xs px-2.5 py-1 rounded-md text-[var(--wf-faint)] hover:text-[var(--wf-err-ink)] hover:bg-[var(--wf-err-bg)] transition-colors"
                      >
                        {t('settings.dbConfig.delete', { defaultValue: '删除' })}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {message && queryStatus !== 'error' && (
            <p
              className={cn(
                'text-sm flex items-center gap-1',
                actionStatus === 'error' ? 'text-[var(--wf-err-ink)]' : 'text-[var(--wf-ok-ink)]'
              )}
            >
              {actionStatus === 'error' ? <AlertCircle size={14} /> : <Check size={14} />}
              {message}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

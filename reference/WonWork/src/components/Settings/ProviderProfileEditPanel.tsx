/**
 * 供应商预设库 —— 编辑面板（2026-09-07）
 *
 * 三种录入方式（对齐 cc-switch 的精华，不照抄）：
 * 1. 预设网格：选中即预填表单（预设即数据，src/config/providerPresets.ts）
 * 2. 粘贴 cc-switch 配置：settingsConfig 整段 JSON 粘贴进来自动填表单
 * 3. 手动填空 + 底部完整 JSON 编辑器（给懂的人）
 *
 * 模型名不手输为主：「拉取清单」经后端 /api/providerprobe/models 拿真实可选模型，
 * 填充 datalist 供选择；手输保留作兜底（custom 私有化端点可能无清单端点）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, ChevronDown, ChevronLeft, ChevronRight, Cpu, Download, Globe, Key, Link, NotebookText, Ruler, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/utils'
import { providerProbeApi } from '@/api/client'
import { PROVIDER_PRESETS, presetToProfileDraft } from '@/config/providerPresets'
import { useProviderProfileStore } from '@/stores/providerProfileStore'
import {
  generateProfileId,
  parsePastedProviderConfig,
  PROFILE_PROVIDER_PREFIX,
  type ProviderApiFormat,
  type ProviderProfile,
} from '@/types/providerProfile'
import {
  effortLevelsForModel,
  getCapability,
  modelSupportsEffort,
  parseWindowInput,
  resolveUserEffort,
  setUserEffort,
  setUserWindowOverride,
  type EffortLevel,
} from '@/services/modelCapabilityRegistry'

interface FormState {
  name: string
  websiteUrl: string
  notes: string
  apiFormat: ProviderApiFormat
  baseUrl: string
  apiKey: string
  model: string
  modelsUrl: string
  effort: EffortLevel | undefined
  /** 上下文窗口覆盖（原始输入文本，支持 128000/128k/1m）；空=自动（注册表学习/名字猜测） */
  contextWindow: string
}

function formFromProfile(profile: ProviderProfile): FormState {
  const env = profile.settingsConfig.env ?? {}
  const anthropic = profile.meta.apiFormat === 'anthropic'
  const providerId = PROFILE_PROVIDER_PREFIX + profile.id
  const model = anthropic ? (env.ANTHROPIC_MODEL ?? '') : (env.OPENAI_MODEL ?? '')
  return {
    name: profile.name,
    websiteUrl: profile.websiteUrl ?? '',
    notes: profile.notes ?? '',
    apiFormat: profile.meta.apiFormat,
    baseUrl: anthropic ? (env.ANTHROPIC_BASE_URL ?? '') : (env.OPENAI_BASE_URL ?? ''),
    apiKey: anthropic
      ? (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '')
      : (env.OPENAI_API_KEY ?? ''),
    model,
    modelsUrl: profile.meta.modelsUrl ?? '',
    effort: model ? resolveUserEffort(providerId, model) : undefined,
    contextWindow: (() => {
      const v = model ? getCapability(providerId, model)?.userOverride : undefined
      return v ? String(v) : ''
    })(),
  }
}

/** 表单 → settingsConfig：保留既有 env 的其余键与非 env 顶层键，只覆盖表单管辖的键 */
function buildSettingsConfig(form: FormState, base?: ProviderProfile['settingsConfig']): ProviderProfile['settingsConfig'] {
  const prevEnv = { ...(base?.env ?? {}) }
  if (form.apiFormat === 'anthropic') {
    // 认证字段二选一：此前用哪个键就写回哪个，都没有则默认 AUTH_TOKEN（cc-switch 惯例）
    const keyField = !prevEnv.ANTHROPIC_AUTH_TOKEN && prevEnv.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'
    prevEnv.ANTHROPIC_BASE_URL = form.baseUrl.trim()
    prevEnv[keyField] = form.apiKey.trim()
    prevEnv.ANTHROPIC_MODEL = form.model.trim()
  } else {
    prevEnv.OPENAI_BASE_URL = form.baseUrl.trim()
    prevEnv.OPENAI_API_KEY = form.apiKey.trim()
    prevEnv.OPENAI_MODEL = form.model.trim()
  }
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(base ?? {})) {
    if (k !== 'env') rest[k] = v
  }
  return { ...rest, env: prevEnv }
}

export function ProviderProfileEditPanel({
  profileId,
  onClose,
}: {
  /** null=新增 */
  profileId: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const existing = useProviderProfileStore((s) =>
    profileId ? s.profiles.find((p) => p.id === profileId) : undefined
  )

  // 新增草稿的 id 在挂载时生成：effort 注册表键（profile:<id>+model）保存前即稳定
  const [draftId] = useState(() => profileId ?? generateProfileId())
  const [form, setForm] = useState<FormState>(() =>
    existing ? formFromProfile(existing) : {
      name: '', websiteUrl: '', notes: '', apiFormat: 'anthropic',
      baseUrl: '', apiKey: '', model: '', modelsUrl: '', effort: undefined, contextWindow: '',
    }
  )
  const [extraConfig, setExtraConfig] = useState<ProviderProfile['settingsConfig'] | undefined>(
    () => existing?.settingsConfig
  )
  const [pasteText, setPasteText] = useState('')
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  // 模型清单弹层（2026-09-08 替换原生 datalist）：datalist 的过滤由浏览器按当前
  // 输入值子串过滤且不可覆盖——选中一个模型后再点开只剩它自己。自绘弹层：
  // 打开恒显全量，开始输入才按输入过滤
  const [modelOpen, setModelOpen] = useState(false)
  const [modelShowAll, setModelShowAll] = useState(false)
  const modelWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!modelOpen) return
    const onDown = (e: MouseEvent) => {
      if (modelWrapRef.current && !modelWrapRef.current.contains(e.target as Node)) {
        setModelOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [modelOpen])
  const [jsonDirty, setJsonDirty] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [saving, setSaving] = useState(false)

  const providerId = PROFILE_PROVIDER_PREFIX + draftId
  const showPresetGrid = !existing && !form.name && !form.baseUrl

  // 切换协议格式：连接三字段从目标格式的 env 键回填（有值才覆盖手填内容），
  // 旧格式键保留在 env 里不删（buildSettingsConfig 只覆盖当前格式管辖的键）
  const switchFormat = (next: ProviderApiFormat) => {
    if (next === form.apiFormat) return
    const env = extraConfig?.env ?? {}
    const pick = (v: string | undefined, cur: string) => (v ? v : cur)
    setForm((p) => ({
      ...p,
      apiFormat: next,
      baseUrl: pick(next === 'anthropic' ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL, p.baseUrl),
      apiKey: pick(
        next === 'anthropic' ? (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) : env.OPENAI_API_KEY,
        p.apiKey
      ),
      model: pick(next === 'anthropic' ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL, p.model),
    }))
    setJsonDirty(false)
  }

  const effectiveSettingsConfig = useMemo(
    () => buildSettingsConfig(form, extraConfig),
    [form, extraConfig]
  )
  // JSON 编辑器内容：用户手改过用用户的，否则跟随表单实时生成
  const jsonShown = jsonDirty ? jsonText : JSON.stringify(effectiveSettingsConfig, null, 2)

  const applyPreset = (index: number) => {
    const draft = presetToProfileDraft(PROVIDER_PRESETS[index], draftId)
    setExtraConfig(draft.settingsConfig)
    setForm((prev) => ({
      ...formFromProfile(draft),
      // 用户已填的 Key 不被预设冲掉
      apiKey: prev.apiKey || formFromProfile(draft).apiKey,
    }))
    setJsonDirty(false)
  }

  const applyPaste = () => {
    const parsed = parsePastedProviderConfig(pasteText)
    if (!parsed) {
      toast.error(t('settings.providers.pasteInvalid'))
      return
    }
    const draft: ProviderProfile = {
      id: draftId,
      name: parsed.name ?? '',
      websiteUrl: parsed.websiteUrl,
      settingsConfig: parsed.settingsConfig,
      meta: { apiFormat: parsed.apiFormat },
      createdAt: Date.now(),
    }
    setExtraConfig(draft.settingsConfig)
    setForm((prev) => ({ ...formFromProfile(draft), apiKey: prev.apiKey || formFromProfile(draft).apiKey }))
    setPasteText('')
    setJsonDirty(false)
    toast.success(t('settings.providers.pasteOk'))
  }

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText) as ProviderProfile['settingsConfig']
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.env) {
        toast.error(t('settings.providers.jsonInvalid'))
        return
      }
      setExtraConfig(parsed)
      setForm((prev) => {
        const env = parsed.env ?? {}
        const anthropic = form.apiFormat === 'anthropic'
        return {
          ...prev,
          baseUrl: (anthropic ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL) ?? prev.baseUrl,
          apiKey: (anthropic ? (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) : env.OPENAI_API_KEY) ?? prev.apiKey,
          model: (anthropic ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL) ?? prev.model,
        }
      })
      setJsonDirty(false)
    } catch {
      toast.error(t('settings.providers.jsonInvalid'))
    }
  }

  const fetchModels = async () => {
    if (!form.baseUrl.trim()) {
      toast.error(t('settings.providers.needBaseUrl'))
      return
    }
    setFetchingModels(true)
    try {
      const r = await providerProbeApi.models({
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        apiFormat: form.apiFormat,
        modelsUrl: form.modelsUrl.trim() || undefined,
      })
      if (r.success && r.models?.length) {
        setFetchedModels(r.models)
        toast.success(t('settings.providers.modelsFetched', { count: r.models.length }))
      } else {
        toast.error(r.error ?? t('settings.providers.modelsFetchFailed'))
      }
    } catch (err) {
      toast.error(String(err))
    } finally {
      setFetchingModels(false)
    }
  }

  const save = async () => {
    const finalConfig = jsonDirty
      ? (() => {
          try {
            const parsed = JSON.parse(jsonText) as ProviderProfile['settingsConfig']
            return parsed?.env ? parsed : null
          } catch {
            return null
          }
        })()
      : effectiveSettingsConfig
    if (!finalConfig) {
      toast.error(t('settings.providers.jsonInvalid'))
      return
    }
    if (!form.name.trim()) {
      toast.error(t('settings.providers.needName'))
      return
    }
    setSaving(true)
    try {
      const profile: ProviderProfile = {
        id: draftId,
        name: form.name.trim(),
        category: existing?.category ?? 'custom',
        websiteUrl: form.websiteUrl.trim() || undefined,
        notes: form.notes.trim() || undefined,
        settingsConfig: finalConfig,
        meta: { apiFormat: form.apiFormat, modelsUrl: form.modelsUrl.trim() || undefined },
        createdAt: existing?.createdAt ?? Date.now(),
      }
      await useProviderProfileStore.getState().upsert(profile)
      // effort 已实时写入注册表（onChange 即 setUserEffort），这里无需再写；
      // 上下文窗口是自由文本（中途态非法），保存时才写注册表——空/非法=清除覆盖回自动
      if (form.model.trim()) {
        setUserWindowOverride(providerId, form.model.trim(), parseWindowInput(form.contextWindow))
      }
      toast.success(t('settings.providers.saved'))
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const effortSelectable = form.model.trim() && modelSupportsEffort(providerId, form.model.trim())

  return (
    // wf-set-gcard 本身无内边距（行容器，列表行的 padding 在行上）；
    // 自由表单内容须自带 p-5——与 StandaloneModelSection 同款约定
    <div className="wf-set-gcard p-5">
      <div className="flex items-center gap-2 mb-5">
        <button className="wf-press p-1.5 rounded-md text-[var(--wf-mut)] hover:bg-[var(--wf-hover)]" onClick={onClose}>
          <ChevronLeft size={16} />
        </button>
        <span className="text-sm font-semibold text-[var(--wf-ink)]">
          {existing ? t('settings.providers.editTitle', { name: existing.name }) : t('settings.providers.addTitle')}
        </span>
      </div>

      {/* 预设网格（仅新增且未填任何内容时显示）。段标=wf-sec-label（能力页语言） */}
      {showPresetGrid && (
        <div>
          <div className="wf-sec-label">{t('settings.providers.presetHint')}</div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
            {PROVIDER_PRESETS.map((preset, i) => (
              <button
                key={preset.name}
                className="wf-press text-left p-3 rounded-[10px] border border-[var(--wf-line)] hover:border-[var(--wf-faint)] transition-colors"
                onClick={() => applyPreset(i)}
              >
                <div className="text-[13px] font-medium truncate">{preset.name}</div>
                <div className="text-[11px] font-mono text-[var(--wf-faint)] mt-0.5">
                  {preset.apiFormat === 'anthropic' ? 'Anthropic' : 'OpenAI'}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 粘贴导入：cc-switch 配置整段粘进来自动填表 */}
      <div className="mt-6">
        <div className="wf-sec-label">{t('settings.providers.pasteLabel')}</div>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder='{"settingsConfig":{"env":{"ANTHROPIC_BASE_URL":"…","ANTHROPIC_AUTH_TOKEN":"…","ANTHROPIC_MODEL":"…"}}}'
          rows={3}
          className="wf-ink-input w-full font-mono text-xs"
        />
        {pasteText.trim() && (
          <button
            className="wf-mini-btn wf-press mt-2"
            onClick={applyPaste}
          >
            {t('settings.providers.pasteApply')}
          </button>
        )}
      </div>

      {/* 信息段 */}
      <div className="mt-6">
        <div className="wf-sec-label">{t('settings.providers.sectionInfo')}</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-4">
          <label className="block">
            <div className="flex items-center gap-1 mb-1.5 text-xs text-[var(--wf-mut)]"><Bot size={12} />{t('settings.providers.fieldName')}</div>
            <input type="text" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="wf-ink-input w-full" placeholder="Kimi For Coding" />
          </label>
          <label className="block">
            <div className="flex items-center gap-1 mb-1.5 text-xs text-[var(--wf-mut)]"><Globe size={12} />{t('settings.providers.fieldWebsite')}</div>
            <input type="text" value={form.websiteUrl} onChange={(e) => setForm((p) => ({ ...p, websiteUrl: e.target.value }))} className="wf-ink-input w-full" placeholder="https://…" />
          </label>
          <label className="block md:col-span-2">
            <div className="flex items-center gap-1 mb-1.5 text-xs text-[var(--wf-mut)]"><NotebookText size={12} />{t('settings.providers.fieldNotes')}</div>
            <input type="text" value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} className="wf-ink-input w-full" />
          </label>
        </div>
      </div>

      {/* 连接段 */}
      <div className="mt-6">
        <div className="wf-sec-label">{t('settings.providers.sectionConnection')}</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-4">
        {/* 协议格式：显式可选——此前只能靠预设/粘贴隐式确定，手填无从选择也看不到当前值 */}
        <div className="block md:col-span-2">
          <div className="flex items-center gap-1 mb-1.5 text-xs text-[var(--wf-mut)]"><Sparkles size={12} />{t('settings.providers.fieldFormat')}</div>
          <div className="flex gap-1 max-w-xs">
            {(['anthropic', 'openai'] as const).map((fmt) => (
              <button
                key={fmt}
                type="button"
                onClick={() => switchFormat(fmt)}
                className={cn(
                  'flex-1 px-1.5 py-1.5 text-xs rounded-md transition-colors',
                  form.apiFormat === fmt
                    ? 'bg-primary-50 text-primary-700 font-medium'
                    : 'text-[var(--wf-mut)] hover:bg-[var(--wf-hover)]'
                )}
              >
                {fmt === 'anthropic' ? 'Anthropic' : 'OpenAI'}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-[var(--wf-faint)] mt-1">{t('settings.providers.formatHint')}</p>
        </div>
        <label className="block">
          <div className="flex items-center gap-1 mb-1.5 text-xs text-[var(--wf-mut)]"><Link size={12} />{t('settings.providers.fieldBaseUrl')}</div>
          <input type="text" value={form.baseUrl} onChange={(e) => setForm((p) => ({ ...p, baseUrl: e.target.value }))} className="wf-ink-input w-full" placeholder="https://api.example.com/v1" />
        </label>
        <label className="block">
          <div className="flex items-center gap-1 mb-1.5 text-xs text-[var(--wf-mut)]"><Key size={12} />{t('settings.providers.fieldApiKey')}</div>
          <input type="password" value={form.apiKey} onChange={(e) => setForm((p) => ({ ...p, apiKey: e.target.value }))} className="wf-ink-input w-full" autoComplete="new-password" />
        </label>
        <label className="block md:col-span-2">
          <div className="flex items-center gap-1 mb-1.5 text-xs text-[var(--wf-mut)]"><Cpu size={12} />{t('settings.providers.fieldModel')}</div>
          <div className="flex gap-2">
            <div className="relative flex-1" ref={modelWrapRef}>
              <input
                type="text"
                value={form.model}
                onChange={(e) => {
                  setForm((p) => ({ ...p, model: e.target.value }))
                  setModelShowAll(false)
                  setModelOpen(true)
                }}
                onFocus={() => {
                  if (fetchedModels.length > 0) {
                    setModelShowAll(true)
                    setModelOpen(true)
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Escape') setModelOpen(false) }}
                className="wf-ink-input w-full"
                placeholder={t('settings.providers.modelPlaceholder')}
              />
              {fetchedModels.length > 0 && (
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--wf-faint)] hover:text-[var(--wf-sub)]"
                  onClick={() => {
                    if (modelOpen) { setModelOpen(false); return }
                    setModelShowAll(true)
                    setModelOpen(true)
                  }}
                  tabIndex={-1}
                  aria-label={t('settings.providers.fieldModel')}
                >
                  <ChevronDown size={14} />
                </button>
              )}
              {modelOpen && fetchedModels.length > 0 && (
                <div className="absolute z-50 left-0 right-0 top-full mt-1 max-h-48 overflow-auto rounded-xl border border-[var(--wf-line)] bg-[var(--wf-card-bg)] shadow-lg py-1">
                  {(modelShowAll
                    ? fetchedModels
                    : fetchedModels.filter((m) => m.toLowerCase().includes(form.model.toLowerCase()))
                  ).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={cn(
                        'block w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-[var(--wf-hover)]',
                        m === form.model && 'text-[var(--wf-accent)]'
                      )}
                      onClick={() => {
                        setForm((p) => ({ ...p, model: m }))
                        setModelOpen(false)
                      }}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className="wf-mini-btn wf-press flex items-center gap-1 whitespace-nowrap"
              onClick={() => void fetchModels()}
              disabled={fetchingModels}
            >
              <Download size={12} className={cn(fetchingModels && 'animate-bounce')} />
              {t('settings.providers.fetchModels')}
            </button>
          </div>
          <p className="text-[11px] text-[var(--wf-faint)] mt-1">{t('settings.providers.modelHint')}</p>
        </label>

        <label className="block">
          <div className="flex items-center gap-1 mb-1.5 text-xs text-[var(--wf-mut)]"><Ruler size={12} />{t('settings.settingsView.contextWindow')}</div>
          <input
            type="text"
            value={form.contextWindow}
            onChange={(e) => setForm((p) => ({ ...p, contextWindow: e.target.value }))}
            className="wf-ink-input w-full"
            placeholder="256K"
          />
          <p className="text-[11px] text-[var(--wf-faint)] mt-1">{t('settings.settingsView.contextWindowHint')}</p>
        </label>

        {!!effortSelectable && (
          <label className="block">
            <div className="flex items-center gap-1 mb-1.5 text-xs text-[var(--wf-mut)]"><Sparkles size={12} />{t('settings.providers.fieldEffort')}</div>
            <div className="flex gap-1">
              {([undefined, ...effortLevelsForModel(form.model.trim())] as const).map((level) => (
                <button
                  key={level ?? 'default'}
                  type="button"
                  onClick={() => {
                    setForm((p) => ({ ...p, effort: level }))
                    setUserEffort(providerId, form.model.trim(), level ?? null)
                  }}
                  className={cn(
                    'flex-1 px-1.5 py-1.5 text-xs rounded-md transition-colors',
                    form.effort === level
                      ? 'bg-primary-50 text-primary-700 font-medium'
                      : 'text-[var(--wf-mut)] hover:bg-[var(--wf-hover)]'
                  )}
                >
                  {level ? t(`chat.chatView.effort.${level}`) : t('chat.chatView.effort.default')}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-[var(--wf-faint)] mt-1">{t('settings.providers.effortHint')}</p>
          </label>
        )}
        </div>
      </div>

      {/* 更多配置：完整 JSON（表单管不到的 env 键与非 env 顶层键都在这里）。
          折叠行自绘（原生 summary 三角隐藏），chevron 随开合旋转 */}
      <details className="group mt-6 border-t border-[var(--wf-hair)] pt-3">
        <summary className="flex items-center gap-1.5 text-xs text-[var(--wf-mut)] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden rounded-md px-1.5 py-1 -mx-1.5 hover:bg-[var(--wf-hover)] hover:text-[var(--wf-sub)] transition-colors">
          <ChevronRight size={13} className="transition-transform group-open:rotate-90" />
          {t('settings.providers.advancedJson')}
          <span className="ml-auto text-[11px] text-[var(--wf-faint)]">
            {t('settings.providers.advancedJsonHint')}
          </span>
        </summary>
        <textarea
          value={jsonShown}
          onChange={(e) => { setJsonText(e.target.value); setJsonDirty(true) }}
          rows={8}
          className="wf-ink-input w-full font-mono text-xs mt-2"
          spellCheck={false}
        />
        {jsonDirty && (
          <div className="flex gap-2 mt-2">
            <button className="wf-cta wf-press" onClick={applyJson}>
              {t('settings.providers.jsonApply')}
            </button>
            <button className="wf-mini-btn wf-press" onClick={() => setJsonDirty(false)}>
              {t('settings.providers.jsonDiscard')}
            </button>
          </div>
        )}
      </details>

      <div className="flex justify-end gap-2 mt-6">
        <button className="wf-mini-btn wf-press" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          className="wf-cta wf-press"
          onClick={() => void save()}
          disabled={saving}
        >
          {t('settings.providers.save')}
        </button>
      </div>
    </div>
  )
}

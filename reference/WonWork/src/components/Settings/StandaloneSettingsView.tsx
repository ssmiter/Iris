import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/utils'
import { useSettingsStore } from '@/stores/settingsStore'
import { PERMISSION_MODE_OPTIONS } from '@/components/Chat/InputArea'
import type { ExecutionMode } from '@/agent/types'
import { StandaloneModelSection } from './StandaloneModelSection'
import { Settings, Globe, ShieldCheck } from 'lucide-react'

interface StandaloneSettingsViewProps {
  headerTitle?: string
  headerSubtitle?: string
  topSections?: ReactNode
  bottomSections?: ReactNode
}

export function StandaloneSettingsView({
  headerTitle,
  headerSubtitle,
  topSections,
  bottomSections,
}: StandaloneSettingsViewProps) {
  const { t } = useTranslation()
  const { language, setLanguage, permissionMode, setPermissionMode } = useSettingsStore()

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-[var(--wf-card-bg)] border-b border-[var(--wf-line)]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--wf-warn-bg)] flex items-center justify-center">
            <Settings size={20} className="text-[var(--wf-warn-ink)]" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[var(--wf-ink)]">{headerTitle || t('settings.standaloneSettings.title')}</h2>
            <p className="text-sm text-[var(--wf-faint)]">
              {headerSubtitle || (
                <>
                  {t('settings.standaloneSettings.currentMode')}
                  <span className="font-medium text-[var(--wf-warn-ink)]">{t('settings.standaloneSettings.standaloneMode')}</span>
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto space-y-6">
          {/* 语言切换 */}
          <div className="bg-[var(--wf-card-bg)] border border-[var(--wf-line)] rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Globe size={16} className="text-[var(--wf-mut)]" />
              <h3 className="text-sm font-semibold text-[var(--wf-sub)]">{t('settings.settingsView.language')}</h3>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setLanguage('zh-CN')}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-colors border',
                  language === 'zh-CN'
                    ? 'border-primary-400 bg-primary-50 text-primary-700'
                    : 'border-[var(--wf-line)] text-[var(--wf-sub)] hover:border-primary-300'
                )}
              >
                {t('settings.settingsView.chinese')}
              </button>
              <button
                onClick={() => setLanguage('en-US')}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium transition-colors border',
                  language === 'en-US'
                    ? 'border-primary-400 bg-primary-50 text-primary-700'
                    : 'border-[var(--wf-line)] text-[var(--wf-sub)] hover:border-primary-300'
                )}
              >
                {t('settings.settingsView.english')}
              </button>
            </div>
          </div>

          {/* 权限模式默认值（打磨任务2 S1）：对话栏下拉可会话级覆盖 */}
          <div className="bg-[var(--wf-card-bg)] border border-[var(--wf-line)] rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheck size={16} className="text-[var(--wf-mut)]" />
              <h3 className="text-sm font-semibold text-[var(--wf-sub)]">
                {t('settings.settingsView.permissionModeDefault', { defaultValue: '权限模式默认值' })}
              </h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {PERMISSION_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setPermissionMode(opt.value as ExecutionMode)}
                  className={cn(
                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors border',
                    permissionMode === opt.value
                      ? 'border-primary-400 bg-primary-50 text-primary-700'
                      : 'border-[var(--wf-line)] text-[var(--wf-sub)] hover:border-primary-300'
                  )}
                >
                  {t(opt.labelKey, { defaultValue: opt.fallback })}
                </button>
              ))}
            </div>
            <p className="text-xs text-[var(--wf-faint)] mt-2">
              {t('settings.settingsView.permissionModeHint', {
                defaultValue: '全部自动模式下破坏性操作（删文件/删表）仍会请求确认；对话栏下拉可为单个会话临时覆盖',
              })}
            </p>
          </div>

          {/* 模式说明 */}
          <div className="p-4 bg-[var(--wf-info-bg)] border border-[var(--wf-info-line)] rounded-xl">
            <div className="flex items-start gap-3">
              <Globe size={18} className="text-[var(--wf-info-ink)] flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-sm font-medium text-[var(--wf-info-ink)]">{t('settings.standaloneSettings.modeDescription')}</h3>
                <p className="text-sm text-[var(--wf-info-ink)] mt-1">
                  {t('settings.standaloneSettings.modeExplanation')}
                </p>
              </div>
            </div>
          </div>

          {/* 顶部商业化模块 */}
          {topSections}

          {/* 模型与 API 配置（已抽取为独立自含组件） */}
          <StandaloneModelSection />

          {/* 底部附加模块 */}
          {bottomSections}
        </div>
      </div>
    </div>
  )
}

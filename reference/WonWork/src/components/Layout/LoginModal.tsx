import { useState, useCallback, useEffect } from 'react'
import { cn } from '@/utils'
import { useAuthStore } from '@/stores/authStore'
import { useRuntimeConfigStore } from '@/stores/runtimeConfigStore'
import { useTranslation } from 'react-i18next'
import {
  X,
  LogIn,
  LogOut,
  User,
  Building2,
  Shield,
  Loader2,
  AlertCircle,
  CheckCircle2,
  UserPlus,
  Mail,
  KeyRound,
} from 'lucide-react'
import { isOnline } from '@/config/product'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

interface LoginModalProps {
  isOpen: boolean
  onClose: () => void
}

export function LoginModal({ isOpen, onClose }: LoginModalProps) {
  const { t } = useTranslation()
  const { config: runtimeConfig } = useRuntimeConfigStore()
  const isWebsiteMode = runtimeConfig.requireLogin && runtimeConfig.provider === 'website'
  // 2026-07-24 公网 v1.0 定位：统一构建下 isOnline 恒为 true，所有用户（内网/外网）入口登录
  // 一律走 website 账号（/api/auth/website/*，公网已部署）；MES 工号登录降级为登录后的
  // "登录 MESCLI Online" 二级入口。原 Wongoing cloud 表单（/api/cloud/auth/*）死链已移除。
  const showWebsiteForm = isWebsiteMode || isOnline
  // 2026-07-24：cloudLogin/cloudRegister（/api/cloud/auth/*）是死链——本地 daemon 与公网服务器均未实现该契约，
  // 本弹窗不再提供"Wongoing 账号"表单。在线身份只剩两条通的路：
  //   external（isWebsiteMode）→ websiteLogin（/api/auth/website/*，公网 v1.0 已部署）
  //   其余（内网/mescli）→ login（/api/auth/login，MES 工号）
  // isCloudLoggedIn/cloudAccount 仅为兼容历史 persisted 会话的展示而保留。
  const { user, isLoggedIn, isMesLoggedIn, isCloudLoggedIn, isWebsiteLoggedIn, websiteAccount, cloudAccount, isLoading, error, login, logout, clearError, websiteLogin, websiteRegister, websiteSendCode } = useAuthStore()
  // 强制登录态（与 App.tsx requireLoginModal 同条件）：未登录且构建/运行时要求登录时禁止关闭；
  // 已登录后从左下角打开的账号面板必须可关闭。统一构建下 isOnline 恒为 true，
  // 直接用 isOnline 判断会导致安装版任何时候都没有关闭按钮。
  const forcedLogin = !isLoggedIn && (isOnline || (isWebsiteMode && !isWebsiteLoggedIn))
  const [workBarcode, setWorkBarcode] = useState('')
  const [password, setPassword] = useState('')
  const [systemCode, setSystemCode] = useState(() => {
    return localStorage.getItem('wonclaw_last_system_code') || ''
  })
  const [showLoginForm, setShowLoginForm] = useState(false)
  const [showMesLoginForm, setShowMesLoginForm] = useState(false)

  // Online 死链表单已移除（见上方注释），仅保留 website / MES 工号两条路径的表单状态
  const [websiteEmail, setWebsiteEmail] = useState('')
  const [websitePassword, setWebsitePassword] = useState('')
  const [websiteCode, setWebsiteCode] = useState('')
  const [websiteConfirmPassword, setWebsiteConfirmPassword] = useState('')
  const [websiteRegisterMode, setWebsiteRegisterMode] = useState(false)
  const [codeSending, setCodeSending] = useState(false)
  const [codeCountdown, setCodeCountdown] = useState(0)
  const [websiteError, setWebsiteError] = useState<string | null>(null)

  // 打开时清空错误与登录表单状态
  useEffect(() => {
    if (isOpen) {
      clearError()
      setShowLoginForm(false)
      setShowMesLoginForm(false)
      setWorkBarcode('')
      setPassword('')
      setWebsiteEmail('')
      setWebsitePassword('')
      setWebsiteCode('')
      setWebsiteConfirmPassword('')
      setWebsiteRegisterMode(false)
      setCodeCountdown(0)
      setWebsiteError(null)
    }
  }, [isOpen, clearError])

  // 验证码倒计时
  useEffect(() => {
    if (codeCountdown <= 0) return
    const timer = setTimeout(() => setCodeCountdown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [codeCountdown])

  // ESC 关闭（Online / Website 强制登录时不可关闭；Website 已登录后点击左下角打开的允许关闭）
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !forcedLogin) onClose()
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [isOpen, onClose, forcedLogin])

  const handleLogin = useCallback(async () => {
    if (!workBarcode.trim() || !password.trim() || !systemCode.trim()) return
    const success = await login(workBarcode.trim(), password.trim(), systemCode.trim())
    if (success) {
      localStorage.setItem('wonclaw_last_system_code', systemCode.trim())
      setWorkBarcode('')
      setPassword('')
      setShowLoginForm(false)
      onClose()
    }
  }, [workBarcode, password, systemCode, login, onClose])

  const handleWebsiteLogin = useCallback(async () => {
    if (!websiteEmail.trim() || !websitePassword.trim()) return
    const success = await websiteLogin(websiteEmail.trim(), websitePassword.trim())
    if (success) {
      setWebsiteEmail('')
      setWebsitePassword('')
      setWebsiteCode('')
      setWebsiteConfirmPassword('')
      setWebsiteRegisterMode(false)
      onClose()
    }
  }, [websiteEmail, websitePassword, websiteLogin, onClose])

  const handleWebsiteRegister = useCallback(async () => {
    if (!websiteEmail.trim() || !websiteCode.trim() || !websitePassword.trim()) return
    if (websitePassword !== websiteConfirmPassword) {
      setWebsiteError(t('layout.loginModal.passwordMismatch'))
      return
    }
    setWebsiteError(null)
    const success = await websiteRegister(websiteEmail.trim(), websitePassword.trim(), websiteCode.trim())
    if (success) {
      setWebsiteEmail('')
      setWebsitePassword('')
      setWebsiteCode('')
      setWebsiteConfirmPassword('')
      setWebsiteRegisterMode(false)
      onClose()
    }
  }, [websiteEmail, websiteCode, websitePassword, websiteConfirmPassword, websiteRegister, onClose, t])

  const handleWebsiteSendCode = useCallback(async () => {
    if (!websiteEmail.trim() || codeSending || codeCountdown > 0) return
    setCodeSending(true)
    const result = await websiteSendCode(websiteEmail.trim(), websiteRegisterMode ? 'register' : 'register')
    setCodeSending(false)
    if (result.ok) {
      setCodeCountdown(60)
    }
  }, [websiteEmail, codeSending, codeCountdown, websiteRegisterMode, websiteSendCode])

  const handleLogout = useCallback(async () => {
    await logout()
    onClose()
  }, [logout, onClose])

  // MES 登录表单（公网版 website 登录后，用户可再登 MES 切换 online）
  const mesLoginForm = (
    <div className="space-y-4">
      <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-start gap-2">
        <AlertCircle size={16} className="text-blue-500 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-blue-700">{t('layout.loginModal.mesLoginHint')}</p>
      </div>
      <div>
        <label className="block text-sm text-surface-600 mb-1">{t('layout.loginModal.workBarcode')}</label>
        <input
          type="text"
          value={workBarcode}
          onChange={(e) => setWorkBarcode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          placeholder={t('layout.loginModal.enterWorkBarcode')}
          className="w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
        />
      </div>

      <div>
        <label className="block text-sm text-surface-600 mb-1">{t('layout.loginModal.password')}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          placeholder={t('layout.loginModal.enterPassword')}
          className="w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
        />
      </div>

      <div>
        <label className="block text-sm text-surface-600 mb-1">{t('layout.loginModal.systemCodeLabel')}</label>
        <input
          type="text"
          value={systemCode}
          onChange={(e) => setSystemCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          placeholder={t('layout.loginModal.systemCodePlaceholder')}
          className="w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
        />
        {!systemCode.trim() && (
          <p className="text-xs text-red-500 mt-1">{t('layout.loginModal.systemCodeRequired')}</p>
        )}
      </div>

      <button
        onClick={handleLogin}
        disabled={isLoading || !workBarcode.trim() || !password.trim() || !systemCode.trim()}
        className={cn(
          'w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
          isLoading || !workBarcode.trim() || !password.trim() || !systemCode.trim()
            ? 'bg-surface-200 text-surface-400 cursor-not-allowed'
            : 'bg-primary-500 text-white hover:bg-primary-600'
        )}
      >
        {isLoading ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <LogIn size={16} />
        )}
        {isLoading ? t('layout.loginModal.loggingIn') : t('layout.loginModal.login')}
      </button>

      <button
        type="button"
        onClick={() => { setShowMesLoginForm(false); setShowLoginForm(false); }}
        className="w-full text-center text-sm text-primary-600 hover:text-primary-700 transition-colors"
      >
        {t('layout.loginModal.backToAccount')}
      </button>
    </div>
  )

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={forcedLogin ? undefined : onClose}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-surface-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield size={20} className="text-primary-500" />
            <h2 className="text-base font-semibold text-surface-800">
              {showMesLoginForm
                ? t('layout.loginModal.mesLoginTitle')
                : showWebsiteForm
                  ? (isWebsiteLoggedIn || isCloudLoggedIn ? t('layout.loginModal.websiteAccount') : t('layout.loginModal.websiteLogin'))
                  : IS_STANDALONE
                      ? t('layout.loginModal.localMode')
                      : isMesLoggedIn
                        ? t('layout.loginModal.onlineMode')
                        : isLoggedIn
                          ? t('layout.loginModal.localMode')
                          : t('layout.loginModal.loginMescli')}
            </h2>
          </div>
          {!forcedLogin && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-surface-100 text-surface-400 transition-colors"
            >
              <X size={18} />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {(isWebsiteMode && isWebsiteLoggedIn && showMesLoginForm) || (showLoginForm && !isMesLoggedIn) ? (
            /* website 登录后的 MES 登录表单 */
            mesLoginForm
          ) : isLoggedIn && user && !showLoginForm && !websiteRegisterMode ? (
            /* 已登录状态（MES 在线 / Wongoing 在线 / Website / 本地模式） */
            <div className="space-y-4">
              <div className="flex items-center gap-4 p-4 bg-primary-50 border border-primary-100 rounded-xl">
                <div className="w-12 h-12 rounded-full bg-primary-500 flex items-center justify-center flex-shrink-0">
                  <User size={24} className="text-white" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-surface-800">{user.realName}</p>
                  <p className="text-xs text-surface-500">{user.userName}</p>
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'text-[10px] px-2 py-0.5 rounded-full font-medium',
                    isWebsiteMode || isWebsiteLoggedIn
                      ? 'bg-orange-100 text-orange-700'
                      : isCloudLoggedIn
                        ? 'bg-purple-100 text-purple-700'
                        : isMesLoggedIn
                          ? 'bg-green-100 text-green-700'
                          : 'bg-blue-100 text-blue-700'
                  )}>
                    {isWebsiteMode || isWebsiteLoggedIn
                      ? (isMesLoggedIn ? t('layout.sidebar.websiteOnlineMode') : t('layout.sidebar.websiteLocalMode'))
                      : isCloudLoggedIn
                        ? 'Wongoing 在线'
                        : isMesLoggedIn
                          ? t('layout.sidebar.onlineMode')
                          : t('layout.sidebar.localMode')}
                  </span>
                </div>
                {(isWebsiteMode || isWebsiteLoggedIn) && websiteAccount && (
                  <>
                    {websiteAccount.email && (
                      <div className="flex items-center gap-2 text-surface-600">
                        <Mail size={14} />
                        <span>{websiteAccount.email}</span>
                      </div>
                    )}
                    {websiteAccount.phone && (
                      <div className="flex items-center gap-2 text-surface-600">
                        <Building2 size={14} />
                        <span>{websiteAccount.phone}</span>
                      </div>
                    )}
                    {websiteAccount.plan && (
                      <div className="text-surface-500 text-xs">
                        {t('layout.loginModal.plan')}: {websiteAccount.plan}
                      </div>
                    )}
                  </>
                )}
                {isCloudLoggedIn && cloudAccount?.email && (
                  <div className="flex items-center gap-2 text-surface-600">
                    <Building2 size={14} />
                    <span>{cloudAccount.email}</span>
                  </div>
                )}
                {isMesLoggedIn && (
                  <>
                    <div className="flex items-center gap-2 text-surface-600">
                      <Building2 size={14} />
                      <span>{t('layout.loginModal.systemCode')}: {user.systemCode}</span>
                    </div>
                    {user.factoryId && (
                      <div className="text-surface-500 text-xs">
                        {t('layout.loginModal.factoryId')}: {user.factoryId} · {t('layout.loginModal.deptId')}: {user.deptId}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* 除 Standalone 外，任何已登录身份（mescli-local / website-online）都可以再登录 MES，
                  进入 mescli-online 解锁企业级业务功能与数据库。external 构建下 website 账号登录后尤其需要此入口。 */}
              {!IS_STANDALONE && !isMesLoggedIn && (
                <button
                  onClick={() => setShowLoginForm(true)}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-700 transition-colors"
                >
                  <LogIn size={16} />
                  {t('layout.loginModal.mesLoginTitle')}
                </button>
              )}

              {(IS_STANDALONE || isMesLoggedIn || isCloudLoggedIn || isWebsiteMode || isWebsiteLoggedIn) && (
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-red-50 text-red-600 hover:bg-red-100 transition-colors border border-red-200"
                >
                  <LogOut size={16} />
                  {t('layout.loginModal.logout')}
                </button>
              )}
            </div>
          ) : (
            /* 未登录状态 */
            <div className="space-y-4">
              {showWebsiteForm ? (
                <div className="p-3 bg-orange-50 border border-orange-200 rounded-lg flex items-start gap-2">
                  <AlertCircle size={16} className="text-orange-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-orange-700">
                    {websiteRegisterMode ? t('layout.loginModal.websiteRegisterHint') : t('layout.loginModal.websiteLoginHint')}
                  </p>
                </div>
              ) : IS_STANDALONE ? (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
                  <AlertCircle size={16} className="text-amber-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-amber-700">{t('layout.loginModal.standaloneHint')}</p>
                </div>
              ) : (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-start gap-2">
                  <AlertCircle size={16} className="text-blue-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-blue-700">{t('layout.loginModal.localModeHint')}</p>
                </div>
              )}
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                  <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              )}
              {websiteError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                  <AlertCircle size={16} className="text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-700">{websiteError}</p>
                </div>
              )}

              {showWebsiteForm ? (
                <>
                  <div>
                    <label className="block text-sm text-surface-600 mb-1">{t('layout.loginModal.email')}</label>
                    <input
                      type="email"
                      value={websiteEmail}
                      onChange={(e) => setWebsiteEmail(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (websiteRegisterMode ? handleWebsiteRegister() : handleWebsiteLogin())}
                      placeholder={t('layout.loginModal.emailPlaceholder')}
                      className="w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-surface-600 mb-1">{t('layout.loginModal.password')}</label>
                    <input
                      type="password"
                      value={websitePassword}
                      onChange={(e) => setWebsitePassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (websiteRegisterMode ? handleWebsiteRegister() : handleWebsiteLogin())}
                      placeholder={t('layout.loginModal.enterPassword')}
                      className="w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
                    />
                  </div>

                  {websiteRegisterMode && (
                    <div>
                      <label className="block text-sm text-surface-600 mb-1">{t('layout.loginModal.passwordConfirm')}</label>
                      <input
                        type="password"
                        value={websiteConfirmPassword}
                        onChange={(e) => setWebsiteConfirmPassword(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleWebsiteRegister()}
                        placeholder={t('layout.loginModal.passwordConfirmPlaceholder')}
                        className="w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
                      />
                    </div>
                  )}

                  {websiteRegisterMode && (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={websiteCode}
                        onChange={(e) => setWebsiteCode(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleWebsiteRegister()}
                        placeholder={t('layout.loginModal.verifyCode')}
                        className="flex-1 px-3 py-2.5 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
                      />
                      <button
                        type="button"
                        onClick={handleWebsiteSendCode}
                        disabled={!websiteEmail.trim() || codeSending || codeCountdown > 0}
                        className={cn(
                          'px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap',
                          !websiteEmail.trim() || codeSending || codeCountdown > 0
                            ? 'bg-surface-200 text-surface-400 cursor-not-allowed'
                            : 'bg-primary-500 text-white hover:bg-primary-600'
                        )}
                      >
                        {codeSending
                          ? t('layout.loginModal.sendingCode')
                          : codeCountdown > 0
                            ? t('layout.loginModal.resendCode', { seconds: codeCountdown })
                            : t('layout.loginModal.sendCode')}
                      </button>
                    </div>
                  )}

                  <button
                    onClick={websiteRegisterMode ? handleWebsiteRegister : handleWebsiteLogin}
                    disabled={isLoading || !websiteEmail.trim() || !websitePassword.trim() || (websiteRegisterMode && !websiteCode.trim())}
                    className={cn(
                      'w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
                      isLoading || !websiteEmail.trim() || !websitePassword.trim() || (websiteRegisterMode && !websiteCode.trim())
                        ? 'bg-surface-200 text-surface-400 cursor-not-allowed'
                        : 'bg-primary-500 text-white hover:bg-primary-600'
                    )}
                  >
                    {isLoading ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : websiteRegisterMode ? (
                      <UserPlus size={16} />
                    ) : (
                      <LogIn size={16} />
                    )}
                    {isLoading
                      ? t('layout.loginModal.loggingIn')
                      : websiteRegisterMode
                        ? t('layout.loginModal.register')
                        : t('layout.loginModal.login')}
                  </button>

                  <button
                    type="button"
                    onClick={() => setWebsiteRegisterMode(!websiteRegisterMode)}
                    className="w-full text-center text-sm text-primary-600 hover:text-primary-700 transition-colors"
                  >
                    {websiteRegisterMode
                      ? t('layout.loginModal.hasAccount')
                      : t('layout.loginModal.noAccount')}
                  </button>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-sm text-surface-600 mb-1">{IS_STANDALONE ? t('layout.loginModal.username') : t('layout.loginModal.workBarcode')}</label>
                    <input
                      type="text"
                      value={workBarcode}
                      onChange={(e) => setWorkBarcode(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                      placeholder={t('layout.loginModal.enterWorkBarcode')}
                      className="w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-surface-600 mb-1">{t('layout.loginModal.password')}</label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                      placeholder={t('layout.loginModal.enterPassword')}
                      className="w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-surface-600 mb-1">{t('layout.loginModal.systemCodeLabel')}</label>
                    <input
                      type="text"
                      value={systemCode}
                      onChange={(e) => setSystemCode(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                      placeholder={t('layout.loginModal.systemCodePlaceholder')}
                      className="w-full px-3 py-2.5 border border-surface-200 rounded-lg text-sm focus:outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-400"
                    />
                    {!systemCode.trim() && (
                      <p className="text-xs text-red-500 mt-1">{t('layout.loginModal.systemCodeRequired')}</p>
                    )}
                  </div>

                  <button
                    onClick={handleLogin}
                    disabled={isLoading || !workBarcode.trim() || !password.trim() || !systemCode.trim()}
                    className={cn(
                      'w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
                      isLoading || !workBarcode.trim() || !password.trim() || !systemCode.trim()
                        ? 'bg-surface-200 text-surface-400 cursor-not-allowed'
                        : 'bg-primary-500 text-white hover:bg-primary-600'
                    )}
                  >
                    {isLoading ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <LogIn size={16} />
                    )}
                    {isLoading ? t('layout.loginModal.loggingIn') : t('layout.loginModal.login')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

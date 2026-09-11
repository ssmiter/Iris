import { useState, useCallback, useEffect, useRef } from 'react'
import { cn } from '@/utils'
import { useAuthStore } from '@/stores/authStore'
import { useRuntimeConfigStore } from '@/stores/runtimeConfigStore'
import { useUpdateStore } from '@/stores/updateStore'
import { useTranslation } from 'react-i18next'
import {
  X,
  LogIn,
  LogOut,
  Building2,
  Loader2,
  AlertCircle,
  UserPlus,
  Mail,
} from 'lucide-react'
import { isOnline, productDisplayName } from '@/config/product'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

interface LoginModalProps {
  isOpen: boolean
  onClose: () => void
  initialView?: 'mes'
}

/* 六格验证码（蓝图签名件；注册邮件验证码=6 位数字，正好对得上）：
   内部持 6 槽位，向父级上报紧凑字符串（父级提交/禁用判断逻辑不变）；
   逐格输入自动前进、空格调退格回退清前一格、任意格可整段粘贴。
   弹窗关闭整树卸载，槽位自然重置；focusSignal 变化时聚焦第一格（发码成功后引导输入）。 */
function CodeCells({ onChange, onEnter, focusSignal }: {
  onChange: (v: string) => void
  onEnter?: () => void
  focusSignal: number
}) {
  const [cells, setCells] = useState<string[]>(() => Array(6).fill(''))
  const refs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (focusSignal > 0) refs.current[0]?.focus()
  }, [focusSignal])

  const commit = (next: string[]) => {
    setCells(next)
    onChange(next.join(''))
  }

  const fillFrom = (i: number, raw: string) => {
    const digits = raw.replace(/\D/g, '')
    if (!digits) {
      if (!cells[i]) return
      const next = [...cells]
      next[i] = ''
      commit(next)
      return
    }
    const next = [...cells]
    for (let j = 0; j < digits.length && i + j < 6; j++) next[i + j] = digits[j]
    commit(next)
    refs.current[Math.min(i + digits.length, 5)]?.focus()
  }

  return (
    <div className="wf-login-code">
      {cells.map((c, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el }}
          type="text"
          inputMode="numeric"
          maxLength={6}
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          value={c}
          onChange={(e) => fillFrom(i, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !cells[i] && i > 0) {
              const next = [...cells]
              next[i - 1] = ''
              commit(next)
              refs.current[i - 1]?.focus()
              e.preventDefault()
            } else if (e.key === 'Enter' && onEnter) {
              onEnter()
            }
          }}
          onPaste={(e) => {
            e.preventDefault()
            fillFrom(i, e.clipboardData.getData('text'))
          }}
        />
      ))}
    </div>
  )
}

export function LoginModal({ isOpen, onClose, initialView }: LoginModalProps) {
  const { t } = useTranslation()
  const { config: runtimeConfig } = useRuntimeConfigStore()
  const isWebsiteMode = runtimeConfig.requireLogin && runtimeConfig.provider === 'website'
  // Online 构建统一先登录官网账号；MES 工号登录是登录后的二级入口。
  const showWebsiteForm = isWebsiteMode || isOnline
  // 2026-07-24：cloudLogin/cloudRegister（/api/cloud/auth/*）是死链——本地 daemon 与公网服务器均未实现该契约，
  // 本弹窗不再提供"Wongoing 账号"表单。在线身份只剩两条通的路：
  //   external（isWebsiteMode）→ websiteLogin（/api/auth/website/*，公网 v1.0 已部署）
  //   其余（内网/mescli）→ login（/api/auth/login，MES 工号）
  // isCloudLoggedIn/cloudAccount 仅为兼容历史 persisted 会话的展示而保留。
  const { user, isLoggedIn, isMesLoggedIn, isCloudLoggedIn, isWebsiteLoggedIn, websiteAccount, cloudAccount, isLoading, error, login, logout, clearError, websiteLogin, websiteRegister, websiteSendCode } = useAuthStore()
  // Online 构建或 website 运行时要求登录时禁止关闭。
  const forcedLogin = !isLoggedIn && (isOnline || (isWebsiteMode && !isWebsiteLoggedIn))
  const appVersion = useUpdateStore((s) => s.currentVersion)
  const [workBarcode, setWorkBarcode] = useState('')
  const [password, setPassword] = useState('')
  const [systemCode, setSystemCode] = useState(() => {
    return localStorage.getItem('wonclaw_last_system_code') || ''
  })
  const [showLoginForm, setShowLoginForm] = useState(false)
  // 未登录主卡上的 MES 特有入口（2026-08-11 蓝图重做：卡片底部安静二级链接 → MES 面板）
  const [showMesEntry, setShowMesEntry] = useState(false)

  // 2026-08-10 用户拍板：登录表单的系统代码=纯手填输入框（r300 原样），
  // 不用目录下拉、不自动填充；r301 引入的 mescliPackageStore 目录联动已整体撤出本文件。

  // Online 死链表单已移除（见上方注释），仅保留 website / MES 工号两条路径的表单状态
  const [websiteEmail, setWebsiteEmail] = useState('')
  const [websitePassword, setWebsitePassword] = useState('')
  const [websiteCode, setWebsiteCode] = useState('')
  const [websiteConfirmPassword, setWebsiteConfirmPassword] = useState('')
  const [websiteRegisterMode, setWebsiteRegisterMode] = useState(false)
  const [codeSending, setCodeSending] = useState(false)
  const [codeCountdown, setCodeCountdown] = useState(0)
  const [websiteError, setWebsiteError] = useState<string | null>(null)
  const [codeFocusSignal, setCodeFocusSignal] = useState(0)
  // 2026-07-31：401 被踢回登录页后的静态解释（API 层 reload 前在 sessionStorage 留旗标）
  // 2026-08-06 单账号单客户端：守卫踢出时留机器码旗标（wonclaw_session_notice），按码映射文案
  const [sessionNotice, setSessionNotice] = useState<string | null>(null)
  // 提交失败的空间反馈（蓝图 .card.shake；reduced-motion 下 CSS 侧自动瞬切）
  const [shaking, setShaking] = useState(false)
  const lastErrRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    const code = sessionStorage.getItem('wonclaw_session_notice')
    if (code) {
      sessionStorage.removeItem('wonclaw_session_notice')
      const key =
        code === 'session_replaced'
          ? 'layout.loginModal.sessionReplaced'
          : code === 'session_revoked'
            ? 'layout.loginModal.sessionRevoked'
            : code === 'session_expired'
              ? 'layout.loginModal.sessionExpired'
              : 'layout.loginModal.sessionLoggedOut'
      setSessionNotice(t(key))
      return
    }
    if (sessionStorage.getItem('wonclaw_session_expired')) {
      sessionStorage.removeItem('wonclaw_session_expired')
      setSessionNotice(t('layout.loginModal.sessionExpired'))
    }
  }, [isOpen, t])

  // 打开时清空错误与登录表单状态
  useEffect(() => {
    if (isOpen) {
      clearError()
      setShowLoginForm(false)
      setShowMesEntry(false)
      setWorkBarcode('')
      setPassword('')
      setWebsiteEmail('')
      setWebsitePassword('')
      setWebsiteCode('')
      setWebsiteConfirmPassword('')
      setWebsiteRegisterMode(false)
      setCodeCountdown(0)
      setWebsiteError(null)
      if (initialView === 'mes') setShowLoginForm(true)
    }
  }, [isOpen, clearError, initialView])

  // 验证码倒计时
  useEffect(() => {
    if (codeCountdown <= 0) return
    const timer = setTimeout(() => setCodeCountdown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [codeCountdown])

  // 新错误出现 → 卡片抖动一下（蓝图 shake；同一条错误不重复抖）
  useEffect(() => {
    const err = error || websiteError || null
    if (err && err !== lastErrRef.current) {
      setShaking(true)
      const timer = setTimeout(() => setShaking(false), 420)
      lastErrRef.current = err
      return () => clearTimeout(timer)
    }
    lastErrRef.current = err
  }, [error, websiteError])

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
      setCodeFocusSignal((s) => s + 1) // 发码成功→聚焦第一格，引导直接敲码
    }
  }, [websiteEmail, codeSending, codeCountdown, websiteRegisterMode, websiteSendCode])

  const handleLogout = useCallback(async () => {
    await logout()
    onClose()
  }, [logout, onClose])

  // MES 面板=两条路汇一处：未登录主卡的特有入口（showMesEntry）/已登录后的 MES 登录（showLoginForm）
  const inMesPane = showMesEntry || (showLoginForm && !isMesLoggedIn)

  // MES 登录表单（未登录特有入口 / 已登录后再登 MES 共用；品牌区已承担标题，表单内不再设标题）
  const mesLoginForm = (
    <div className="space-y-4">
      <div className="wf-login-hint">
        <AlertCircle size={16} />
        <p>{t('layout.loginModal.mesLoginHint')}</p>
      </div>
      {/* MES 面板也要渲染登录错误（2026-08-20 修）：此前 error 横幅只在主面板分支，
          MES 登录失败（vpn_required/账号密码错误等）零反馈，表现为"点了没反应" */}
      {error && (
        <div className="wf-login-hint error">
          <AlertCircle size={16} />
          <p>{error}</p>
        </div>
      )}
      <div>
        <label className="wf-login-label">{t('layout.loginModal.workBarcode')}</label>
        <input
          type="text"
          value={workBarcode}
          onChange={(e) => setWorkBarcode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          placeholder={t('layout.loginModal.enterWorkBarcode')}
          className="wf-ink-input"
        />
      </div>

      <div>
        <label className="wf-login-label">{t('layout.loginModal.password')}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          placeholder={t('layout.loginModal.enterPassword')}
          className="wf-ink-input"
        />
      </div>

      <div>
        <label className="wf-login-label">{t('layout.loginModal.systemCodeLabel')}</label>
        <input
          type="text"
          value={systemCode}
          onChange={(e) => setSystemCode(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
          placeholder={t('layout.loginModal.systemCodePlaceholder')}
          className="wf-ink-input"
        />
        {!systemCode.trim() && (
          <p className="text-xs text-[var(--wf-err-ink)] mt-1">{t('layout.loginModal.systemCodeRequired')}</p>
        )}
      </div>

      <button
        onClick={handleLogin}
        disabled={isLoading || !workBarcode.trim() || !password.trim() || !systemCode.trim()}
        className="wf-btn-primary wf-press"
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
        onClick={() => { setShowMesEntry(false); setShowLoginForm(false); }}
        className="wf-btn-ghost wf-press"
      >
        {isLoggedIn ? t('layout.loginModal.backToAccount') : t('layout.loginModal.backToLogin')}
      </button>
    </div>
  )

  if (!isOpen) return null

  // 品牌区文案：主路径=欢迎回来；MES 语境=登录 MES；Standalone=欢迎回来+任意账号提示
  const isMesContext = inMesPane || (!showWebsiteForm && !IS_STANDALONE)
  const brandTitle = isMesContext
    ? t('layout.loginModal.mesLoginTitle')
    : t('layout.loginModal.welcomeBack')
  const brandSub = IS_STANDALONE
    ? t('layout.loginModal.standaloneHint')
    : isMesContext
      ? t('layout.loginModal.mesSubtitle')
      : websiteRegisterMode
        ? t('layout.loginModal.registerSubtitle')
        : t('layout.loginModal.loginSubtitle')

  const card = (
    <div className={cn('wf-login-card', shaking && 'wf-shake')}>
      {!forcedLogin && (
        <button
          onClick={onClose}
          className="wf-login-close wf-press"
        >
          <X size={18} />
        </button>
      )}

      {isLoggedIn && user && !showLoginForm && !websiteRegisterMode ? (
        /* 已登录=蓝图欢迎态的居中构图 */
        <div className="wf-login-welcome">
          <div className="wf-login-avatar-lg">{user.realName?.[0] || user.userName?.[0] || '?'}</div>
          <h2 className="wf-login-welcome-name" title={user.realName || user.userName}>{user.realName || user.userName}</h2>
          <span className="wf-login-badge">
            {isWebsiteMode || isWebsiteLoggedIn
              ? (isMesLoggedIn ? t('layout.sidebar.websiteOnlineMode') : t('layout.sidebar.websiteLocalMode'))
              : isCloudLoggedIn
                ? 'Wongoing 在线'
                : isMesLoggedIn
                  ? t('layout.sidebar.onlineMode')
                  : t('layout.sidebar.localMode')}
          </span>

          <div className="wf-login-welcome-meta">
            {(isWebsiteMode || isWebsiteLoggedIn) && websiteAccount && (
              <>
                {websiteAccount.email && (
                  <div className="wf-login-meta">
                    <Mail size={14} />
                    <span>{websiteAccount.email}</span>
                  </div>
                )}
                {websiteAccount.phone && (
                  <div className="wf-login-meta">
                    <Building2 size={14} />
                    <span>{websiteAccount.phone}</span>
                  </div>
                )}
                {websiteAccount.plan && (
                  <div className="wf-login-meta-sub">
                    {t('layout.loginModal.plan')}: {websiteAccount.plan}
                  </div>
                )}
              </>
            )}
            {isCloudLoggedIn && cloudAccount?.email && (
              <div className="wf-login-meta">
                <Building2 size={14} />
                <span>{cloudAccount.email}</span>
              </div>
            )}
            {isMesLoggedIn && (
              <>
                <div className="wf-login-meta">
                  <Building2 size={14} />
                  <span>{t('layout.loginModal.systemCode')}: {user.systemCode}</span>
                </div>
                {user.factoryId && (
                  <div className="wf-login-meta-sub">
                    {t('layout.loginModal.factoryId')}: {user.factoryId} · {t('layout.loginModal.deptId')}: {user.deptId}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="wf-login-welcome-btns">
            {/* 除 Standalone 外，任何已登录身份（mescli-local / website-online）都可以再登录 MES，
                进入 mescli-online 解锁企业级业务功能与数据库。external 构建下 website 账号登录后尤其需要此入口。 */}
            {!IS_STANDALONE && !isMesLoggedIn && (
              <button
                onClick={() => setShowLoginForm(true)}
                className="wf-btn-primary wf-press"
              >
                <LogIn size={16} />
                {t('layout.loginModal.mesLoginTitle')}
              </button>
            )}

            {(IS_STANDALONE || isMesLoggedIn || isCloudLoggedIn || isWebsiteMode || isWebsiteLoggedIn) && (
              <button
                onClick={handleLogout}
                className="wf-btn-danger-soft wf-press"
              >
                <LogOut size={16} />
                {t('layout.loginModal.logout')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* 品牌区（蓝图 .brand）：墨块 W 标 + 语境化标题/副标题 */}
          <div className="wf-login-brand">
            <div className="wf-login-mark">W</div>
            <h2 className="wf-login-brand-t">{brandTitle}</h2>
            <p className="wf-login-brand-s">{brandSub}</p>
          </div>

          {inMesPane ? (
            /* MES 特有面板（未登录二级入口 / 已登录后再登 MES 共用） */
            mesLoginForm
          ) : (
            <div>
              {sessionNotice && (
                <div className="wf-login-hint warn" style={{ marginBottom: 14 }}>
                  <AlertCircle size={16} />
                  <p>{sessionNotice}</p>
                </div>
              )}
              {error && (
                <div className="wf-login-hint error" style={{ marginBottom: 14 }}>
                  <AlertCircle size={16} />
                  <p>{error}</p>
                </div>
              )}
              {websiteError && (
                <div className="wf-login-hint error" style={{ marginBottom: 14 }}>
                  <AlertCircle size={16} />
                  <p>{websiteError}</p>
                </div>
              )}

              {showWebsiteForm ? (
                <>
                  {/* 登录/注册=蓝图双 tab + 滑线 + 200% 滑屏（复用 websiteRegisterMode 状态） */}
                  <div className={cn('wf-login-tabs', websiteRegisterMode && 'p2')}>
                    <button
                      type="button"
                      className={cn('wf-login-tab', !websiteRegisterMode && 'on')}
                      onClick={() => setWebsiteRegisterMode(false)}
                    >
                      {t('layout.loginModal.login')}
                    </button>
                    <button
                      type="button"
                      className={cn('wf-login-tab', websiteRegisterMode && 'on')}
                      onClick={() => setWebsiteRegisterMode(true)}
                    >
                      {t('layout.loginModal.register')}
                    </button>
                    <div className="wf-login-tab-hair" />
                    <div className="wf-login-tab-line" />
                  </div>

                  <div className="wf-login-panes-wrap">
                    <div className={cn('wf-login-panes', websiteRegisterMode && 'p2')}>
                      {/* 登录：邮箱 + 密码 */}
                      <div className="wf-login-pane">
                        <div>
                          <label className="wf-login-label">{t('layout.loginModal.email')}</label>
                          <input
                            type="email"
                            value={websiteEmail}
                            onChange={(e) => setWebsiteEmail(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleWebsiteLogin()}
                            placeholder={t('layout.loginModal.emailPlaceholder')}
                            className="wf-ink-input"
                          />
                        </div>
                        <div>
                          <label className="wf-login-label">{t('layout.loginModal.password')}</label>
                          <input
                            type="password"
                            value={websitePassword}
                            onChange={(e) => setWebsitePassword(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleWebsiteLogin()}
                            placeholder={t('layout.loginModal.enterPassword')}
                            className="wf-ink-input"
                          />
                        </div>
                        <button
                          onClick={handleWebsiteLogin}
                          disabled={isLoading || !websiteEmail.trim() || !websitePassword.trim()}
                          className="wf-btn-primary wf-press"
                        >
                          {isLoading ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <LogIn size={16} />
                          )}
                          {isLoading ? t('layout.loginModal.loggingIn') : t('layout.loginModal.login')}
                        </button>
                      </div>

                      {/* 注册：邮箱 → 六格验证码（发送链在标签行右侧）→ 密码 → 确认密码 */}
                      <div className="wf-login-pane">
                        <div>
                          <label className="wf-login-label">{t('layout.loginModal.email')}</label>
                          <input
                            type="email"
                            value={websiteEmail}
                            onChange={(e) => setWebsiteEmail(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleWebsiteRegister()}
                            placeholder={t('layout.loginModal.emailPlaceholder')}
                            className="wf-ink-input"
                          />
                        </div>
                        <div>
                          <div className="wf-login-label-row">
                            <label className="wf-login-label">{t('layout.loginModal.verifyCode')}</label>
                            <button
                              type="button"
                              onClick={handleWebsiteSendCode}
                              disabled={!websiteEmail.trim() || codeSending || codeCountdown > 0}
                              className="wf-login-codeget"
                            >
                              {codeSending
                                ? t('layout.loginModal.sendingCode')
                                : codeCountdown > 0
                                  ? t('layout.loginModal.resendCode', { seconds: codeCountdown })
                                  : t('layout.loginModal.sendCode')}
                            </button>
                          </div>
                          <CodeCells
                            onChange={setWebsiteCode}
                            onEnter={handleWebsiteRegister}
                            focusSignal={codeFocusSignal}
                          />
                        </div>
                        <div>
                          <label className="wf-login-label">{t('layout.loginModal.password')}</label>
                          <input
                            type="password"
                            value={websitePassword}
                            onChange={(e) => setWebsitePassword(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleWebsiteRegister()}
                            placeholder={t('layout.loginModal.enterPassword')}
                            className="wf-ink-input"
                          />
                        </div>
                        <div>
                          <label className="wf-login-label">{t('layout.loginModal.passwordConfirm')}</label>
                          <input
                            type="password"
                            value={websiteConfirmPassword}
                            onChange={(e) => setWebsiteConfirmPassword(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleWebsiteRegister()}
                            placeholder={t('layout.loginModal.passwordConfirmPlaceholder')}
                            className="wf-ink-input"
                          />
                        </div>
                        <button
                          onClick={handleWebsiteRegister}
                          disabled={isLoading || !websiteEmail.trim() || !websitePassword.trim() || !websiteCode.trim()}
                          className="wf-btn-primary wf-press"
                        >
                          {isLoading ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : (
                            <UserPlus size={16} />
                          )}
                          {isLoading ? t('layout.loginModal.loggingIn') : t('layout.loginModal.register')}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* MES 特有入口：卡片底部安静二级链接（不占 tab——公网用户主路径是邮箱） */}
                  <div className="wf-login-alt">
                    <button
                      type="button"
                      className="wf-login-alt-link wf-press"
                      onClick={() => setShowMesEntry(true)}
                    >
                      {t('layout.loginModal.mesEntryLink')}
                    </button>
                  </div>
                </>
              ) : (
                /* mescli / standalone：MES 表单即主卡（无 tab 无二级链接，与现状行为一致） */
                <div className="space-y-4">
                  <div>
                    <label className="wf-login-label">{IS_STANDALONE ? t('layout.loginModal.username') : t('layout.loginModal.workBarcode')}</label>
                    <input
                      type="text"
                      value={workBarcode}
                      onChange={(e) => setWorkBarcode(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                      placeholder={t('layout.loginModal.enterWorkBarcode')}
                      className="wf-ink-input"
                    />
                  </div>

                  <div>
                    <label className="wf-login-label">{t('layout.loginModal.password')}</label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                      placeholder={t('layout.loginModal.enterPassword')}
                      className="wf-ink-input"
                    />
                  </div>

                  <div>
                    <label className="wf-login-label">{t('layout.loginModal.systemCodeLabel')}</label>
                    <input
                      type="text"
                      value={systemCode}
                      onChange={(e) => setSystemCode(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                      placeholder={t('layout.loginModal.systemCodePlaceholder')}
                      className="wf-ink-input"
                    />
                    {!systemCode.trim() && (
                      <p className="text-xs text-[var(--wf-err-ink)] mt-1">{t('layout.loginModal.systemCodeRequired')}</p>
                    )}
                  </div>

                  <button
                    onClick={handleLogin}
                    disabled={isLoading || !workBarcode.trim() || !password.trim() || !systemCode.trim()}
                    className="wf-btn-primary wf-press"
                  >
                    {isLoading ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <LogIn size={16} />
                    )}
                    {isLoading ? t('layout.loginModal.loggingIn') : t('layout.loginModal.login')}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )

  // 强制登录=整页暖场接管（蓝图本体）；菜单打开=常规 dim 背板弹窗，同一张卡片
  if (forcedLogin) {
    return (
      <div className="wf-login-stage">
        <div className="wf-login-glow a" />
        <div className="wf-login-glow b" />
        {card}
        <div className="wf-login-foot">{productDisplayName}{appVersion ? ` · v${appVersion}` : ''}</div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      {card}
    </div>
  )
}

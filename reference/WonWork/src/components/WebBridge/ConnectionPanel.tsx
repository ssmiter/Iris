import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { cn } from '@/utils'
import { useWebBridgeStore } from '@/stores/webbridgeStore'
import { PageStateCard } from './PageStateCard'
import {
  Globe,
  Plug,
  Unplug,
  Activity,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Power,
} from 'lucide-react'

export function ConnectionPanel() {
  const { t } = useTranslation()
  const {
    status,
    host,
    port,
    useMock,
    error,
    lastStatusInfo,
    pageState,
    autoStartEnabled,
    isStartingDaemon,
    daemonPath,
    connect,
    disconnect,
    checkStatus,
    ensureDaemon,
    startDaemon,
    setHost,
    setPort,
    setUseMock,
    setAutoStartEnabled,
    setDaemonPath,
  } = useWebBridgeStore()

  const [isChecking, setIsChecking] = useState(false)

  const handleCheckStatus = async () => {
    setIsChecking(true)
    await checkStatus()
    setIsChecking(false)
  }

  const handleStartDaemon = async () => {
    await startDaemon()
  }

  const handleEnsureDaemon = async () => {
    await ensureDaemon()
  }

  const isConnected = status === 'connected'
  const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:'

  const statusConfig: Record<typeof status, { color: string; icon: React.ReactNode; label: string }> = {
    disconnected: { color: 'bg-surface-400', icon: <Unplug size={14} />, label: t('webbridge.connectionPanel.disconnected') },
    connecting: { color: 'bg-amber-400', icon: <RefreshCw size={14} className="animate-spin" />, label: t('webbridge.connectionPanel.connecting') },
    starting: { color: 'bg-amber-400', icon: <Power size={14} className="animate-pulse" />, label: t('webbridge.connectionPanel.starting') },
    connected: { color: 'bg-green-500', icon: <Plug size={14} />, label: t('webbridge.connectionPanel.connected') },
    error: { color: 'bg-red-500', icon: <XCircle size={14} />, label: t('webbridge.connectionPanel.error') },
    reconnecting: { color: 'bg-amber-400', icon: <RefreshCw size={14} className="animate-spin" />, label: t('webbridge.connectionPanel.reconnecting') },
  }

  const currentStatus = statusConfig[status]

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {isHttps && (
        <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800">
          <ShieldAlert size={18} className="flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium">{t('webbridge.connectionPanel.httpsWarningTitle')}</p>
            <p className="mt-1 opacity-80">{t('webbridge.connectionPanel.httpsWarningMessage')}</p>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-surface-200 shadow-sm p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-primary-100 rounded-lg">
            <Globe className="text-primary-600" size={24} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-surface-900">{t('webbridge.connectionPanel.title')}</h2>
            <p className="text-sm text-surface-500">{t('webbridge.connectionPanel.subtitle')}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-surface-700 mb-1">
              {t('webbridge.connectionPanel.host')}
            </label>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              disabled={isConnected || isStartingDaemon}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-60"
              placeholder="localhost"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-surface-700 mb-1">
              {t('webbridge.connectionPanel.port')}
            </label>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(parseInt(e.target.value, 10) || 0)}
              disabled={isConnected || isStartingDaemon}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-60"
              placeholder="9223"
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-surface-700 mb-1">
              {t('webbridge.connectionPanel.daemonPath')}
            </label>
            <input
              type="text"
              value={daemonPath || ''}
              onChange={(e) => setDaemonPath(e.target.value || null)}
              disabled={isConnected || isStartingDaemon}
              className="w-full px-3 py-2 bg-surface-50 border border-surface-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:opacity-60"
              placeholder={t('webbridge.connectionPanel.daemonPathPlaceholder')}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 mb-4">
          <input
            id="webbridge-autostart"
            type="checkbox"
            checked={autoStartEnabled}
            onChange={(e) => setAutoStartEnabled(e.target.checked)}
            disabled={isConnected || isStartingDaemon}
            className="w-4 h-4 text-primary-600 rounded border-surface-300 focus:ring-primary-500"
          />
          <label htmlFor="webbridge-autostart" className="text-sm text-surface-700">
            {t('webbridge.connectionPanel.autoStart')}
          </label>
        </div>

        <div className="flex items-center gap-2 mb-6">
          <input
            id="webbridge-mock"
            type="checkbox"
            checked={useMock}
            onChange={(e) => setUseMock(e.target.checked)}
            disabled={isConnected || isStartingDaemon}
            className="w-4 h-4 text-primary-600 rounded border-surface-300 focus:ring-primary-500"
          />
          <label htmlFor="webbridge-mock" className="text-sm text-surface-700">
            {t('webbridge.connectionPanel.useMock')}
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          {isConnected ? (
            <button
              onClick={disconnect}
              className="flex items-center gap-2 px-4 py-2 bg-red-50 hover:bg-red-100 text-red-700 rounded-lg text-sm font-medium transition-colors"
            >
              <Unplug size={16} />
              {t('webbridge.connectionPanel.disconnect')}
            </button>
          ) : (
            <button
              onClick={connect}
              disabled={status === 'connecting' || status === 'reconnecting' || status === 'starting'}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
            >
              <Plug size={16} />
              {t('webbridge.connectionPanel.connect')}
            </button>
          )}

          <button
            onClick={handleCheckStatus}
            disabled={isChecking || isStartingDaemon || (!isConnected && !useMock)}
            className="flex items-center gap-2 px-4 py-2 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
          >
            <Activity size={16} className={cn(isChecking && 'animate-spin')} />
            {t('webbridge.connectionPanel.checkStatus')}
          </button>

          {!isConnected && (
            <button
              onClick={handleStartDaemon}
              disabled={isStartingDaemon || useMock}
              className="flex items-center gap-2 px-4 py-2 bg-surface-100 hover:bg-surface-200 text-surface-700 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
            >
              <Power size={16} className={cn(isStartingDaemon && 'animate-pulse')} />
              {isStartingDaemon ? t('webbridge.connectionPanel.starting') : t('webbridge.connectionPanel.startDaemon')}
            </button>
          )}

          {!isConnected && autoStartEnabled && (
            <button
              onClick={handleEnsureDaemon}
              disabled={isStartingDaemon || useMock}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
            >
              <Power size={16} className={cn(isStartingDaemon && 'animate-pulse')} />
              {isStartingDaemon ? t('webbridge.connectionPanel.starting') : t('webbridge.connectionPanel.ensureDaemon')}
            </button>
          )}
        </div>

        <div className="mt-6 flex items-center gap-3 p-3 bg-surface-50 rounded-lg border border-surface-200">
          <span className={cn('w-3 h-3 rounded-full', currentStatus.color)} />
          <span className="text-sm font-medium text-surface-700">{currentStatus.label}</span>
          <span className="text-surface-400">{currentStatus.icon}</span>
        </div>

        {lastStatusInfo && (
          <div className="mt-4 p-3 bg-surface-50 rounded-lg border border-surface-200 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-surface-500">{t('webbridge.connectionPanel.daemonVersion')}</span>
              <span className="font-medium text-surface-700">{lastStatusInfo.version || '-'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-surface-500">{t('webbridge.connectionPanel.chromeReady')}</span>
              <span className="font-medium">
                {lastStatusInfo.chrome_ready ? (
                  <span className="flex items-center gap-1 text-green-600">
                    <CheckCircle2 size={14} /> {t('webbridge.connectionPanel.yes')}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-red-600">
                    <XCircle size={14} /> {t('webbridge.connectionPanel.no')}
                  </span>
                )}
              </span>
            </div>
            {lastStatusInfo.chrome_error && (
              <div className="p-2 bg-red-50 text-red-700 rounded text-xs">
                {lastStatusInfo.chrome_error}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}
      </div>

      {pageState && <PageStateCard pageState={pageState} />}
    </div>
  )
}

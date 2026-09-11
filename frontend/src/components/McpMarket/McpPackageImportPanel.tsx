import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  FileArchive,
  Loader2,
  PackageCheck,
  ShieldCheck,
  UploadCloud,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/utils'
import {
  mcpMarketApi,
  type McpPackageInstallResult,
  type McpPackagePreview,
} from '@/api/mcpMarketApi'

interface Props {
  existingNames: string[]
  onClose: () => void
  onInstalled: (result: McpPackageInstallResult) => void | Promise<void>
}

const AI_PACKAGE_PROMPT = `请按照《Iris MCP 导入标准 v1.0》整理这个 MCP：
1. 优先输出标准 .mcpb 包，根目录必须有 manifest.json；
2. 包内不得包含绝对路径、账号密码、数据库密码或安装脚本；
3. 把地址、账号等环境差异声明为 user_config；
4. 确保入口文件和运行时要求完整，并在本机自测后输出可导入文件。`

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : '操作未完成，请稍后重试。'
}

export function McpPackageImportPanel({ existingNames, onClose, onInstalled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<McpPackagePreview | null>(null)
  const [serverName, setServerName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [replaceExisting, setReplaceExisting] = useState(false)
  const [trusted, setTrusted] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isInstalling, setIsInstalling] = useState(false)
  const [error, setError] = useState('')
  const [installed, setInstalled] = useState<McpPackageInstallResult | null>(null)

  const conflicts = useMemo(
    () => existingNames.some((name) => name.toLowerCase() === serverName.trim().toLowerCase()),
    [existingNames, serverName]
  )

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isPreviewing && !isInstalling) onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isInstalling, isPreviewing, onClose])

  const resetForFile = () => {
    setPreview(null)
    setInstalled(null)
    setServerName('')
    setValues({})
    setReplaceExisting(false)
    setTrusted(false)
    setError('')
  }

  const chooseFile = async (nextFile?: File) => {
    if (!nextFile) return
    resetForFile()
    setFile(nextFile)
    setIsPreviewing(true)
    try {
      const result = await mcpMarketApi.previewPackage(nextFile)
      setPreview(result)
      setServerName(result.name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/__/g, '_'))
      setValues(Object.fromEntries(result.userConfig.map((field) => [field.key, String(field.defaultValue ?? '')])))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setIsPreviewing(false)
    }
  }

  const install = async () => {
    if (!preview) return
    if (!trusted) {
      setError('请先确认你信任该工具包来源，并允许它在本机运行。')
      return
    }
    if (conflicts && !replaceExisting) {
      setError('已有同名能力，请确认替换或修改能力名称。')
      return
    }
    const missing = preview.userConfig.find((field) => field.required && !values[field.key]?.trim())
    if (missing) {
      setError(`请填写「${missing.title}」。`)
      return
    }

    setError('')
    setIsInstalling(true)
    try {
      const result = await mcpMarketApi.installPackage({
        token: preview.token,
        serverName: serverName.trim(),
        userConfig: values,
        replaceExisting,
      })
      setInstalled(result)
      await onInstalled(result)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setIsInstalling(false)
    }
  }

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(AI_PACKAGE_PROMPT)
    toast.success('AI 制包提示词已复制')
  }

  const step = installed ? 3 : preview ? 2 : 1

  return (
    <div className="absolute inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label="导入 MCP">
      <button className="absolute inset-0 bg-black/20" aria-label="关闭导入面板" onClick={onClose} />
      <section
        className="relative flex h-full w-full max-w-[34rem] flex-col border-l border-[var(--wf-line)] bg-[var(--wf-card-bg)]"
        style={{ boxShadow: '-16px 0 40px rgba(20,20,30,.10)' }}
      >
        <header className="flex items-start justify-between border-b border-[var(--wf-line)] px-6 py-5">
          <div>
            <h2 className="text-[16px] font-bold text-[var(--wf-ink)]">导入 MCP</h2>
            <p className="mt-1 text-[12px] text-[var(--wf-mut)]">预检后再安装，不执行上传包中的安装脚本</p>
          </div>
          <button className="wf-mini-btn !h-8 !w-8 !p-0" onClick={onClose} aria-label="关闭">
            <X size={15} />
          </button>
        </header>

        <div className="border-b border-[var(--wf-line)] px-6 py-4">
          <ol className="grid grid-cols-3 gap-2" aria-label="导入步骤">
            {['选择工具包', '预检与配置', '完成'].map((label, index) => {
              const number = index + 1
              const active = step >= number
              return (
                <li key={label} className="flex items-center gap-2 text-[11px]">
                  <span className={cn('grid h-5 w-5 place-items-center rounded-full border font-mono', active
                    ? 'border-[var(--wf-accent)] bg-[var(--wf-accent)] text-white'
                    : 'border-[var(--wf-line)] text-[var(--wf-faint)]')}>
                    {step > number ? <Check size={12} /> : number}
                  </span>
                  <span className={active ? 'font-semibold text-[var(--wf-ink)]' : 'text-[var(--wf-mut)]'}>{label}</span>
                </li>
              )
            })}
          </ol>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {installed ? (
            <div className="flex min-h-full flex-col items-center justify-center text-center">
              <span className="grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50 text-emerald-600">
                <PackageCheck size={28} />
              </span>
              <h3 className="mt-4 text-[16px] font-bold text-[var(--wf-ink)]">{installed.serverName} 已可使用</h3>
              <p className="mt-2 max-w-sm text-[13px] leading-6 text-[var(--wf-mut)]">
                已连接并加载 {installed.toolCount} 个工具、{installed.appCount} 个页面。现在可以回到对话中直接用自然语言调用。
              </p>
              <div className="mt-5 flex gap-2">
                <button className="wf-mini-btn" onClick={() => { resetForFile(); setFile(null) }}>继续导入</button>
                <button className="wf-mini-btn !border-[var(--wf-accent)] !bg-[var(--wf-accent)] !text-white" onClick={onClose}>完成</button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <input
                ref={inputRef}
                className="sr-only"
                type="file"
                accept=".mcpb,.zip"
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
              <button
                type="button"
                className={cn(
                  'group flex w-full flex-col items-center rounded-[14px] border border-dashed px-5 py-7 text-center transition-colors',
                  dragging ? 'border-[var(--wf-accent)] bg-blue-50/50' : 'border-[var(--wf-line)] bg-[var(--wf-bg)] hover:border-[var(--wf-accent)]'
                )}
                onClick={() => inputRef.current?.click()}
                onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragging(false)
                  void chooseFile(event.dataTransfer.files[0])
                }}
              >
                {isPreviewing ? <Loader2 size={26} className="animate-spin text-[var(--wf-accent)]" /> : <UploadCloud size={26} className="text-[var(--wf-accent)]" />}
                <span className="mt-3 text-[13px] font-semibold text-[var(--wf-ink)]">
                  {isPreviewing ? '正在安全预检…' : file ? file.name : '选择或拖入 MCP 工具包'}
                </span>
                <span className="mt-1 text-[11px] text-[var(--wf-mut)]">推荐 .mcpb，也兼容规范 ZIP；最大 50 MB</span>
              </button>

              {!preview && !isPreviewing && (
                <div className="grid grid-cols-2 gap-3">
                  <a
                    className="wf-card flex min-h-[116px] flex-col items-start p-4 text-left hover:border-[var(--wf-accent)]"
                    href={mcpMarketApi.packageStandardUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <BookOpen size={17} className="text-[var(--wf-accent)]" />
                    <span className="mt-3 text-[13px] font-semibold text-[var(--wf-ink)]">制作规范</span>
                    <span className="mt-1 text-[11px] leading-5 text-[var(--wf-mut)]">给开发者或 AI 的温和兼容标准</span>
                  </a>
                  <button className="wf-card flex min-h-[116px] flex-col items-start p-4 text-left hover:border-[var(--wf-accent)]" onClick={() => void copyPrompt()}>
                    <Copy size={17} className="text-[var(--wf-accent)]" />
                    <span className="mt-3 text-[13px] font-semibold text-[var(--wf-ink)]">AI 制包</span>
                    <span className="mt-1 text-[11px] leading-5 text-[var(--wf-mut)]">复制提示词，让 AI 按规范整理工具包</span>
                  </button>
                </div>
              )}

              {preview && (
                <>
                  <div className="wf-card p-4">
                    <div className="flex items-start gap-3">
                      <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-blue-50 text-[var(--wf-accent)]"><FileArchive size={18} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="truncate text-[14px] font-semibold text-[var(--wf-ink)]">{preview.displayName}</h3>
                          <div className="flex items-center gap-1.5">
                            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-[var(--wf-accent)]">本机运行</span>
                            <span className="font-mono text-[10px] text-[var(--wf-mut)]">v{preview.version}</span>
                          </div>
                        </div>
                        <p className="mt-1 text-[12px] leading-5 text-[var(--wf-mut)]">{preview.description || '未提供说明'}</p>
                        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--wf-faint)]">
                          <span>运行时 {preview.runtime}{preview.runtimeRequirement ? ` ${preview.runtimeRequirement}` : ''}</span>
                          <span>{preview.fileCount} 个文件</span>
                          <span>{formatBytes(preview.expandedBytes)}</span>
                          <span>SHA {preview.sha256.slice(0, 10)}</span>
                        </div>
                      </div>
                      <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-700"><CheckCircle2 size={13} />预检通过</span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <label className="block">
                      <span className="mb-1.5 block text-[12px] font-semibold text-[var(--wf-ink)]">能力名称</span>
                      <input className="wf-ink-input" value={serverName} onChange={(event) => { setServerName(event.target.value); setError('') }} />
                    </label>
                    {preview.userConfig.map((field) => (
                      <label className="block" key={field.key}>
                        <span className="mb-1.5 block text-[12px] font-semibold text-[var(--wf-ink)]">
                          {field.title}{field.required && <em className="ml-1 not-italic text-red-500">*</em>}
                        </span>
                        <input
                          className="wf-ink-input"
                          type={field.sensitive ? 'password' : 'text'}
                          value={values[field.key] ?? ''}
                          placeholder={field.description}
                          onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                        />
                        {field.description && <span className="mt-1 block text-[10px] text-[var(--wf-faint)]">{field.description}</span>}
                      </label>
                    ))}
                  </div>

                  {conflicts && (
                    <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-[11px] leading-5 text-amber-900">
                      <input className="mt-1" type="checkbox" checked={replaceExisting} onChange={(event) => setReplaceExisting(event.target.checked)} />
                      <span>已有同名能力。用本次导入版本替换其配置；如果连接失败，Iris 会恢复原配置。</span>
                    </label>
                  )}

                  {preview.warnings.map((warning) => (
                    <p key={warning} className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-[11px] leading-5 text-amber-900">
                      <AlertCircle size={13} className="mt-1 flex-none" />{warning}
                    </p>
                  ))}

                  <label className="flex cursor-pointer items-start gap-2 rounded-xl bg-[var(--wf-bg)] p-3 text-[11px] leading-5 text-[var(--wf-sub)]">
                    <input className="mt-1" type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />
                    <span><b className="font-semibold text-[var(--wf-ink)]">我信任该工具包来源。</b> 本地 MCP 会以当前用户权限运行；Iris 不会执行包内安装脚本。</span>
                  </label>
                </>
              )}

              {error && <p className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-[11px] leading-5 text-[var(--wf-err-ink)]"><AlertCircle size={13} className="mt-1 flex-none" />{error}</p>}
            </div>
          )}
        </div>

        {!installed && preview && (
          <footer className="border-t border-[var(--wf-line)] px-6 py-4">
            <div className="mb-3 flex items-center gap-2 text-[10px] text-[var(--wf-faint)]"><ShieldCheck size={13} />安装失败自动回滚，不影响已有能力</div>
            <button
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[var(--wf-accent)] text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isInstalling || !serverName.trim() || !trusted || (conflicts && !replaceExisting)}
              onClick={() => void install()}
            >
              {isInstalling ? <Loader2 size={15} className="animate-spin" /> : <PackageCheck size={15} />}
              {isInstalling ? '正在安装并连接…' : '确认安装'}
            </button>
          </footer>
        )}
      </section>
    </div>
  )
}

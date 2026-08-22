import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
} from 'react'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { ExtraProps } from 'react-markdown'

import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'

import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'

SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('ts', typescript)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('js', javascript)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('py', python)
SyntaxHighlighter.registerLanguage('java', java)
SyntaxHighlighter.registerLanguage('sql', sql)
SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('shell', bash)
SyntaxHighlighter.registerLanguage('sh', bash)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('yaml', yaml)
SyntaxHighlighter.registerLanguage('yml', yaml)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('md', markdown)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('markup', markup)
SyntaxHighlighter.registerLanguage('html', markup)
SyntaxHighlighter.registerLanguage('go', go)
SyntaxHighlighter.registerLanguage('rust', rust)

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  shell: 'bash',
  sh: 'bash',
  yml: 'yaml',
  md: 'markdown',
}

const SUPPORTED_KEYS = new Set([
  'tsx',
  'typescript',
  'javascript',
  'python',
  'java',
  'sql',
  'bash',
  'json',
  'yaml',
  'markdown',
  'css',
  'html',
  'go',
  'rust',
])

function normalizeLanguage(raw: string) {
  const lower = raw.toLowerCase()
  const key = LANG_ALIASES[lower] ?? lower
  if (!SUPPORTED_KEYS.has(key)) return null
  return key
}

function subscribeThemeChange(callback: () => void) {
  const el = document.documentElement
  const observer = new MutationObserver(callback)
  observer.observe(el, {
    attributes: true,
    attributeFilter: ['class', 'data-theme'],
  })
  return () => observer.disconnect()
}

function isDarkSnapshot() {
  return document.documentElement.classList.contains('dark')
}

function useIsDark() {
  return useSyncExternalStore(
    subscribeThemeChange,
    isDarkSnapshot,
    () => false,
  )
}

interface CopyButtonProps {
  text: string
}

function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // 静默失败：剪贴板权限被拒绝时不变勾，避免误导
    }
  }, [text])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        'absolute top-2 right-2 z-10 flex h-7 w-7 items-center justify-center rounded-md',
        'bg-surface-raised/80 text-ink-subtle opacity-0 transition-opacity duration-fast ease-standard',
        'hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:opacity-100',
      )}
      title={copied ? '已复制' : '复制代码'}
      aria-label={copied ? '已复制' : '复制代码'}
    >
      {copied
        ? <Check size={14} className="text-success" aria-hidden="true" />
        : <Copy size={14} aria-hidden="true" />}
    </button>
  )
}

type CodeBlockProps = ComponentPropsWithoutRef<'code'> &
  ExtraProps & { inline?: boolean }

export function CodeBlock({
  className,
  children,
  node: _node,
  ...rest
}: CodeBlockProps) {
  const text = String(children)
  const match = /language-(\w+)/.exec(className || '')
  // react-markdown v9 不再传 inline：有语言标记或含换行按块级处理，其余按行内
  const isBlock = Boolean(match) || text.includes('\n')

  if (!isBlock) {
    return (
      <code className={cn('px-1.5 py-0.5 rounded text-sm font-mono bg-surface-muted text-ink')} {...rest}>
        {children}
      </code>
    )
  }

  const code = text.replace(/\n$/, '')
  const rawLang = match?.[1] ?? ''
  const language = normalizeLanguage(rawLang) ?? 'markup'
  const isDark = useIsDark()

  return (
    <div className="group relative my-2">
      <CopyButton text={code} />
      <SyntaxHighlighter
        style={isDark ? oneDark : oneLight}
        language={language}
        PreTag="div"
        className="rounded-[0.5rem] text-sm"
        customStyle={{ margin: 0 }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

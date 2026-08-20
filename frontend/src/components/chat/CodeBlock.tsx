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

import { Button } from '@/components/ui/Button'
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

const LANG_LABELS: Record<string, string> = {
  tsx: 'TSX',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  java: 'Java',
  sql: 'SQL',
  bash: 'Bash',
  json: 'JSON',
  yaml: 'YAML',
  markdown: 'Markdown',
  css: 'CSS',
  html: 'HTML',
  go: 'Go',
  rust: 'Rust',
}

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  shell: 'bash',
  sh: 'bash',
  yml: 'yaml',
  md: 'markdown',
}

const SUPPORTED_KEYS = new Set(Object.keys(LANG_LABELS))

function normalizeLanguage(raw: string) {
  const lower = raw.toLowerCase()
  const key = LANG_ALIASES[lower] ?? lower
  if (!SUPPORTED_KEYS.has(key)) return null
  return { key, label: LANG_LABELS[key] }
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
  title?: string
  className?: string
  size?: 'sm' | 'md'
}

function CopyButton({ text, title = '复制', className, size = 'md' }: CopyButtonProps) {
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

  const iconSize = size === 'sm' ? 14 : 16

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      title={copied ? '已复制' : title}
      className={cn('shrink-0', className)}
      onClick={handleCopy}
    >
      {copied
        ? (
            <Check size={iconSize} className="text-success" aria-hidden="true" />
          )
        : (
            <Copy size={iconSize} aria-hidden="true" />
          )}
      <span className="sr-only">{copied ? '已复制' : title}</span>
    </Button>
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

  // 行内代码保持默认渲染，让 .answer-prose :not(pre) > code 接管样式
  if (!isBlock) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    )
  }

  const code = text.replace(/\n$/, '')
  const rawLang = match?.[1] ?? ''
  const lang = normalizeLanguage(rawLang)
  const isDark = useIsDark()

  const header = (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5">
      <span className="font-mono text-caption text-ink-muted">
        {lang ? lang.label : 'text'}
      </span>
      <CopyButton
        text={code}
        title="复制代码"
        size="sm"
        className="h-7 w-7 rounded-xs p-0 opacity-0 transition-opacity duration-fast ease-standard group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
      />
    </div>
  )

  if (!lang) {
    // 与有语言分支同一容器语言：header 与 pre 包进同一边框圆角容器。
    // pre 自身的 .answer-prose 边框/圆角用内联样式归零，背景保留 token 底。
    return (
      <div className="code-block group overflow-hidden rounded-xl border border-border/70">
        <div className="border-b border-border/70 bg-surface-muted">
          {header}
        </div>
        <pre style={{ border: 'none', borderRadius: 0 }}>
          <code>{code}</code>
        </pre>
      </div>
    )
  }

  return (
    <div className="code-block group overflow-hidden rounded-xl border border-border/70 bg-surface-muted">
      <div className="border-b border-border/70 bg-surface-muted">
        {header}
      </div>
      <SyntaxHighlighter
        style={isDark ? oneDark : oneLight}
        language={lang.key}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: 0,
          padding: '12px 14px',
          fontSize: '12.5px',
          lineHeight: '1.75',
          // 高亮主题底色让位：外层容器承载 bg-surface-muted，暖/冷色调维度对代码块生效
          background: 'transparent',
          backgroundColor: 'transparent',
        }}
        codeTagProps={{
          style: {
            background: 'transparent',
            backgroundColor: 'transparent',
            textShadow: 'none',
          },
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

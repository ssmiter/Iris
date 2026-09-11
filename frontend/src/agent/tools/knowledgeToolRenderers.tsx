import { memo, useMemo } from 'react'
import { BookOpenCheck, ExternalLink, FileText, ShieldCheck } from 'lucide-react'
import type { ToolResultRendererProps } from './toolRenderRegistry'
import type { KnowledgeCitation, KnowledgeReadResult } from '@/types/knowledge'
import { useKnowledgeNavigationStore } from '@/stores/knowledgeNavigationStore'
import './knowledge-tool-renderers.css'

interface SearchPayload {
  results?: Array<{ citation?: UnknownCitation }>
  partial?: boolean
  elapsedMilliseconds?: number
}

type UnknownCitation = Omit<KnowledgeCitation, 'domain'> & { domain: unknown }
type UnknownRead = Omit<KnowledgeReadResult, 'domain'> & { domain: unknown }

function sourceDomain(value: unknown): 'local' | 'online' {
  return value === 2 || String(value).toLowerCase() === 'online' ? 'online' : 'local'
}

function structured(message: ToolResultRendererProps['message']): unknown {
  if (message.structuredData != null) return message.structuredData
  try { return JSON.parse(message.content || '{}') } catch { return null }
}

function citationOf(value: UnknownCitation | undefined): KnowledgeCitation | null {
  if (!value?.documentId || !value.collectionId || !value.provider) return null
  return { ...value, domain: sourceDomain(value.domain) }
}

function SearchResult({ message }: ToolResultRendererProps) {
  const openCitation = useKnowledgeNavigationStore((state) => state.openCitation)
  const payload = useMemo(() => structured(message) as SearchPayload | null, [message])
  const citations = (payload?.results ?? [])
    .map((item) => citationOf(item.citation))
    .filter((item): item is KnowledgeCitation => item != null)

  return (
    <section className="ww-kb-tool" aria-label="Knowledge search citations">
      <header><BookOpenCheck size={15} /><b>知识引用</b><span>{citations.length} 条 · {payload?.elapsedMilliseconds ?? 0}ms</span></header>
      {payload?.partial && <div className="ww-kb-tool-warning">部分在线源暂不可用，当前答案仍保留可验证引用。</div>}
      <div className="ww-kb-tool-list">
        {citations.slice(0, 5).map((citation) => (
          <button
            key={`${citation.domain}:${citation.documentId}:${citation.revision}:${citation.chunkOrdinal}`}
            type="button"
            onClick={() => openCitation(citation)}
            className="ww-kb-tool-citation"
          >
            <span className={`ww-kb-tool-domain ${citation.domain}`}>{citation.domain === 'online' ? 'ONLINE' : 'LOCAL'}</span>
            <span className="ww-kb-tool-copy"><b>{citation.title}</b><small>{citation.snippet || citation.sourceLocator}</small></span>
            <span className="ww-kb-tool-revision">R{citation.revision}<ExternalLink size={12} /></span>
          </button>
        ))}
        {citations.length === 0 && <div className="ww-kb-tool-empty">未返回可定位的知识引用</div>}
      </div>
      <footer><ShieldCheck size={12} /> 引用已固定到文档版本与内容分块</footer>
    </section>
  )
}

function ReadResult({ message }: ToolResultRendererProps) {
  const openCitation = useKnowledgeNavigationStore((state) => state.openCitation)
  const raw = useMemo(() => structured(message) as UnknownRead | null, [message])
  if (!raw?.documentId || !raw.collectionId || !raw.provider) return <div className="ww-kb-tool-empty">知识内容读取失败</div>
  const citation: KnowledgeCitation = {
    domain: sourceDomain(raw.domain), provider: raw.provider, collectionId: raw.collectionId,
    documentId: raw.documentId, revision: raw.revision, chunkOrdinal: raw.chunkOrdinal ?? 0,
    title: raw.title, sourceLocator: raw.sourceLocator, snippet: raw.content?.slice(0, 180) ?? '',
    keywordScore: 0, vectorScore: 0, finalScore: 1,
    startLine: raw.startLine, endLine: raw.endLine,
  }
  return (
    <button type="button" className="ww-kb-tool ww-kb-tool-read" onClick={() => openCitation(citation)}>
      <FileText size={17} /><span><b>{raw.title}</b><small>{raw.sourceLocator} · R{raw.revision}</small></span><ExternalLink size={13} />
    </button>
  )
}

export const KnowledgeToolResultRenderer = memo(function KnowledgeToolResultRenderer(props: ToolResultRendererProps) {
  return props.message.toolCallName === 'knowledge_read' ? <ReadResult {...props} /> : <SearchResult {...props} />
})

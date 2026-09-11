import { useMemo, useState, type CSSProperties } from 'react'
import { Check, ChevronRight, FileText, Folder, FolderTree, GitBranch, LayoutList, Search, Tags, Trash2, TriangleAlert, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { KnowledgeDocumentSummary } from '@/types/knowledge'
import { buildKnowledgeResourceTree, findResourceNode, parentResourcePath, type KnowledgeResourceNode } from './knowledgeResourceTree'

type ViewMode = 'directory' | 'map'

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function typeOf(document: KnowledgeDocumentSummary) {
  const extension = document.sourceLocator.split('.').pop()?.toLowerCase()
  if (document.mimeType.includes('markdown') || ['md', 'mdx'].includes(extension || '')) return 'markdown'
  if (document.mimeType.includes('pdf') || extension === 'pdf') return 'pdf'
  if (document.mimeType.includes('word') || document.mimeType.includes('sheet') || document.mimeType.includes('presentation') || ['docx', 'xlsx', 'pptx'].includes(extension || '')) return 'office'
  if (document.mimeType.startsWith('text/') || ['json', 'yaml', 'yml', 'csv', 'xml'].includes(extension || '')) return 'text'
  return 'other'
}

function DocumentRow({ document, open, editTags, remove, t }: { document: KnowledgeDocumentSummary; open: () => void; editTags?: () => void; remove?: () => void; t: (key: string, options?: Record<string, unknown>) => string }) {
  const semantic = document.chunkCount > 0 && document.vectorChunkCount >= document.chunkCount
  const uploadMeta = document.uploadedByName && document.uploadedAt
    ? `${document.uploadedByName} · ${new Date(document.uploadedAt).toLocaleString()}`
    : null
  return <div className="ww-kb-resource-card">
    <button type="button" className="ww-kb-resource-row is-document" onClick={open}>
      <span className="ww-kb-resource-glyph"><FileText size={16} /></span>
      <span className="ww-kb-resource-primary"><b>{document.title}</b><small>{document.sourceLocator}</small>{uploadMeta && <small>{uploadMeta}</small>}<span>{(document.tags || []).map((tag) => <i key={tag}>#{tag}</i>)}</span></span>
      <span className="ww-kb-resource-metrics"><small>{formatBytes(document.byteLength)}</small><em className={semantic ? 'is-semantic' : 'is-keyword'}>{t('knowledge.resource.indexed')}</em></span>
    </button>
    {editTags && <button type="button" className="ww-kb-resource-tag-action" aria-label={t('knowledge.resource.editTagsAria', { title: document.title })} onClick={editTags}><Tags size={13} /></button>}
    {remove && <button type="button" className="ww-kb-resource-delete-action" aria-label={t('knowledge.resource.deleteAria', { title: document.title })} onClick={remove}><Trash2 size={13} /></button>}
  </div>
}

function MapBranch({ node, expanded, toggle, openDocument, setDirectory, t, depth = 0 }: {
  node: KnowledgeResourceNode; expanded: Set<string>; toggle: (node: KnowledgeResourceNode) => void
  openDocument: (document: KnowledgeDocumentSummary) => void; setDirectory: (path: string) => void; t: (key: string, options?: Record<string, unknown>) => string; depth?: number
}) {
  const isOpen = node.kind === 'collection' || expanded.has(node.id)
  const hasChildren = node.children.length > 0
  const activate = () => {
    if (node.kind === 'document' && node.document) {
      setDirectory(parentResourcePath(node.document.sourceLocator))
      openDocument(node.document)
    }
    if (hasChildren) toggle(node)
  }
  return <li role="treeitem" aria-expanded={hasChildren ? isOpen : undefined} className={`ww-kb-map-node is-${node.kind}`}>
    <button type="button" onClick={activate} aria-label={t('knowledge.resource.mapNodeAria', { name: node.name, count: node.children.length })}>
      <span>{node.kind === 'folder' || node.kind === 'collection' ? <Folder size={15} /> : node.kind === 'document' ? <FileText size={15} /> : <GitBranch size={13} />}</span>
      <b>{node.name}</b>{hasChildren && <small>{node.children.length}</small>}
    </button>
    {isOpen && hasChildren && <ul role="group" style={{ '--map-depth': depth + 1 } as CSSProperties}>{node.children.map((child) => <MapBranch key={child.id} node={child} expanded={expanded} toggle={toggle} openDocument={openDocument} setDirectory={setDirectory} t={t} depth={depth + 1} />)}</ul>}
  </li>
}

export function KnowledgeResourceExplorer({ collectionName, documents, loading, openDocument, canEditTags, canDelete, replaceTags, deleteDocument }: {
  collectionName: string; documents: KnowledgeDocumentSummary[]; loading: boolean
  openDocument: (document: KnowledgeDocumentSummary) => void
  canEditTags?: boolean
  canDelete?: boolean
  replaceTags?: (documentId: string, tags: string[]) => Promise<void>
  deleteDocument?: (documentId: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [view, setView] = useState<ViewMode>('directory')
  const [directory, setDirectory] = useState('')
  const [query, setQuery] = useState('')
  const [documentType, setDocumentType] = useState('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editingDocument, setEditingDocument] = useState<KnowledgeDocumentSummary | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [savingTags, setSavingTags] = useState(false)
  const [deletingDocument, setDeletingDocument] = useState<KnowledgeDocumentSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const tree = useMemo(() => buildKnowledgeResourceTree(collectionName, documents, t('knowledge.resource.rootDirectory')), [collectionName, documents, t])
  const current = findResourceNode(tree, directory) || tree
  const allPaths = useMemo(() => Array.from(new Set(documents.map((document) => parentResourcePath(document.sourceLocator) || t('knowledge.resource.rootDirectory')))).sort(), [documents, t])
  const visibleChildren = current.children.filter((node) => node.kind === 'folder' || (node.document && (documentType === 'all' || typeOf(node.document) === documentType) && (!query.trim() || `${node.document.title} ${node.document.sourceLocator} ${(node.document.tags || []).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))))
  const crumbs = directory ? directory.split('/') : []
  const toggle = (node: KnowledgeResourceNode) => setExpanded((previous) => {
    const next = new Set(previous)
    if (next.has(node.id)) next.delete(node.id); else next.add(node.id)
    return next
  })
  const startTagEdit = (document: KnowledgeDocumentSummary) => {
    setEditingDocument(document)
    setTagDraft((document.tags || []).join(', '))
  }
  const saveTags = async () => {
    if (!editingDocument || !replaceTags) return
    const tags = Array.from(new Set(tagDraft.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean)))
    setSavingTags(true)
    try { await replaceTags(editingDocument.id, tags); setEditingDocument(null) }
    finally { setSavingTags(false) }
  }

  const DOCUMENT_TYPES = [
    { value: 'all', label: t('knowledge.resource.typeAll') },
    { value: 'markdown', label: 'Markdown' },
    { value: 'pdf', label: 'PDF' },
    { value: 'office', label: 'Office' },
    { value: 'text', label: t('knowledge.resource.typeText') },
    { value: 'other', label: t('knowledge.resource.typeOther') },
  ]

  return <section className="ww-kb-resource-explorer" aria-label={t('knowledge.resource.panelAriaLabel', { collectionName })}>
    <div className="ww-kb-resource-commandbar">
      <div className="ww-kb-resource-view-switch" aria-label={t('knowledge.resource.viewAriaLabel')}>
        <button type="button" className={view === 'directory' ? 'is-active' : ''} onClick={() => setView('directory')}><LayoutList size={13} />{t('knowledge.resource.viewDirectory')}</button>
        <button type="button" className={view === 'map' ? 'is-active' : ''} onClick={() => setView('map')}><GitBranch size={13} />{t('knowledge.resource.viewMap')}</button>
      </div>
      <label><Search size={13} /><input aria-label={t('knowledge.resource.filterAriaLabel')} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('knowledge.resource.filterPlaceholder')} /></label>
      <select aria-label={t('knowledge.resource.typeAriaLabel')} value={documentType} onChange={(event) => setDocumentType(event.target.value)}>{DOCUMENT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select>
    </div>
    <nav className="ww-kb-resource-directories" aria-label={t('knowledge.resource.quickPathsAriaLabel')}><span><FolderTree size={13} />{t('knowledge.resource.quickPaths')}</span>{allPaths.map((path) => <button type="button" key={path} onClick={() => { setDirectory(path === t('knowledge.resource.rootDirectory') ? '' : path); setView('directory') }}>{path}</button>)}</nav>
    {view === 'directory' ? <>
      <nav className="ww-kb-breadcrumbs" aria-label={t('knowledge.resource.breadcrumbsAriaLabel')}><button type="button" onClick={() => setDirectory('')}>{collectionName}</button>{crumbs.map((crumb, index) => <span key={`${crumb}-${index}`}><ChevronRight size={12} /><button type="button" onClick={() => setDirectory(crumbs.slice(0, index + 1).join('/'))}>{crumb}</button></span>)}</nav>
      <div className="ww-kb-resource-list">
        {loading ? <div className="ww-kb-document-loading">{t('knowledge.resource.loading')}</div> : visibleChildren.length === 0 ? <div className="ww-kb-document-empty is-filtered"><Search size={22} /><b>{t('knowledge.resource.emptyFilteredTitle')}</b><span>{t('knowledge.resource.emptyFilteredHint')}</span></div> : visibleChildren.map((node) => node.kind === 'folder'
          ? <button type="button" className="ww-kb-resource-row is-folder" key={node.id} onClick={() => setDirectory(node.path)}><span className="ww-kb-resource-glyph"><Folder size={16} /></span><span className="ww-kb-resource-primary"><b>{node.name}</b><small>{node.path}</small></span><span className="ww-kb-resource-metrics"><small>{t('knowledge.resource.childCount', { count: node.children.length })}</small><ChevronRight size={15} /></span></button>
          : <DocumentRow key={node.id} document={node.document!} open={() => openDocument(node.document!)} editTags={canEditTags && replaceTags ? () => startTagEdit(node.document!) : undefined} remove={canDelete && deleteDocument ? () => setDeletingDocument(node.document!) : undefined} t={t} />)}
      </div>
    </> : <div className="ww-kb-map-canvas"><div className="ww-kb-map-caption"><span>{t('knowledge.resource.mapCaptionTitle')}</span><b>{t('knowledge.resource.mapCaptionSubtitle')}</b></div><ul role="tree" aria-label={t('knowledge.resource.mapTreeAriaLabel')} className="ww-kb-map-tree"><MapBranch node={tree} expanded={expanded} toggle={toggle} openDocument={openDocument} setDirectory={setDirectory} t={t} /></ul></div>}
    {editingDocument && <div className="ww-kb-tag-editor" role="dialog" aria-label={t('knowledge.resource.tagEditorAriaLabel')}>
      <div><span><Tags size={14} /></span><b>{editingDocument.title}</b><button type="button" aria-label={t('knowledge.resource.tagEditorClose')} onClick={() => setEditingDocument(null)}><X size={14} /></button></div>
      <label>{t('knowledge.resource.tagsLabel')}<input aria-label={t('knowledge.resource.tagsLabel')} autoFocus value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder={t('knowledge.resource.tagsPlaceholder')} /></label>
      <p>{t('knowledge.resource.tagsHint')}</p>
      <footer><button type="button" onClick={() => setEditingDocument(null)}>{t('knowledge.resource.cancel')}</button><button type="button" className="is-primary" disabled={savingTags} onClick={() => void saveTags()}><Check size={13} />{savingTags ? t('knowledge.resource.savingTags') : t('knowledge.resource.saveTags')}</button></footer>
    </div>}
    {deletingDocument && <div className="ww-kb-tag-editor ww-kb-delete-confirm" role="dialog" aria-label={t('knowledge.resource.deleteDialogAriaLabel')}>
      <div><span><TriangleAlert size={15} /></span><b>{t('knowledge.resource.deleteDialogTitle', { title: deletingDocument.title })}</b><button type="button" aria-label={t('knowledge.resource.deleteDialogClose')} onClick={() => setDeletingDocument(null)}><X size={14} /></button></div>
      <p>{deletingDocument.domain === 'online'
        ? t('knowledge.resource.deleteOnlineDescription')
        : t('knowledge.resource.deleteLocalDescription')}</p>
      <footer><button type="button" onClick={() => setDeletingDocument(null)}>{t('knowledge.resource.cancel')}</button><button type="button" className="is-danger" disabled={deleting} onClick={() => { setDeleting(true); void deleteDocument?.(deletingDocument.id).then(() => setDeletingDocument(null)).finally(() => setDeleting(false)) }}><Trash2 size={13} />{deleting ? t('knowledge.resource.deleting') : t('knowledge.resource.confirmDelete')}</button></footer>
    </div>}
  </section>
}

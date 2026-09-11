import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Cloud, FilePlus2, FileUp, Folder, FolderInput, FolderPlus, LoaderCircle, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useKnowledgeStore } from '@/stores/knowledgeStore'
import type { KnowledgeDomain } from '@/types/knowledge'

const KNOWLEDGE_FILE_ACCEPT = [
  '.md', '.markdown', '.txt', '.log', '.csv', '.tsv', '.html', '.htm', '.json',
  '.pdf', '.docx', '.pptx', '.xlsx',
  '.cs', '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.sql',
  '.ps1', '.sh', '.xml', '.yaml', '.yml', '.toml', '.ini',
].join(',')

/** 旧版 Office 格式（解析链不支持）：文件选择框的 accept 已过滤，拖拽/绕过路径在这里兜底 */
const LEGACY_OFFICE_RE = /\.(doc|xls|ppt)$/i

export function KnowledgeCollectionPanel({ domain }: { domain: KnowledgeDomain }) {
  const { t } = useTranslation()
  const collections = useKnowledgeStore((state) => state.collections)
  const selectedCollectionId = useKnowledgeStore((state) => state.selectedCollectionId)
  const setCollection = useKnowledgeStore((state) => state.setCollection)
  const createCollection = useKnowledgeStore((state) => state.createCollection)
  const upload = useKnowledgeStore((state) => state.upload)
  const indexWorkspace = useKnowledgeStore((state) => state.indexWorkspace)
  const capabilities = useKnowledgeStore((state) => state.capabilities)
  const mutating = useKnowledgeStore((state) => state.mutating)
  const activeIngestionJob = useKnowledgeStore((state) => state.activeIngestionJob)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [showWorkspaceImport, setShowWorkspaceImport] = useState(false)
  const [rootIndex, setRootIndex] = useState(0)
  const [relativePath, setRelativePath] = useState('.')
  const [creatingNote, setCreatingNote] = useState(false)
  const [noteTitle, setNoteTitle] = useState('')
  const [noteContent, setNoteContent] = useState('')
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const visible = domain === 'online' ? collections.online : collections.local
  const selected = visible.find((collection) => collection.id === selectedCollectionId)

  const submitCollection = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    await createCollection(trimmed)
    setName('')
    setCreating(false)
  }

  const pickFile = async (file?: File) => {
    if (!file || !selectedCollectionId) return
    if (LEGACY_OFFICE_RE.test(file.name)) {
      const extension = file.name.slice(file.name.lastIndexOf('.'))
      toast.error(t('knowledge.collection.legacyOfficeError', { extension }), {
        description: t('knowledge.collection.legacyOfficeHint'),
      })
      if (fileInput.current) fileInput.current.value = ''
      return
    }
    setUploadingFileName(file.name)
    try {
      await upload(selectedCollectionId, file)
    } finally {
      setUploadingFileName(null)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const createNote = async () => {
    const title = noteTitle.trim()
    if (!title || !noteContent.trim() || !selectedCollectionId) return
    const safeName = `${title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)}.md`
    await upload(selectedCollectionId, new File([`# ${title}\n\n${noteContent.trim()}\n`], safeName, { type: 'text/markdown' }))
    setNoteTitle(''); setNoteContent(''); setCreatingNote(false)
  }

  return (
    <aside className="ww-kb-collections" data-testid="knowledge-collections-panel" aria-label={t('knowledge.collection.panelAriaLabel')} onDragOver={(event) => { if (domain !== 'both' && selected) event.preventDefault() }} onDrop={(event) => { event.preventDefault(); if (domain !== 'both' && selected) void pickFile(event.dataTransfer.files[0]) }}>
      <div className="ww-kb-panel-kicker">
        <span>{t('knowledge.collection.title')}</span>
        {domain !== 'both' && (
          <button type="button" onClick={() => setCreating(true)} title={t('knowledge.collection.createNewTitle')}>
            <FolderPlus size={15} />
          </button>
        )}
      </div>

      <button
        type="button"
        className={!selectedCollectionId ? 'ww-kb-collection is-active' : 'ww-kb-collection'}
        onClick={() => setCollection(null)}
      >
        {domain === 'online' ? <Cloud size={15} /> : <Folder size={15} />}
        <span><b>{t('knowledge.collection.allKnowledge')}</b><small>{domain === 'both' ? t('knowledge.collection.scopeBoth') : domain === 'online' ? t('knowledge.collection.scopeOnline') : t('knowledge.collection.scopeLocal')}</small></span>
      </button>

      {domain === 'both' && (
        <>
          <div className="ww-kb-scope-note">{t('knowledge.collection.bothScopeNote')}</div>
          <div className="ww-kb-domain-tree-label"><Folder size={12} /> {t('knowledge.collection.domainLocal')} <b>{collections.local.length}</b></div>
          {collections.local.map((collection) => (
            <button type="button" key={collection.id} className="ww-kb-collection" onClick={() => { useKnowledgeStore.getState().setDomain('local'); setCollection(collection.id) }}>
              <Folder size={15} /><span><b>{collection.name}</b><small>{collection.description || collection.provider}</small></span>
            </button>
          ))}
          <div className="ww-kb-domain-tree-label is-online"><Cloud size={12} /> {t('knowledge.collection.domainOnline')} <b>{collections.online.length}</b></div>
          {collections.online.map((collection) => (
            <button type="button" key={collection.id} className="ww-kb-collection" onClick={() => { useKnowledgeStore.getState().setDomain('online'); setCollection(collection.id) }}>
              <Cloud size={15} /><span><b>{collection.name}</b><small>{collection.description || collection.provider}</small></span>
            </button>
          ))}
        </>
      )}

      {domain !== 'both' && visible.map((collection) => (
        <button
          type="button"
          key={collection.id}
          className={selectedCollectionId === collection.id ? 'ww-kb-collection is-active' : 'ww-kb-collection'}
          onClick={() => setCollection(collection.id)}
        >
          <Folder size={15} />
          <span><b>{collection.name}</b><small>{collection.description || collection.provider}</small></span>
        </button>
      ))}

      {domain !== 'both' && visible.length === 0 && (
        <div className="ww-kb-empty-collection">
          <span>{domain === 'online' ? t('knowledge.collection.emptyOnline') : t('knowledge.collection.emptyLocal')}</span>
          <button type="button" onClick={() => setCreating(true)}><Plus size={13} /> {t('knowledge.collection.createFirst')}</button>
        </div>
      )}

      {creating && (
        <div className="ww-kb-create-collection">
          <div><span>{t('knowledge.collection.createDialogTitle')}</span><button type="button" onClick={() => setCreating(false)}><X size={14} /></button></div>
          <input
            autoFocus
            value={name}
            maxLength={80}
            placeholder={t('knowledge.collection.createPlaceholder')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void submitCollection() }}
          />
          <button type="button" disabled={!name.trim() || mutating} onClick={() => void submitCollection()}>
            {mutating ? <LoaderCircle className="ww-kb-spin" size={14} /> : <FolderPlus size={14} />} {t('knowledge.collection.create')}
          </button>
        </div>
      )}

      <div className="ww-kb-collection-actions">
        <input ref={fileInput} type="file" accept={KNOWLEDGE_FILE_ACCEPT} hidden onChange={(event) => void pickFile(event.target.files?.[0])} />
        <button
          type="button"
          disabled={domain === 'both' || !selected || mutating}
          onClick={() => fileInput.current?.click()}
        >
          {mutating ? <LoaderCircle className="ww-kb-spin" size={15} /> : <FileUp size={15} />}
          {selected ? t('knowledge.collection.importIntoNamed', { name: selected.name }) : t('knowledge.collection.importInto')}
        </button>
        <button type="button" disabled={domain === 'both' || !selected || mutating} onClick={() => setCreatingNote(true)}><FilePlus2 size={15} />{t('knowledge.collection.newNote')}</button>
        <button
          type="button"
          disabled={domain !== 'local' || !selected || mutating || !capabilities?.workspaceRoots?.length}
          onClick={() => setShowWorkspaceImport(true)}
        ><FolderInput size={15} />{t('knowledge.collection.indexWorkspace')}</button>
        <small className="ww-kb-import-hint">{t('knowledge.collection.importHint')}</small>
        {uploadingFileName && !activeIngestionJob && (
          <div className="ww-kb-job-state is-running" role="status">
            <span><LoaderCircle className="ww-kb-spin" size={13} />{uploadingFileName}</span>
            <b>{t('knowledge.collection.uploading')}</b>
          </div>
        )}
        {activeIngestionJob && <div className={`ww-kb-job-state is-${activeIngestionJob.status}`}><span><LoaderCircle className={activeIngestionJob.status === 'running' ? 'ww-kb-spin' : ''} size={13} />{activeIngestionJob.sourceLabel}</span><b>{activeIngestionJob.status === 'running' ? t('knowledge.collection.jobRunning') : activeIngestionJob.status === 'succeeded' ? t('knowledge.collection.jobSucceeded') : activeIngestionJob.status}</b></div>}
      </div>

      {creatingNote && selected && createPortal(
        <div className="ww-kb-note-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreatingNote(false) }}>
          <section className="ww-kb-create-note" role="dialog" aria-modal="true" aria-label={t('knowledge.collection.noteDialogAriaLabel')}>
            <div className="ww-kb-create-note__header">
              <div><FilePlus2 size={17} /><span><b>{t('knowledge.collection.noteDialogTitle')}</b><small>{t('knowledge.collection.noteDialogSubtitle')}</small></span></div>
              <button type="button" onClick={() => setCreatingNote(false)} aria-label={t('knowledge.collection.noteDialogClose')}><X size={17} /></button>
            </div>
            <label className="ww-kb-create-note__field">
              <span>{t('knowledge.collection.noteTitleLabel')}</span>
              <input autoFocus value={noteTitle} maxLength={80} onChange={(event) => setNoteTitle(event.target.value)} placeholder={t('knowledge.collection.noteTitlePlaceholder')} />
            </label>
            <label className="ww-kb-create-note__field ww-kb-create-note__body">
              <span>{t('knowledge.collection.noteBodyLabel')} <small>{t('knowledge.collection.noteBodyHint')}</small></span>
              <textarea value={noteContent} onChange={(event) => setNoteContent(event.target.value)} placeholder={t('knowledge.collection.noteBodyPlaceholder')} />
            </label>
            <div className="ww-kb-create-note__footer">
              <small>{noteContent.length.toLocaleString()} {t('knowledge.collection.characters')}</small>
              <span><button type="button" onClick={() => setCreatingNote(false)}>{t('knowledge.collection.cancel')}</button><button type="button" className="is-primary" disabled={!noteTitle.trim() || !noteContent.trim() || mutating} onClick={() => void createNote()}>{mutating ? <LoaderCircle className="ww-kb-spin" size={14} /> : <FilePlus2 size={14} />}{t('knowledge.collection.createNote')}</button></span>
            </div>
          </section>
        </div>,
        document.body,
      )}

      {showWorkspaceImport && selected && (
        <div className="ww-kb-workspace-import">
          <div><b>{t('knowledge.collection.workspaceImportTitle')}</b><button type="button" onClick={() => setShowWorkspaceImport(false)}><X size={14} /></button></div>
          <p>{t('knowledge.collection.workspaceImportDescription')}</p>
          <label>{t('knowledge.collection.workspaceRootLabel')}<select value={rootIndex} onChange={(event) => setRootIndex(Number(event.target.value))}>
            {(capabilities?.workspaceRoots || []).map((root) => <option key={root.index} value={root.index}>{root.label}</option>)}
          </select></label>
          <label>{t('knowledge.collection.workspaceRelativeLabel')}<input value={relativePath} onChange={(event) => setRelativePath(event.target.value)} placeholder={t('knowledge.collection.workspaceRelativePlaceholder')} /></label>
          <button type="button" disabled={!relativePath.trim() || mutating} onClick={() => void indexWorkspace(selected.id, rootIndex, relativePath).then(() => setShowWorkspaceImport(false))}>
            {mutating ? <LoaderCircle className="ww-kb-spin" size={14} /> : <FolderInput size={14} />}{t('knowledge.collection.startIndexing')}
          </button>
        </div>
      )}
    </aside>
  )
}

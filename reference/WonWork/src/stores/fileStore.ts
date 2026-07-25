import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { FileAttachmentDto, WorkspaceUploadResult } from '@/types/mescli'
import { readFile } from '@/utils/fileReader'
import { attachmentApi, workspaceApi, IS_STANDALONE } from '@/api/client'

interface FilePermissionState {
  mode: 'prompt' | 'session' | 'always'
  alwaysAllowedFiles: string[]
}

interface FileStoreState {
  attachments: FileAttachmentDto[]
  pendingAttachments: FileAttachmentDto[]
  permission: FilePermissionState
  isPermissionModalOpen: boolean
  pendingPermissionFiles: File[]
  isReadingFiles: boolean

  addPendingFiles: (files: File[]) => Promise<void>
  removePendingFile: (id: string) => void
  clearPendingFiles: () => void
  commitPendingFiles: (conversationId: number, attachmentIds?: string[], files?: FileAttachmentDto[]) => Promise<void>
  loadConversationAttachments: (conversationId: number) => Promise<void>
  removeAttachment: (id: string) => Promise<void>

  setPermissionMode: (mode: FilePermissionState['mode']) => void
  openPermissionModal: (files: File[]) => void
  closePermissionModal: () => void
  grantPendingFiles: (allowAll: boolean) => Promise<void>
  denyPendingFiles: () => void
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function getFileType(mimeType: string, name: string): FileAttachmentDto['type'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (
    mimeType.startsWith('text/') ||
    name.endsWith('.txt') ||
    name.endsWith('.md') ||
    name.endsWith('.csv') ||
    name.endsWith('.json') ||
    name.endsWith('.xml') ||
    name.endsWith('.log')
  )
    return 'text'
  if (
    mimeType.includes('pdf') ||
    mimeType.includes('word') ||
    mimeType.includes('excel') ||
    mimeType.includes('sheet') ||
    name.endsWith('.pdf') ||
    name.endsWith('.docx') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls')
  )
    return 'document'
  return 'unknown'
}

async function uploadWorkspaceFiles(
  files: File[],
  set: (
    fn: (state: { pendingAttachments: FileAttachmentDto[]; isReadingFiles: boolean }) => Partial<FileStoreState>
  ) => void
): Promise<void> {
  set(() => ({ isReadingFiles: true }))
  const newAttachments: FileAttachmentDto[] = []

  for (const file of files) {
    try {
      const result: WorkspaceUploadResult = await workspaceApi.upload(file)
      const isImage = file.type.startsWith('image/')

      // 图片仍需在当前轮以 base64 形式被模型"看见"
      let imageData = ''
      let previewUrl: string | undefined
      if (isImage) {
        try {
          const readResult = await readFile(file)
          imageData = readResult.data
          previewUrl = readResult.previewUrl
        } catch (err) {
          console.error('读取图片预览失败:', file.name, err)
        }
      }

      newAttachments.push({
        id: generateId(),
        name: result.name || file.name,
        type: getFileType(result.mimeType || file.type, result.name || file.name),
        mimeType: result.mimeType || file.type || 'application/octet-stream',
        size: result.sizeBytes,
        data: imageData,
        previewUrl,
        workspacePath: result.path,
        workspaceStatus: result.status === 'ready' ? 'ready' : 'processing',
        isWorkspaceUpload: true,
        createdAt: result.createdAt || new Date().toISOString(),
      })
    } catch (err) {
      console.error('上传文件到工作区失败:', file.name, err)
      if (IS_STANDALONE) {
        // Standalone 回退（打磨任务2 S3）：VFS 上传失败时退回内联暂存，保证内容仍能进入上下文
        try {
          const result = await readFile(file)
          newAttachments.push({
            id: generateId(),
            name: result.name,
            type: result.type,
            mimeType: result.mimeType,
            size: result.size,
            data: result.data,
            previewUrl: result.previewUrl,
            createdAt: new Date().toISOString(),
          })
          continue
        } catch (fallbackErr) {
          console.error('内联暂存回退也失败:', file.name, fallbackErr)
        }
      }
      newAttachments.push({
        id: generateId(),
        name: file.name,
        type: 'unknown',
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        data: `[工作区上传失败: ${file.name}]`,
        workspaceStatus: 'error',
        isWorkspaceUpload: true,
        createdAt: new Date().toISOString(),
      })
    }
  }

  set((s) => ({
    pendingAttachments: [...s.pendingAttachments, ...newAttachments],
    isReadingFiles: false,
  }))
}

async function stageFilesForMode(
  files: File[],
  set: (
    fn: (state: { pendingAttachments: FileAttachmentDto[]; isReadingFiles: boolean }) => Partial<FileStoreState>
  ) => void
): Promise<void> {
  // 打磨任务2 S3：Standalone 与 MESCLI 统一走工作区上传（前端闭环写 IndexedDB VFS），
  // 上传失败时 uploadWorkspaceFiles 内部回退到内联暂存
  await uploadWorkspaceFiles(files, set)
}

export const useFileStore = create<FileStoreState>()(
  persist(
    (set, get) => ({
      attachments: [],
      pendingAttachments: [],
      permission: { mode: 'prompt', alwaysAllowedFiles: [] },
      isPermissionModalOpen: false,
      pendingPermissionFiles: [],
      isReadingFiles: false,

      addPendingFiles: async (files) => {
        const { permission } = get()

        if (permission.mode === 'always' || permission.mode === 'session') {
          await stageFilesForMode(files, set)
          return
        }

        set({ isPermissionModalOpen: true, pendingPermissionFiles: files })
      },

      removePendingFile: (id) => {
        set((s) => {
          const removed = s.pendingAttachments.find((a) => a.id === id)
          if (removed?.previewUrl) {
            URL.revokeObjectURL(removed.previewUrl)
          }
          return {
            pendingAttachments: s.pendingAttachments.filter((a) => a.id !== id),
          }
        })
      },

      clearPendingFiles: () => {
        set((s) => {
          for (const att of s.pendingAttachments) {
            if (att.previewUrl) URL.revokeObjectURL(att.previewUrl)
          }
          return { pendingAttachments: [] }
        })
      },

      commitPendingFiles: async (conversationId, attachmentIds, files) => {
        const { pendingAttachments } = get()
        const toCommit = files
          ? files
          : attachmentIds
            ? pendingAttachments.filter((a) => attachmentIds.includes(a.id))
            : pendingAttachments

        if (toCommit.length === 0) return

        const committed = toCommit.map((att) => ({
          ...att,
          conversationId,
        }))

        for (const att of committed) {
          // Workspace 上传已在后端持久化，仅 legacy base64 附件需要旧 attachmentApi
          if (att.isWorkspaceUpload) continue

          try {
            await attachmentApi.upload(conversationId, att)
          } catch (err) {
            console.error('上传附件失败:', att.name, err)
          }
        }

        set((s) => ({
          attachments: [...s.attachments, ...committed],
          pendingAttachments: s.pendingAttachments.filter(
            (a) => !committed.some((c) => c.id === a.id)
          ),
        }))
      },

      loadConversationAttachments: async (conversationId) => {
        try {
          const attachments = await attachmentApi.getAttachments(conversationId)
          set({ attachments })
        } catch (err) {
          console.error('加载附件失败:', err)
          set({ attachments: [] })
        }
      },

      removeAttachment: async (id) => {
        const { attachments } = get()
        const removed = attachments.find((a) => a.id === id)
        if (removed?.previewUrl) {
          URL.revokeObjectURL(removed.previewUrl)
        }

        try {
          await attachmentApi.deleteAttachment(id)
        } catch (err) {
          console.error('删除附件失败:', err)
        }

        set((s) => ({
          attachments: s.attachments.filter((a) => a.id !== id),
        }))
      },

      setPermissionMode: (mode) => {
        set((s) => ({ permission: { ...s.permission, mode } }))
      },

      openPermissionModal: (files) => {
        set({ isPermissionModalOpen: true, pendingPermissionFiles: files })
      },

      closePermissionModal: () => {
        set({ isPermissionModalOpen: false, pendingPermissionFiles: [] })
      },

      grantPendingFiles: async (allowAll) => {
        const { pendingPermissionFiles } = get()
        if (pendingPermissionFiles.length === 0) {
          set({ isPermissionModalOpen: false })
          return
        }

        if (allowAll) {
          set((s) => ({
            permission: { ...s.permission, mode: 'session' },
          }))
        }

        await stageFilesForMode(pendingPermissionFiles, set)
        set({ isPermissionModalOpen: false, pendingPermissionFiles: [] })
      },

      denyPendingFiles: () => {
        set({ isPermissionModalOpen: false, pendingPermissionFiles: [] })
      },
    }),
    {
      name: 'wonclaw-file-permissions',
      partialize: (state) => ({ permission: state.permission }),
    }
  )
)

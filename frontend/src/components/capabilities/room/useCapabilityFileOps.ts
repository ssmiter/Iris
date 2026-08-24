import { useState } from 'react'
import {
  capabilityAdminApi,
  IrisApiError,
  type CapabilityFileOperationResult,
} from '@/api/irisApi'
import { notify } from '@/components/ui'
import { invalidateAll } from '@/domain/capability/capabilityCenterCache'
import {
  childPathOf,
  fileNameOf,
  isValidMachineName,
  parentPathOf,
} from '@/domain/capability/treeUtils'

export interface MoveTarget {
  path: string
  x: number
  y: number
}

/**
 * 能力房文件编排操作（docs/39 §6 从壳拆出）：剪切/粘贴、移动到（含撤销）、
 * 重命名、删除。语义与原 CapabilityExplorer 完全一致，纯移动。
 */
export function useCapabilityFileOps({
  clipboard,
  setClipboard,
  selectedPath,
  treeTitleOf,
  afterMutation,
  setSelection,
  setCursorPath,
  closeDetail,
}: {
  clipboard: { mode: 'cut' | 'copy'; paths: string[] } | null
  setClipboard: (
    value: { mode: 'cut' | 'copy'; paths: string[] } | null,
  ) => void
  selectedPath: string
  treeTitleOf: (path: string) => string
  /** 变更成功后的统一善后：缓存失效 + 搜索范围重置 + 树/收藏/清单重拉。 */
  afterMutation: () => Promise<void>
  setSelection: (paths: ReadonlySet<string>) => void
  setCursorPath: (path: string | null) => void
  closeDetail: () => void
}) {
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleteCandidates, setDeleteCandidates] = useState<string[] | null>(
    null,
  )
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null)

  const cutItems = (paths: string[]) => {
    setClipboard({ mode: 'cut', paths })
    setSelection(new Set(paths))
    setCursorPath(paths[paths.length - 1])
  }

  const copyItems = (paths: string[]) => {
    setClipboard({ mode: 'copy', paths })
    notify.success(`已复制 ${paths.length} 项`)
  }

  const handleFileOpError = (error: Error, operation: string) => {
    if (error instanceof IrisApiError) {
      if (error.code === 'already_exists') {
        notify.error('名称冲突', {
          description: '目标位置已存在同名能力，请手动改名后再试。',
        })
        return
      }
      if (error.code === 'not_file_truth') {
        notify.error('无法操作该对象', {
          description: '只有文件真相对象才能移动、复制或重命名。',
        })
        return
      }
      if (error.code === 'out_of_extension_root') {
        notify.error('超出允许范围', {
          description: '操作越过了已登记的能力拓展根目录。',
        })
        return
      }
    }
    notify.error(`${operation}失败`, { description: error.message })
  }

  const pasteTo = async (targetDir: string) => {
    if (!clipboard || clipboard.paths.length === 0) return
    const ops: Promise<CapabilityFileOperationResult>[] = []
    for (const sourcePath of clipboard.paths) {
      const sourceDir = parentPathOf(sourcePath)
      const isSameDir = sourceDir === targetDir
      if (clipboard.mode === 'cut' && !isSameDir) {
        ops.push(capabilityAdminApi.moveFile(sourcePath, targetDir))
      } else {
        ops.push(capabilityAdminApi.copyFile(sourcePath, targetDir))
      }
    }
    try {
      await Promise.all(ops)
      if (clipboard.mode === 'cut') setClipboard(null)
      await afterMutation()
    } catch (error) {
      handleFileOpError(error as Error, '粘贴')
    }
  }

  const requestMove = (path: string, x: number, y: number) =>
    setMoveTarget({ path, x, y })
  const closeMove = () => setMoveTarget(null)

  /** 「移动到…」浮层确认：移动成功后 toast 带「撤销」（再 move 回去）。 */
  const moveItemTo = async (sourcePath: string, targetDir: string) => {
    const fromDir = parentPathOf(sourcePath)
    const targetTitle = treeTitleOf(targetDir)
    try {
      await capabilityAdminApi.moveFile(sourcePath, targetDir)
      setMoveTarget(null)
      closeDetail()
      await afterMutation()
      const newPath = childPathOf(targetDir, fileNameOf(sourcePath))
      notify.success(`已移到「${targetTitle}」`, {
        action: {
          label: '撤销',
          onClick: () => void undoMove(newPath, fromDir),
        },
      })
    } catch (error) {
      handleFileOpError(error as Error, '移动')
    }
  }

  const undoMove = async (newPath: string, fromDir: string) => {
    try {
      await capabilityAdminApi.moveFile(newPath, fromDir)
      await afterMutation()
      notify.success('已移回原位')
    } catch (error) {
      handleFileOpError(error as Error, '撤销移动')
    }
  }

  const startRename = (path: string, currentName: string) => {
    setRenamingPath(path)
    setRenameDraft(currentName)
  }

  const cancelRename = () => {
    setRenamingPath(null)
    setRenameDraft('')
  }

  const commitRename = async () => {
    if (!renamingPath) return
    const trimmed = renameDraft.trim()
    if (trimmed === fileNameOf(renamingPath)) {
      setRenamingPath(null)
      return
    }
    if (!isValidMachineName(trimmed)) {
      notify.error('名称格式不对', {
        description: '请使用小写、数字、短横线或下划线的机器名（如 my-tool）。',
      })
      return
    }
    try {
      await capabilityAdminApi.renameFile(renamingPath, trimmed)
      setRenamingPath(null)
      // 重命名后旧路径失效，详情层若正开着该对象会拿到 null——
      // 主动关掉，避免 detailPath 残留导致下一次 Esc 被空消费。
      closeDetail()
      await afterMutation()
    } catch (error) {
      handleFileOpError(error as Error, '重命名')
    }
  }

  const confirmDelete = (paths: string[]) => setDeleteCandidates(paths)
  const dismissDelete = () => setDeleteCandidates(null)

  const doDelete = async () => {
    if (!deleteCandidates || deleteCandidates.length === 0) return
    try {
      await Promise.all(
        deleteCandidates.map((path) => capabilityAdminApi.deleteFile(path)),
      )
      setDeleteCandidates(null)
      closeDetail()
      await afterMutation()
    } catch (error) {
      handleFileOpError(error as Error, '删除')
    }
  }

  return {
    cutItems,
    copyItems,
    pasteTo,
    renamingPath,
    renameDraft,
    setRenameDraft,
    startRename,
    cancelRename,
    commitRename,
    deleteCandidates,
    confirmDelete,
    dismissDelete,
    doDelete,
    moveTarget,
    requestMove,
    closeMove,
    moveItemTo,
  }
}

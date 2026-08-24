import { Button, Modal, ModalClose } from '@/components/ui'

/**
 * 删除确认（docs/39 §4）：沿用既有确认 Modal，补人话后果陈述块
 * （蓝图 .mcon 手法），「算了」永远在场。
 */
export function DeleteConfirmModal({
  candidates,
  nameOf,
  onDismiss,
  onConfirm,
}: {
  candidates: string[] | null
  nameOf: (path: string) => string
  onDismiss: () => void
  onConfirm: () => void
}) {
  return (
    <Modal
      open={candidates != null}
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
      title="确认删除"
      description="这些文件将从磁盘删除。"
      size="sm"
      footer={
        <>
          <ModalClose asChild>
            <Button variant="ghost" size="sm" className="press">
              算了
            </Button>
          </ModalClose>
          <Button
            variant="danger"
            size="sm"
            className="press"
            onClick={onConfirm}
          >
            删除
          </Button>
        </>
      }
    >
      {candidates && (
        <div className="grid gap-3">
          <ul className="grid max-h-64 gap-2 overflow-auto">
            {candidates.map((path) => (
              <li
                key={path}
                className="rounded-sm border border-danger/20 bg-danger-soft px-3 py-2 text-small text-danger-foreground"
              >
                <div className="font-medium">{nameOf(path)}</div>
                <code className="text-caption text-ink-muted">{path}</code>
              </li>
            ))}
          </ul>
          <div className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-small leading-relaxed text-ink-subtle">
            正在使用它的任务会失败；文件仍可从 git 历史或文件系统恢复。
          </div>
        </div>
      )}
    </Modal>
  )
}

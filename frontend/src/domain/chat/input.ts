export type PermissionMode = 'bypass' | 'auto' | 'confirm' | 'sandbox'

export interface PendingSupplement {
  clientRequestId: string
  supplementId: string | null
  turnId: string
  text: string
  state: 'submitting' | 'pending'
}

export interface SupplementView {
  supplementId: string
  turnId: string
  messageId: string | null
  state: 'pending' | 'injected' | 'cancelled' | 'promoted'
  text: string
  attachmentRefs: string[]
  injectedAfterRoundId: string | null
  acceptedAt: string
  updatedAt: string
  version: number
}

export const permissionModeOptions: ReadonlyArray<{
  value: PermissionMode
  label: string
  description: string
}> = [
  {
    value: 'bypass',
    label: '尽量自动',
    description: '无副作用操作尽量自动，外部写入仍会确认',
  },
  {
    value: 'auto',
    label: '平衡',
    description: '常规只读自动，高影响操作会确认',
  },
  {
    value: 'confirm',
    label: '每步确认',
    description: '包括只读工具在内，每一步都先确认',
  },
  {
    value: 'sandbox',
    label: '只读',
    description: '只允许读取，任何写入都会被拒绝',
  },
]

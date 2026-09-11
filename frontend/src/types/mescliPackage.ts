export type MescliPackageVersionState = 'Inactive' | 'Previous' | 'Active'

export interface MescliPackageListItem {
  packageId: string
  version: string
  systemCode: string
  displayName: string
  state: MescliPackageVersionState
  isEnabled: boolean
  installedAtUtc: string
}

export interface MescliPackageSystemItem {
  systemCode: string
  displayName: string
  isEnabled: boolean
}

export interface MescliPackageMutationResponse {
  packageId: string
  action: string
  restartRequired: boolean
  version?: string
  /** r379 热装：true=已装载（新对话生效）；false=需重启 */
  hotLoaded?: boolean
  /** 后端如实语义文案（"已热装，新对话生效。" / "热装失败（…），重启后生效。"），直接吐司 */
  detail?: string
}

export interface MescliPackageUpdate {
  packageId: string
  version: string
  displayName?: string
}

/** Code 一键拉取（2026-08-20）：outcome 与后端 MescliPackagePullOutcomes 对齐 */
export type MescliPackagePullOutcome = 'installed' | 'already_installed' | 'up_to_date' | 'failed'

export interface MescliPackagePullItem {
  packageId: string
  version: string
  outcome: MescliPackagePullOutcome
  detail?: string
}

export interface MescliPackagePullResponse {
  customer?: string
  items: MescliPackagePullItem[]
  restartRequired: boolean
}

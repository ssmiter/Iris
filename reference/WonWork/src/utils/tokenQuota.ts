export function formatTokenQuota(
  value: number | null | undefined,
  unavailableLabel: string,
): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString()
    : unavailableLabel
}

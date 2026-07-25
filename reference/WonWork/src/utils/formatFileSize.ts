/**
 * 统一的文件大小格式化工具。
 * 注意：始终保留单位与数字之间的一个空格，保持 UI 一致性。
 */
export function formatFileSize(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * 日期工具函数
 */

export function getLocalMonthYear(): string {
  const now = new Date()
  return `${now.getFullYear()}年${now.getMonth() + 1}月`
}

export function getLocalISODate(): string {
  return new Date().toISOString().slice(0, 10)
}

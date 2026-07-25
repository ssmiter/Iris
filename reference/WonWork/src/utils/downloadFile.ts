/**
 * 统一下载工具
 *
 * 使用 <a download> 触发浏览器原生下载，避免 window.open 被拦截或在新标签打开。
 * 若 download 属性不支持（跨域），降级为 window.open。
 */

export function downloadFile(url: string, fileName?: string): void {
  // 尝试使用 <a download> 触发原生下载
  const a = document.createElement('a')
  a.href = url
  if (fileName) {
    a.download = fileName
  }
  a.style.display = 'none'
  document.body.appendChild(a)

  try {
    a.click()
  } catch {
    // 若 click 被拦截或失败，降级为 window.open
    window.open(url, '_blank')
  } finally {
    // 延迟清理，确保 click 事件已处理
    setTimeout(() => {
      document.body.removeChild(a)
    }, 100)
  }
}

/**
 * 从 URL 或路径中提取文件名
 */
export function extractFileName(url: string, fallback = 'download'): string {
  try {
    const urlObj = new URL(url, window.location.origin)
    const path = urlObj.pathname
    const name = path.split('/').pop()
    return name || fallback
  } catch {
    // 若不是有效 URL，尝试从路径提取
    const name = url.split('/').pop()
    return name || fallback
  }
}

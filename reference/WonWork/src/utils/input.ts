/**
 * 输入框工具函数
 */

const DEFAULT_MAX_HEIGHT = 200

/**
 * 根据内容自动调整 textarea 高度。
 * @param el textarea 元素
 * @param maxHeight 最大高度（像素），默认 200
 */
export function adjustTextareaHeight(el: HTMLTextAreaElement, maxHeight = DEFAULT_MAX_HEIGHT): void {
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
}

/**
 * 重置 textarea 高度到最小。
 * @param el textarea 元素
 */
export function resetTextareaHeight(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
}

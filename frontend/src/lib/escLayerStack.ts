/**
 * 全局 Esc 层栈（docs/07 §18.4）：任一时刻多个浮层共存时，
 * Esc 只关闭最上层。层在打开时注册、关闭时注销；栈是唯一事实，
 * 各层互不探测。Radix Dialog 内部已消费 Esc，不入栈。
 *
 * 监听挂在 window capture 阶段：先于 document 上 Radix 的监听执行，
 * 有自管层消费时 stopPropagation，保证一次 Esc 不同时关两层。
 */

interface Layer {
  id: string
  close: () => void
}

const layers: Layer[] = []
let installed = false

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing) return
  const top = layers[layers.length - 1]
  if (!top) return
  event.preventDefault()
  event.stopPropagation()
  top.close()
}

function install() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', onKeyDown, true)
}

/** 注册一层，返回注销函数（必须在关闭路径上调用）。 */
export function pushEscLayer(layer: Layer): () => void {
  install()
  layers.push(layer)
  let active = true
  return () => {
    if (!active) return
    active = false
    const index = layers.indexOf(layer)
    if (index >= 0) layers.splice(index, 1)
  }
}

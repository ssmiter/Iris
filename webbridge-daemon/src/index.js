/**
 * Iris WebBridge daemon（骨架，docs/05）。
 *
 * 职责：驱动真实 Chrome（借窗模式），把页面状态与动作结果提供给后端。
 * 安全：只监听 127.0.0.1 + 本机令牌；敏感字段值不进状态摘要与日志。
 *
 * 起步建议：也可以先用 Java + Playwright 并入后端（少一个进程），
 * 需要附着用户日常 Chrome（登录态/扩展）时再拆出本进程走 CDP。
 */
import http from 'node:http'

const PORT = 9223
const TOKEN = process.env.IRIS_BRIDGE_TOKEN || 'dev-token'

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  if (req.headers.authorization !== `Bearer ${TOKEN}` && url.pathname !== '/status') {
    return json(res, 401, { ok: false, error: 'unauthorized' })
  }

  switch (url.pathname) {
    case '/status':
      // 构建冒烟用：存活/版本/当前页
      return json(res, 200, { ok: true, version: '0.1.0', pages: [] })
    case '/open':
      // TODO(M4)：CDP 打开/附着页面 → { pageId }
      return json(res, 501, { ok: false, error: 'not implemented (M4)' })
    case '/state':
      // TODO(M4)：页面状态摘要（AX 树：交互元素 + 文本 + 表单字段）
      return json(res, 501, { ok: false, error: 'not implemented (M4)' })
    default:
      return json(res, 404, { ok: false, error: 'not found' })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[webbridge] listening on 127.0.0.1:${PORT}`)
})

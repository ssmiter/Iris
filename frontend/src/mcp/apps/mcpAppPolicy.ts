export interface McpAppResource {
  uri: string
  mimeType: string
  html: string
  allowedOrigins: string[]
}

export interface McpAppResourceValidation { valid: boolean; reasons: string[] }

const MAX_RESOURCE_BYTES = 1_000_000
const EXTERNAL_REFERENCE = /(?:src|href|action)\s*=\s*["'](https?:\/\/[^/"']+)/gi

export function validateMcpAppResource(resource: McpAppResource): McpAppResourceValidation {
  const reasons: string[] = []
  if (!resource.uri.startsWith('ui://')) reasons.push('资源URI必须使用ui://。')
  if (!['text/html', 'text/html+mcp'].includes(resource.mimeType.toLowerCase())) reasons.push('资源MIME不受支持。')
  if (new TextEncoder().encode(resource.html).byteLength > MAX_RESOURCE_BYTES) reasons.push('资源超过1MB限制。')
  if (/<(?:iframe|object|embed|base)\b/i.test(resource.html)) reasons.push('资源包含禁止的嵌入元素。')
  const allowed = new Set(resource.allowedOrigins)
  for (const match of resource.html.matchAll(EXTERNAL_REFERENCE)) {
    if (!allowed.has(match[1])) reasons.push(`资源引用未批准Origin：${match[1]}。`)
  }
  return { valid: reasons.length === 0, reasons }
}

export function buildMcpAppSandbox() {
  return { sandbox: 'allow-scripts', referrerPolicy: 'no-referrer' as const, allow: '' }
}

export function wrapMcpAppHtml(resource: McpAppResource): string {
  const origins = resource.allowedOrigins.length > 0 ? ` ${resource.allowedOrigins.join(' ')}` : ''
  const policy = `default-src 'none'; script-src 'unsafe-inline'${origins}; style-src 'unsafe-inline'${origins}; img-src data: blob:${origins}; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`
  const head = `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`
  return resource.html.includes('<head>') ? resource.html.replace('<head>', `<head>${head}`) : `${head}${resource.html}`
}

import type { FileAttachmentType } from '@/types/mescli'

export interface ReadFileResult {
  name: string
  mimeType: string
  size: number
  type: FileAttachmentType
  data: string
  previewUrl?: string
}

const MAX_FILE_SIZE = 20 * 1024 * 1024

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function getFileType(mimeType: string, name: string): FileAttachmentType {
  if (mimeType.startsWith('image/')) return 'image'
  if (
    mimeType.startsWith('text/') ||
    name.endsWith('.txt') ||
    name.endsWith('.md') ||
    name.endsWith('.csv') ||
    name.endsWith('.json') ||
    name.endsWith('.xml') ||
    name.endsWith('.log')
  )
    return 'text'
  if (
    mimeType.includes('pdf') ||
    mimeType.includes('word') ||
    mimeType.includes('excel') ||
    mimeType.includes('sheet') ||
    name.endsWith('.pdf') ||
    name.endsWith('.docx') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls')
  )
    return 'document'
  return 'unknown'
}

/** 将 HTML 片段转换为 Markdown，保留文档结构 */
function htmlToMarkdown(html: string): string {
  let md = html

  // 移除 DOCTYPE、html、head、body 等标签
  md = md.replace(/<\/?(html|head|body|meta|link|style|script)[^>]*>/gi, '')

  // 标题
  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '\n# $1\n')
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '\n## $1\n')
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '\n### $1\n')
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '\n#### $1\n')
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '\n##### $1\n')
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '\n###### $1\n')

  // 粗体 / 斜体
  md = md.replace(/<(b|strong)[^>]*>(.*?)<\/(b|strong)>/gi, '**$2**')
  md = md.replace(/<(i|em)[^>]*>(.*?)<\/(i|em)>/gi, '*$2*')

  // 换行
  md = md.replace(/<br\s*\/?>/gi, '\n')

  // 有序列表
  let olIndex = 1
  md = md.replace(/<ol[^>]*>(.*?)<\/ol>/gis, (_, inner) => {
    let idx = 1
    const items = inner.replace(/<li[^>]*>(.*?)<\/li>/gis, (_m: string, item: string) => {
      const cleaned = item.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1').trim()
      return `${idx++}. ${cleaned}`
    })
    return '\n' + items + '\n'
  })

  // 无序列表
  md = md.replace(/<ul[^>]*>(.*?)<\/ul>/gis, (_, inner) => {
    const items = inner.replace(/<li[^>]*>(.*?)<\/li>/gis, (_m: string, item: string) => {
      const cleaned = item.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1').trim()
      return `- ${cleaned}`
    })
    return '\n' + items + '\n'
  })

  // 表格
  md = md.replace(/<table[^>]*>(.*?)<\/table>/gis, (_, inner) => {
    let rows: string[] = []
    const trMatches = inner.matchAll(/<tr[^>]*>(.*?)<\/tr>/gis)
    for (const trMatch of trMatches) {
      const trInner = trMatch[1]
      const cells: string[] = []
      const cellMatches = trInner.matchAll(/<(td|th)[^>]*>(.*?)<\/(td|th)>/gis)
      for (const cellMatch of cellMatches) {
        const cellContent = cellMatch[2].replace(/<[^>]+>/g, '').trim()
        cells.push(cellContent)
      }
      if (cells.length > 0) {
        rows.push(`| ${cells.join(' | ')} |`)
      }
    }
    if (rows.length > 0) {
      const separators = rows[0].split('|').map(() => '---').join('|')
      rows.splice(1, 0, separators)
    }
    return '\n' + rows.join('\n') + '\n'
  })

  // 段落
  md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, '\n$1\n')

  // 移除剩余标签
  md = md.replace(/<[^>]+>/g, '')

  // 解码 HTML 实体
  md = md.replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

  // 清理多余空行
  md = md.replace(/\n{3,}/g, '\n\n')

  return md.trim()
}

/** 将 CSV 文本转换为 Markdown 表格 */
function csvToMarkdownTable(csv: string): string {
  const lines = csv.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return ''

  const parseLine = (line: string): string[] => {
    const cells: string[] = []
    let cell = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (ch === ',' && !inQuotes) {
        cells.push(cell.trim())
        cell = ''
      } else {
        cell += ch
      }
    }
    cells.push(cell.trim())
    return cells
  }

  const rows = lines.map(parseLine)
  if (rows.length === 0) return ''

  const mdRows = rows.map((r) => `| ${r.join(' | ')} |`)
  const separators = rows[0].map(() => '---')
  mdRows.splice(1, 0, `| ${separators.join(' | ')} |`)

  return mdRows.join('\n')
}

async function extractDocxText(file: File): Promise<string> {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.convertToHtml({ arrayBuffer })
  const markdown = htmlToMarkdown(result.value)
  return `[Word文档: ${file.name}]\n${markdown}`
}

async function extractPdfText(file: File): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist')

  const arrayBuffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
  let text = `[PDF文档: ${file.name}]\n`

  for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map((item: unknown) => (item as { str: string }).str).join(' ') + '\n'
  }

  return text
}

async function extractExcelText(file: File): Promise<string> {
  const XLSX = await import('xlsx')
  const arrayBuffer = await file.arrayBuffer()
  const workbook = XLSX.read(arrayBuffer, { type: 'array' })
  let text = `[Excel文档: ${file.name}]\n`

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(sheet)
    const mdTable = csvToMarkdownTable(csv)
    text += `\n--- ${sheetName} ---\n${mdTable}\n`
  }

  return text
}

export async function readFile(file: File): Promise<ReadFileResult> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`文件 ${file.name} 超过 20MB 限制`)
  }

  const mimeType = file.type
  const name = file.name
  const size = file.size
  const type = getFileType(mimeType, name)

  if (type === 'image') {
    const base64 = await fileToBase64(file)
    return {
      name,
      mimeType,
      size,
      type: 'image',
      data: base64,
      previewUrl: URL.createObjectURL(file),
    }
  }

  if (type === 'text') {
    const text = await file.text()
    return {
      name,
      mimeType,
      size,
      type: 'text',
      data: text,
    }
  }

  if (name.endsWith('.docx')) {
    try {
      const text = await extractDocxText(file)
      return { name, mimeType, size, type: 'document', data: text }
    } catch {
      const base64 = await fileToBase64(file)
      return { name, mimeType, size, type: 'document', data: base64 }
    }
  }

  if (name.endsWith('.pdf')) {
    try {
      const text = await extractPdfText(file)
      return { name, mimeType, size, type: 'document', data: text }
    } catch {
      const base64 = await fileToBase64(file)
      return { name, mimeType, size, type: 'document', data: base64 }
    }
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    try {
      const text = await extractExcelText(file)
      return { name, mimeType, size, type: 'document', data: text }
    } catch {
      const base64 = await fileToBase64(file)
      return { name, mimeType, size, type: 'document', data: base64 }
    }
  }

  if (size < 1024 * 1024) {
    try {
      const text = await file.text()
      return { name, mimeType, size, type: 'text', data: text }
    } catch {
      const base64 = await fileToBase64(file)
      return { name, mimeType, size, type: 'unknown', data: base64 }
    }
  }

  const base64 = await fileToBase64(file)
  return { name, mimeType, size, type: 'unknown', data: base64 }
}

/** 后端下载链接已经是 /downloads/ 绝对路径，直接返回即可 */
export function resolveDownloadUrl(url: string): string {
  return url
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

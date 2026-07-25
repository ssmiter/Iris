import type { TaskStatus, TaskProgressItem } from '@/types/mescli'

const TASK_PATTERNS = [
  /^-\s*\[([ xX])\]\s*(.+)$/,
  /^\d+\.\s*\[(PENDING|RUNNING|DONE|COMPLETED|ERROR)\]\s*(.+)$/i,
  /^\[(PENDING|RUNNING|DONE|COMPLETED|ERROR)\]\s*(.+)$/i,
  /<task\s+status="(pending|running|completed|error)"\s*>([\s\S]*?)<\/task>/i,
]

function parseStatus(statusChar: string): TaskStatus {
  const s = statusChar.toLowerCase()
  if (s === 'x' || s === 'done' || s === 'completed') return 'completed'
  if (s === 'running') return 'running'
  if (s === 'error') return 'error'
  return 'pending'
}

export function extractTasksFromText(text: string): Omit<TaskProgressItem, 'id'>[] {
  const tasks: Omit<TaskProgressItem, 'id'>[] = []
  const seenTitles = new Set<string>()

  // 先全局提取 <task> 标签（支持多行）
  const taskTagPattern = /<task\s+status="(pending|running|completed|error)"\s*>([\s\S]*?)<\/task>/gi
  let match: RegExpExecArray | null
  while ((match = taskTagPattern.exec(text)) !== null) {
    const status = parseStatus(match[1])
    const title = match[2].replace(/\s+/g, ' ').trim()
    if (title && !seenTitles.has(title)) {
      tasks.push({ title, status })
      seenTitles.add(title)
    }
  }

  // 再逐行提取其他格式
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    for (const pattern of TASK_PATTERNS) {
      const lineMatch = trimmed.match(pattern)
      if (lineMatch) {
        const status = parseStatus(lineMatch[1])
        const title = lineMatch[2].trim()
        if (title && !seenTitles.has(title)) {
          tasks.push({ title, status })
          seenTitles.add(title)
        }
        break
      }
    }
  }

  return tasks
}

export function updateTasksFromText(
  previousTasks: TaskProgressItem[],
  fullText: string
): TaskProgressItem[] {
  const extracted = extractTasksFromText(fullText)

  if (extracted.length === 0) return previousTasks

  const titleToId = new Map(previousTasks.map((t) => [t.title, t.id]))

  // 合并策略：保留已有任务，用新提取的任务更新状态或追加新任务
  const merged = new Map<string, TaskProgressItem>()

  for (const t of previousTasks) {
    merged.set(t.title, t)
  }

  for (const [i, ext] of extracted.entries()) {
    const id = titleToId.get(ext.title) || `task-${i}-${Date.now()}`
    merged.set(ext.title, { ...ext, id })
  }

  return Array.from(merged.values())
}

/** 从文本中移除任务标记，用于清理聊天消息内容 */
export function removeTaskTags(text: string): string {
  const withoutTags = text.replace(
    /<task\s+status="(pending|running|completed|error)"\s*>([\s\S]*?)<\/task>/gi,
    ''
  )

  // 行级任务标记（- [ ] / [RUNNING] / 1. [DONE]）已抽取到任务面板，气泡不再显示原文；
  // 代码块内的行保留（模型展示 markdown 示例时不误删）
  const linePatterns = TASK_PATTERNS.slice(0, 3)
  const cleanedLines: string[] = []
  let inCodeBlock = false
  for (const line of withoutTags.split('\n')) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock
      cleanedLines.push(line)
      continue
    }
    if (!inCodeBlock && linePatterns.some((p) => p.test(line.trim()))) {
      continue
    }
    cleanedLines.push(line)
  }

  return cleanedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * diffText —— 行级文本 diff（2026-09-01 二阶段切片3，审批卡与写工具结果留痕共用）。
 *
 * 纯函数零依赖，不进模型上下文：输入两侧文本，输出 hunk 级行差异。
 * 算法=共同前后缀裁剪 + 中段 LCS（DP）；中段规模超阈值时退化为整段删/增
 * （诚实粗粒度，不装精确），大文件 diff 不会卡页面。
 */

export interface DiffLine {
  type: 'ctx' | 'add' | 'del'
  text: string
}

export interface DiffHunk {
  /** 旧文件起始行号（1-based） */
  oldStart: number
  /** 新文件起始行号（1-based） */
  newStart: number
  lines: DiffLine[]
}

export interface TextDiff {
  hunks: DiffHunk[]
  additions: number
  deletions: number
  /** 中段超阈值退化粗粒度时为 true（UI 可据此提示） */
  coarse: boolean
}

/** 中段 LCS 规模上限（单元格数）；超出退化为整段删/增 */
const MAX_LCS_CELLS = 2_000_000
/** 单 hunk 上下行文行数 */
const CONTEXT_LINES = 3

/** 全量行差异序列（未折叠）：ctx/add/del 按新旧顺序排列 */
export function diffLines(oldText: string, newText: string): { seq: DiffLine[]; coarse: boolean } {
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')

  // 共同前缀裁剪
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  // 共同后缀裁剪（不越过前缀）
  let suf = 0
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++
  }

  const aMid = a.slice(pre, a.length - suf)
  const bMid = b.slice(pre, b.length - suf)
  const coarse = aMid.length * bMid.length > MAX_LCS_CELLS

  const seq: DiffLine[] = []
  for (let i = 0; i < pre; i++) seq.push({ type: 'ctx', text: a[i] })

  if (coarse) {
    for (const t of aMid) seq.push({ type: 'del', text: t })
    for (const t of bMid) seq.push({ type: 'add', text: t })
  } else {
    for (const line of lcsDiff(aMid, bMid)) seq.push(line)
  }

  for (let i = a.length - suf; i < a.length; i++) seq.push({ type: 'ctx', text: a[i] })
  return { seq, coarse }
}

/** 中段 LCS diff：按 LCS 回溯交织输出 del/add/ctx（不是先全删后全增） */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map((t) => ({ type: 'add' as const, text: t }))
  if (m === 0) return a.map((t) => ({ type: 'del' as const, text: t }))

  // DP 表：dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度（Uint32 平铺省内存）
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i++
    } else {
      out.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}

/** 折叠成 hunks：相邻变化间隔 ≤ 2*CONTEXT 的归并为一组，两端各带 CONTEXT 行上下文 */
export function buildHunks(seq: DiffLine[], coarse: boolean): TextDiff {
  let additions = 0
  let deletions = 0
  const changedIdx: number[] = []
  seq.forEach((l, idx) => {
    if (l.type === 'add') {
      additions++
      changedIdx.push(idx)
    } else if (l.type === 'del') {
      deletions++
      changedIdx.push(idx)
    }
  })
  if (changedIdx.length === 0) return { hunks: [], additions, deletions, coarse }

  // 归并变化段
  const groups: Array<[number, number]> = []
  let gStart = changedIdx[0]
  let gEnd = changedIdx[0]
  for (let k = 1; k < changedIdx.length; k++) {
    if (changedIdx[k] - gEnd <= 2 * CONTEXT_LINES + 1) {
      gEnd = changedIdx[k]
    } else {
      groups.push([gStart, gEnd])
      gStart = changedIdx[k]
      gEnd = changedIdx[k]
    }
  }
  groups.push([gStart, gEnd])

  // 行号游标：ctx/del 消耗旧行号，ctx/add 消耗新行号
  const hunks: DiffHunk[] = []
  let cursor = 0
  let oldCursor = 1
  let newCursor = 1
  for (const [cs, ce] of groups) {
    const hunkStart = Math.max(0, cs - CONTEXT_LINES)
    const hunkEnd = Math.min(seq.length - 1, ce + CONTEXT_LINES)
    // 推进游标到 hunk 起点
    while (cursor < hunkStart) {
      if (seq[cursor].type !== 'add') oldCursor++
      if (seq[cursor].type !== 'del') newCursor++
      cursor++
    }
    const lines: DiffLine[] = []
    const hOld = oldCursor
    const hNew = newCursor
    while (cursor <= hunkEnd) {
      lines.push(seq[cursor])
      if (seq[cursor].type !== 'add') oldCursor++
      if (seq[cursor].type !== 'del') newCursor++
      cursor++
    }
    hunks.push({ oldStart: hOld, newStart: hNew, lines })
  }
  return { hunks, additions, deletions, coarse }
}

/** 一站式：文本 → hunk 视图数据 */
export function diffText(oldText: string, newText: string): TextDiff {
  const { seq, coarse } = diffLines(oldText, newText)
  return buildHunks(seq, coarse)
}

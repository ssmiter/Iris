import * as fs from 'fs'
import * as path from 'path'

function getDefaultWorkspaceRoot(): string {
  // dist/index.js -> .. -> daemon -> .. -> WonWork -> workspace
  return path.resolve(__dirname, '..', '..', 'workspace')
}

const WORKSPACE_ROOT = process.env.WEBBRIDGE_WORKSPACE || getDefaultWorkspaceRoot()

export const ALLOWED_SUBDIRS = ['downloads', 'snapshots', 'exports', 'recordings'] as const

export type WorkspaceSubdir = (typeof ALLOWED_SUBDIRS)[number]

export interface WorkspaceFileInfo {
  name: string
  path: string
  relativePath: string
  subdir: WorkspaceSubdir
  size: number
  modifiedAt: string
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>":|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120) || 'unnamed'
}

function resolveWorkspacePath(subdir: WorkspaceSubdir, filename: string): string {
  if (!ALLOWED_SUBDIRS.includes(subdir)) {
    throw new Error(`Invalid workspace subdir: ${subdir}`)
  }
  const dir = path.join(WORKSPACE_ROOT, subdir)
  fs.mkdirSync(dir, { recursive: true })
  const safeName = sanitizeFilename(path.basename(filename))
  return path.join(dir, safeName)
}

export function resolveWorkspaceFilePath(relativePath: string): string {
  const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '')
  const resolved = path.resolve(WORKSPACE_ROOT, normalized)
  const rootResolved = path.resolve(WORKSPACE_ROOT)
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    throw new Error('Path outside workspace is not allowed')
  }
  const subdir = normalized.split(/[/\\]/)[0] as WorkspaceSubdir
  if (!ALLOWED_SUBDIRS.includes(subdir)) {
    throw new Error(`Invalid workspace subdir: ${subdir}`)
  }
  return resolved
}

export async function deleteWorkspaceFile(relativePath: string): Promise<void> {
  const filePath = resolveWorkspaceFilePath(relativePath)
  await fs.promises.unlink(filePath)
}

export async function getWorkspaceFileStats(relativePath: string): Promise<{ size: number; modifiedAt: string }> {
  const filePath = resolveWorkspaceFilePath(relativePath)
  const stats = await fs.promises.stat(filePath)
  return {
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  }
}

export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT
}

export async function saveFile(
  subdir: WorkspaceSubdir,
  filename: string,
  data: string | Buffer
): Promise<{ path: string; relativePath: string; size: number }> {
  const filePath = resolveWorkspacePath(subdir, filename)
  await fs.promises.writeFile(filePath, data)
  const stats = await fs.promises.stat(filePath)
  return {
    path: filePath,
    relativePath: path.relative(WORKSPACE_ROOT, filePath),
    size: stats.size,
  }
}

export async function saveFileFromBase64(
  relativePath: string,
  base64: string
): Promise<{ path: string; relativePath: string; size: number }> {
  const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '')
  const segments = normalized.split(/[/\\]/)
  const subdir = segments[0] as WorkspaceSubdir
  if (!ALLOWED_SUBDIRS.includes(subdir)) {
    throw new Error(`Invalid workspace subdir: ${subdir}. Allowed: ${ALLOWED_SUBDIRS.join(', ')}`)
  }
  const filename = segments.slice(1).join(path.sep) || 'unnamed'
  const data = Buffer.from(base64, 'base64')
  return saveFile(subdir, filename, data)
}

export async function readFileAsBase64(relativePath: string): Promise<string> {
  const filePath = resolveWorkspaceFilePath(relativePath)
  const data = await fs.promises.readFile(filePath)
  return data.toString('base64')
}

export async function listFiles(subdir: WorkspaceSubdir): Promise<WorkspaceFileInfo[]> {
  const dir = path.join(WORKSPACE_ROOT, subdir)
  fs.mkdirSync(dir, { recursive: true })
  const entries = await fs.promises.readdir(dir, { withFileTypes: true })
  const files = entries.filter((e) => e.isFile())
  const infos: WorkspaceFileInfo[] = []
  for (const entry of files) {
    const filePath = path.join(dir, entry.name)
    const stats = await fs.promises.stat(filePath)
    infos.push({
      name: entry.name,
      path: filePath,
      relativePath: path.relative(WORKSPACE_ROOT, filePath),
      subdir,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    })
  }
  return infos.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
}

export async function listAllWorkspaceFiles(): Promise<WorkspaceFileInfo[]> {
  const all: WorkspaceFileInfo[] = []
  for (const subdir of ALLOWED_SUBDIRS) {
    const files = await listFiles(subdir)
    all.push(...files)
  }
  return all.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime())
}

export function generateTimestampedName(base: string, ext: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${sanitizeFilename(base)}_${timestamp}${ext}`
}

export async function ensureWorkspace(): Promise<void> {
  for (const subdir of ALLOWED_SUBDIRS) {
    fs.mkdirSync(path.join(WORKSPACE_ROOT, subdir), { recursive: true })
  }
}

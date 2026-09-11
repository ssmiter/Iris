import type { WorkflowDoc, WorkflowListEntry } from '@/types/workflow'
import { fetchApi } from './client'
import { standaloneWorkflowApi } from './standaloneWorkflowApi'

const IS_STANDALONE = import.meta.env.VITE_STANDALONE_MODE === 'true'

/**
 * MESCLI 模式工作流 API：通过后端 /api/workflows 读写 ~/.wonwork/workflow/<id>.json。
 * 模型侧主通道是文件原语直读直写（清单头注带目录绝对路径）；
 * 本 API 服务前端清单注入、内置同步与可视化投影。
 */
const mescliWorkflowApi = {
  listWorkflows: (): Promise<WorkflowListEntry[]> =>
    fetchApi<WorkflowListEntry[]>('/api/workflows'),

  /** 工作流根目录绝对路径（模型文件原语直读 JSON 的定位依据）；失败返回 null 降级 */
  getDir: async (): Promise<string | null> => {
    try {
      const res = await fetchApi<{ dir: string }>('/api/workflows/dir', { silent: true })
      return res.dir || null
    } catch {
      return null
    }
  },

  readWorkflow: async (id: string): Promise<WorkflowDoc | null> => {
    try {
      return await fetchApi<WorkflowDoc>(`/api/workflows/${encodeURIComponent(id)}`)
    } catch (err: any) {
      if (err.status === 404) return null
      throw err
    }
  },

  /** 保存（POST 新建 / PUT 更新由 store 层判定；后端校验闸：结构+工具存在性+泛化+version 单调）。
   *  silent 选项供内置同步等自愈型调用方使用：失败由调用方 catch 兜底，不弹 toast */
  createWorkflow: (doc: WorkflowDoc, opts?: { silent?: boolean }): Promise<{ saved: boolean; id: string; version: string }> =>
    fetchApi('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
      silent: opts?.silent,
    }),

  updateWorkflow: (doc: WorkflowDoc, opts?: { silent?: boolean }): Promise<{ saved: boolean; id: string; version: string }> =>
    fetchApi(`/api/workflows/${encodeURIComponent(doc.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
      silent: opts?.silent,
    }),

  deleteWorkflow: (id: string): Promise<void> =>
    fetchApi<void>(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** 只校验不保存（craft 自检用） */
  validateWorkflow: (doc: WorkflowDoc): Promise<{ valid: boolean; errors: string[] }> =>
    fetchApi('/api/workflows/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    }),
}

export const workflowApi = IS_STANDALONE ? standaloneWorkflowApi : mescliWorkflowApi

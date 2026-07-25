/**
 * MESCLI 模式下的 DAG Workflow API
 * 调用后端 /api/dag-workflows 实现持久化
 */

import type { DagWorkflow } from '@/types/dagWorkflow'
import { fetchApi, getAuthHeaders, API_BASE } from './client'

export const mescliDagWorkflowApi = {
  getAll: async (): Promise<DagWorkflow[]> =>
    fetchApi<DagWorkflow[]>('/api/dag-workflows'),

  getById: async (id: string): Promise<DagWorkflow | undefined> =>
    fetchApi<DagWorkflow>(`/api/dag-workflows/${id}`),

  create: async (workflow: Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'>): Promise<DagWorkflow> =>
    fetchApi<DagWorkflow>('/api/dag-workflows', {
      method: 'POST',
      body: JSON.stringify(workflow),
    }),

  update: async (id: string, updates: Partial<DagWorkflow>): Promise<DagWorkflow> =>
    fetchApi<DagWorkflow>(`/api/dag-workflows/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  delete: async (id: string): Promise<void> => {
    await fetchApi<void>(`/api/dag-workflows/${id}`, { method: 'DELETE' })
  },

  duplicate: async (id: string): Promise<DagWorkflow> =>
    fetchApi<DagWorkflow>(`/api/dag-workflows/${id}/duplicate`, { method: 'POST' }),

  /** GET /api/dag-workflows/export —— 导出当前用户的全部工作流为 JSON 文件 */
  exportAll: async (): Promise<Blob> => {
    const response = await fetch(`${API_BASE}/api/dag-workflows/export`, {
      method: 'GET',
      headers: getAuthHeaders(),
      credentials: 'include',
    })
    if (!response.ok) {
      const text = await response.text().catch(() => `HTTP ${response.status}`)
      throw new Error(text || `HTTP ${response.status}`)
    }
    return response.blob()
  },

  /** POST /api/dag-workflows/import —— 从 JSON 文件批量导入工作流 */
  import: async (jsonText: string): Promise<DagWorkflow[]> =>
    fetchApi<DagWorkflow[]>('/api/dag-workflows/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonText,
    }),
}

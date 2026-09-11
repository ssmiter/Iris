import type { WorkflowDoc } from '@/types/workflow'
import {
  listWorkflows as fsListWorkflows,
  readWorkflow as fsReadWorkflow,
  writeWorkflow as fsWriteWorkflow,
  deleteWorkflow as fsDeleteWorkflow,
} from '@/utils/workspaceStorage'

/**
 * Standalone 模式工作流 API：直接通过浏览器 File System Access API 读写本地目录
 * （workflow/{id}.json 平铺，与后端 ~/.wonwork/workflow/ 同构）。
 */
export const standaloneWorkflowApi = {
  listWorkflows: fsListWorkflows,

  /** Standalone 走浏览器 File System Access，没有可暴露给模型的绝对路径——返回 null 降级 */
  getDir: async (): Promise<string | null> => null,

  readWorkflow: fsReadWorkflow,

  createWorkflow: async (doc: WorkflowDoc, _opts?: { silent?: boolean }) => {
    await fsWriteWorkflow(doc)
    return { saved: true, id: doc.id, version: doc.version }
  },

  updateWorkflow: async (doc: WorkflowDoc, _opts?: { silent?: boolean }) => {
    await fsWriteWorkflow(doc)
    return { saved: true, id: doc.id, version: doc.version }
  },

  deleteWorkflow: fsDeleteWorkflow,

  /** Standalone 无后端校验闸——返回空错误清单（结构校验在渲染投影时仍会显现） */
  validateWorkflow: async (_doc: WorkflowDoc): Promise<{ valid: boolean; errors: string[] }> => ({
    valid: true,
    errors: [],
  }),
}

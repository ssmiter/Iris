import { create } from 'zustand'
import type { WorkflowDoc, WorkflowListEntry } from '@/types/workflow'
import { workflowApi } from '@/api/workflowApi'

/**
 * WorkFlow（工作流）Store：~/.wonwork/workflow/<id>.json 平铺 JSON 文件（2026-09-08 起）。
 *
 * 定位：过程结构资产（节点=工具、边=条件语义），agent 阅读参照；
 * 不是执行引擎，无任何行为耦合。与记忆/技能同一套「文件即资产+清单发现+按需加载+版本纪律」。
 * （旧「引导式工作流向导」与旧 DAG 执行体系已于 2026-09-09 全族下线，
 *  workflowStore/workflowApi 命名自本批次起唯一归属工作流。）
 *
 * 模型侧主通道=文件原语直读直写（清单头注带目录绝对路径）；
 * 本 store 服务前端清单注入、内置同步与可视化投影。
 * 内置工作流（BUILT_IN_WORKFLOW_IDS）按 version 驱动覆盖更新（同内置技能同款）；
 * 保存走后端校验闸——节点工具不在本机能力目录的工作流同步会跳过（如未装 iris 域包的机器
 * 不同步 APS 主链），这是特性不是故障：工作流只对具备相应能力的机器有意义。
 */

// ==================== 内置工作流 ====================

// 供给方向拍板（2026-09-09）：沉淀件=本机资产不进仓库；内置同步通道只为未来
// 「分场景分工厂精选集中管理」预留，当前为时过早——列表置空，同步机构保留。
// （首样 aps-curing-main-chain 曾随包下发：公网机器永无 iris 工具，每次启动必被
//  校验闸 400 拒绝纯噪音，已从 public/workflows 删除；schema 样板见设计文档附录B。）
const BUILT_IN_WORKFLOW_IDS: string[] = []

async function loadBuiltInWorkflows(): Promise<WorkflowDoc[]> {
  const docs: WorkflowDoc[] = []
  const base = import.meta.env.BASE_URL.replace(/\/$/, '')

  for (const id of BUILT_IN_WORKFLOW_IDS) {
    try {
      const res = await fetch(`${base}/workflows/${id}.json`)
      if (!res.ok) {
        console.warn(`[workflowStore] 内置工作流资源加载失败: ${id}`)
        continue
      }
      docs.push((await res.json()) as WorkflowDoc)
    } catch (err) {
      console.warn(`[workflowStore] 加载内置工作流失败: ${id}`, err)
    }
  }
  return docs
}

// ==================== Store ====================

interface WorkflowStoreState {
  workflows: WorkflowListEntry[]
  /** 工作流根目录绝对路径（清单头注用；standalone 为 null 降级） */
  workflowsDir: string | null
  initialized: boolean

  init: () => Promise<void>
  refresh: () => Promise<void>
  readWorkflow: (id: string) => Promise<WorkflowDoc | null>
  /** 保存：先校验（后端闸），exists 决定 POST/PUT；版本纪律=改动必升 */
  saveWorkflow: (doc: WorkflowDoc) => Promise<void>
  deleteWorkflow: (id: string) => Promise<void>
}

export const useWorkflowStore = create<WorkflowStoreState>()((set, get) => ({
  workflows: [],
  workflowsDir: null,
  initialized: false,

  init: async () => {
    if (get().initialized) return
    try {
      const [workflows, dir] = await Promise.all([
        workflowApi.listWorkflows(),
        workflowApi.getDir(),
      ])
      set({ workflows, workflowsDir: dir, initialized: true })
      await syncBuiltInWorkflows()
    } catch (err) {
      console.warn('[workflowStore] init 失败:', err)
      set({ initialized: true })
    }
  },

  refresh: async () => {
    try {
      const workflows = await workflowApi.listWorkflows()
      set({ workflows })
    } catch (err) {
      console.warn('[workflowStore] refresh 失败:', err)
    }
  },

  readWorkflow: (id) => workflowApi.readWorkflow(id),

  saveWorkflow: async (doc) => {
    const validation = await workflowApi.validateWorkflow(doc)
    if (!validation.valid) {
      throw new Error(`工作流校验未通过：${validation.errors.join('；')}`)
    }
    const exists = get().workflows.some((w) => w.id === doc.id)
    if (exists) {
      await workflowApi.updateWorkflow(doc)
    } else {
      await workflowApi.createWorkflow(doc)
    }
    await get().refresh()
  },

  deleteWorkflow: async (id) => {
    await workflowApi.deleteWorkflow(id)
    await get().refresh()
  },
}))

/** 内置工作流同步：按 version 驱动覆盖（同内置技能同款）。
 *  只覆盖 authored 条目；沉淀支线（sedimented）是用户/模型资产，内置通道永不碰。 */
async function syncBuiltInWorkflows(): Promise<void> {
  const store = useWorkflowStore.getState()
  let builtIns: WorkflowDoc[]
  try {
    builtIns = await loadBuiltInWorkflows()
  } catch {
    return
  }
  if (builtIns.length === 0) return

  for (const doc of builtIns) {
    const exists = store.workflows.find((w) => w.id === doc.id)
    if (exists && (exists.source !== 'authored' || exists.version === doc.version)) continue
    // 先走 validate 探针（200 + errors），校验不过即跳过——不直接 create/update
    // 让校验闸 400：按机过滤是常态（未装域包的机器），不该每次启动刷红一条网络错误
    const validation = await workflowApi.validateWorkflow(doc).catch(() => null)

    if (!validation || !validation.valid) {
      console.info(`[workflowStore] 内置工作流 ${doc.id} 未同步（本机能力目录不含其节点工具或校验未过）:`, validation?.errors)
      continue
    }
    try {
      // silent：同步失败是自己的 catch 兜底（console.info/warn），不经 fetchApi 默认 toast 打扰用户
      if (exists) {
        await workflowApi.updateWorkflow(doc, { silent: true })
      } else {
        await workflowApi.createWorkflow(doc, { silent: true })
      }
    } catch (err) {
      console.warn(`[workflowStore] 内置工作流 ${doc.id} 同步失败:`, err)
    }
  }
  await store.refresh()
}

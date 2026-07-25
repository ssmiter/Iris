import { dagWorkflowApi } from '@/api/client'
import { useDagWorkflowStore } from '@/stores/dagWorkflowStore'
import type { DagWorkflow } from '@/types/dagWorkflow'

export const EXAMPLE_DAG_TAG = 'built-in-example'

function createNodeId(prefix: string, index: number): string {
  return `${prefix}-${index}`
}

function buildBaiduExtractWorkflow(): Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'> {
  const nodes: DagWorkflow['nodes'] = [
    {
      id: 'start',
      type: 'start',
      position: { x: 100, y: 100 },
      data: { label: '开始' },
    },
    {
      id: 'webbridge',
      type: 'webbridge',
      position: { x: 100, y: 220 },
      data: {
        label: '访问百度示例',
        description: '复用 WebBridge 内置示例：访问百度并保存资源',
        onError: 'retry',
        maxRetries: 1,
        webbridge: {
          workflowId: 'example-built-in-example-baidu',
          screenshotOnFailure: true,
        },
      },
    },
    {
      id: 'llm',
      type: 'llm',
      position: { x: 100, y: 360 },
      data: {
        label: '总结页面内容',
        llm: {
          prompt:
            'WebBridge 已执行工作流（ID: ${nodeOutputs.webbridge.executedWorkflowId}）。请回复一句说明：该 DAG 节点成功复用了 WebBridge 工作流。',
        },
      },
    },
    {
      id: 'end',
      type: 'end',
      position: { x: 100, y: 500 },
      data: { label: '结束' },
    },
  ]

  const edges: DagWorkflow['edges'] = [
    { id: 'e-start-webbridge', source: 'start', target: 'webbridge' },
    { id: 'e-webbridge-llm', source: 'webbridge', target: 'llm' },
    { id: 'e-llm-end', source: 'llm', target: 'end' },
  ]

  return {
    name: '📘 示例：访问百度并总结',
    description: `演示如何在 DAG 中复用 WebBridge 工作流，并用 LLM 总结结果。[${EXAMPLE_DAG_TAG}]`,
    version: '1.0.0',
    nodes,
    edges,
    tags: [EXAMPLE_DAG_TAG],
  }
}

function buildConditionalGreetingWorkflow(): Omit<DagWorkflow, 'id' | 'createdAt' | 'updatedAt'> {
  const nodes: DagWorkflow['nodes'] = [
    {
      id: 'start',
      type: 'start',
      position: { x: 300, y: 100 },
      data: { label: '开始' },
    },
    {
      id: 'set-name',
      type: 'variable',
      position: { x: 300, y: 220 },
      data: {
        label: '设置用户名',
        variable: { variableName: 'userName', variableValue: '工程师' },
      },
    },
    {
      id: 'condition',
      type: 'condition',
      position: { x: 300, y: 340 },
      data: {
        label: '是否已登录',
        condition: { conditionExpression: "variables.userName !== ''" },
      },
    },
    {
      id: 'greeting',
      type: 'send_message',
      position: { x: 160, y: 480 },
      data: {
        label: '欢迎消息',
        sendMessage: {
          channel: 'log',
          title: '欢迎',
          content: '欢迎回来，${variables.userName}！',
        },
      },
    },
    {
      id: 'guest',
      type: 'send_message',
      position: { x: 440, y: 480 },
      data: {
        label: '游客消息',
        sendMessage: {
          channel: 'log',
          title: '提示',
          content: '请先登录以使用完整功能。',
        },
      },
    },
    {
      id: 'end',
      type: 'end',
      position: { x: 300, y: 620 },
      data: { label: '结束' },
    },
  ]

  const edges: DagWorkflow['edges'] = [
    { id: 'e-start-set', source: 'start', target: 'set-name' },
    { id: 'e-set-condition', source: 'set-name', target: 'condition' },
    { id: 'e-condition-greeting', source: 'condition', target: 'greeting', label: 'true' },
    { id: 'e-condition-guest', source: 'condition', target: 'guest', label: 'false' },
    { id: 'e-greeting-end', source: 'greeting', target: 'end' },
    { id: 'e-guest-end', source: 'guest', target: 'end' },
  ]

  return {
    name: '📗 示例：条件分支',
    description: `演示 DAG 中的变量、条件判断与多分支执行。[${EXAMPLE_DAG_TAG}]`,
    version: '1.0.0',
    nodes,
    edges,
    tags: [EXAMPLE_DAG_TAG],
  }
}

export async function ensureDagExampleWorkflows(): Promise<void> {
  try {
    const workflows = await dagWorkflowApi.getAll()
    const hasExamples = workflows.some(
      (w) => w.tags?.includes(EXAMPLE_DAG_TAG) || w.description?.includes(EXAMPLE_DAG_TAG)
    )
    if (hasExamples) return

    const examples = [buildBaiduExtractWorkflow(), buildConditionalGreetingWorkflow()]
    for (const draft of examples) {
      await dagWorkflowApi.create(draft)
    }

    // 刷新 store，确保 UI 立即显示示例
    await useDagWorkflowStore.getState().loadWorkflows()
  } catch (err) {
    console.error('Failed to seed DAG example workflows:', err)
  }
}

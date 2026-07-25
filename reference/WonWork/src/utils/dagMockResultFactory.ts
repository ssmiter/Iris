import type { DagNode, DagNodeType } from '@/types/dagWorkflow'

export interface MockResultOptions {
  /** 节点在 DAG 中的 ID */
  nodeId: string
  /** 节点类型 */
  nodeType: DagNodeType
  /** 节点配置数据 */
  nodeData: DagNode['data']
}

export function createMockResult(options: MockResultOptions): unknown {
  const { nodeType, nodeData } = options

  switch (nodeType) {
    case 'database_query':
      return {
        affectedRows: 1,
        insertedId: null,
        changedRows: 1,
        mock: true,
      }

    case 'http_request': {
      const method = (nodeData.httpRequest?.method || 'POST').toUpperCase()
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: { success: true, method, mock: true },
        mock: true,
      }
    }

    case 'file_operation': {
      const action = nodeData.fileOperation?.action || 'write'
      return {
        success: true,
        action,
        path: nodeData.fileOperation?.path || '/mock/path',
        size: 0,
        mock: true,
      }
    }

    case 'send_message': {
      const channel = nodeData.sendMessage?.channel || 'notification'
      return {
        delivered: true,
        channel,
        title: nodeData.sendMessage?.title || '',
        content: nodeData.sendMessage?.content || '',
        mock: true,
      }
    }

    case 'tool': {
      const toolName = nodeData.tool?.toolName || ''
      return {
        success: true,
        toolName,
        output: null,
        mock: true,
      }
    }

    case 'webbridge':
      return {
        success: true,
        results: [],
        summary: 'WebBridge 节点在沙箱中被 mock',
        mock: true,
      }

    case 'javascript':
      return {
        result: null,
        mock: true,
      }

    case 'agent_swarm':
      return {
        success: true,
        status: 'completed',
        finalOutput: 'Agent Swarm 节点在沙箱中被 mock',
        totalSteps: 0,
        totalExecutionTimeMs: 0,
        mock: true,
      }

    case 'sub_workflow': {
      const workflowId = nodeData.subWorkflow?.workflowId || ''
      return {
        workflowId,
        workflowName: workflowId,
        outputs: {},
        mock: true,
      }
    }

    default:
      return {
        success: true,
        mock: true,
      }
  }
}

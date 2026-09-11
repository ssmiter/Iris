import type { Tool, ToolExecutionContext } from '@/agent/types'
import { useBrowseDirectoryStore, normalizeBrowsePath } from '@/stores/browseDirectoryStore'
import { useConversationStore } from '@/stores/conversationStore'

/**
 * set_browse_directory：把「浏览目录浮层窗口」的目录定到合适位置（2026-09-04 拍板形态）。
 *
 * 纯浏览层便利工具，类比 update_board 的注册方式（registerBoardTools 只挂主 Agent
 * Loop；子 Agent general/explore 不注册——浏览定位是主对话面向用户的行为）。
 * 静默、幂等：scope=conversation 的绑定落会话记录 ProjectPath 列（2026-09-09 二阶段
 * 结构化绑定，与用户手动「设为项目目录」同一事实源）；scope=global 只动浏览窗口 UI 态。
 * 模型自己的文件操作仍按既有通道与登记闸（本工具不碰 RegisteredRootsService /
 * 权限表 / 文件原语 / cwd）。
 */

export const SET_BROWSE_DIRECTORY_TOOL_NAME = 'set_browse_directory'

interface SetBrowseDirectoryInput {
  /** 物理绝对路径（如 E:/code/proj）或 /workspace 虚拟路径 */
  path: string
  /** 'conversation'（缺省，定为本会话项目目录）| 'global'（移动全局浏览位置） */
  scope?: 'conversation' | 'global'
}

export const setBrowseDirectoryTool: Tool<SetBrowseDirectoryInput, { content: string }> = {
  name: SET_BROWSE_DIRECTORY_TOOL_NAME,
  description:
    '把用户界面上「文件浏览」浮层窗口的目录定到指定位置。开始涉及某个项目目录的任务时顺手调一次' +
    '（如任务围绕 D:/work/proj 就设为该目录），用户打开浏览窗口时直接看到这个项目。' +
    '规则：①这是纯浏览定位——只影响浏览窗口显示的目录，不影响你自己的文件操作，你操作文件仍按既有通道与目录登记闸；' +
    '②幂等，判断更贴切时可重复调用覆盖；③窗口未打开时也照常调用，用户之后打开即生效；' +
    '④简单问答、不涉及具体项目目录的任务不要用这个工具。',
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: {
      path: {
        type: 'string',
        description: '物理绝对路径（如 E:/code/proj）或 /workspace 虚拟路径',
      },
      scope: {
        type: 'string',
        enum: ['conversation', 'global'],
        description:
          '缺省 conversation=定为本会话的项目目录（浏览窗口可一键切过去）；global=直接移动全局浏览位置。一般用缺省。',
      },
    },
  },
  riskLevel: 'standard',
  // 与 update_board 同款：写用户可见 UI 状态（浏览窗口位置，localStorage 持久化），
  // isReadOnly=false 如实声明"有用户可见的写副作用"——confirm 模式下会确认（合理，
  // 浏览位置变了用户看得到）
  isReadOnly: false,
  isConcurrencySafe: true,
  isDestructive: false,
  alwaysLoad: true,
  maxResultSizeChars: 1000,

  execute: async (input: SetBrowseDirectoryInput, ctx: ToolExecutionContext): Promise<{ content: string }> => {
    if (typeof input.path !== 'string' || !input.path.trim()) {
      return { content: 'path 不能为空，未更新。' }
    }
    const path = normalizeBrowsePath(input.path)
    const scope = input.scope === 'global' ? 'global' : 'conversation'

    if (scope === 'global') {
      useBrowseDirectoryStore.getState().setGlobalPath(path)
      return { content: `浏览窗口的全局浏览位置已设为：${path}` }
    }

    if (ctx.conversationId == null) {
      // DAG / 后台子环境无会话上下文：优雅落空（与 update_board 同款纪律）
      return { content: '当前环境没有会话上下文，浏览目录未设置。' }
    }
    // 结构化绑定（2026-09-09 二阶段）：会话记录 ProjectPath 列是唯一事实源——最近项目/
    // 项目会话列表/浏览窗口会话层根都从这里派生（localStorage conversationPaths 指针表
    // 已退役，由浏览窗口一次性迁移进后端）。fire-and-forget：失败也只是 UI 暂时缺根，
    // 不影响模型自身文件操作。
    void useConversationStore.getState().setConversationProject(ctx.conversationId, path)
    return { content: `本会话的项目目录已设为：${path}（用户打开文件浏览窗口可一键切换到该目录）。` }
  },
}

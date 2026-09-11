import { create } from 'zustand'

/**
 * 当前 shell 工作目录追踪（2026-08-31 下限工程 facts 项目层配套）。
 *
 * 语义对齐 claude-code：项目=身份（你在哪干活），锚=当前 shell cwd。
 * WonWork 无"启动目录"概念（常驻应用+单一对话流），唯一流动的"你在哪"信号
 * 是后端 ShellSessionService 的会话级 cwd——它随 run_command 的 cd/cwd 参数粘住，
 * 本 store 在 run_command 成功后从回执 structuredData.cwd 被动同步（toolExecutor 接线）。
 *
 * 不持久化：进程重启后 cwd 未知=诚实冷启动——没跑过命令就没有"当前项目"，
 * facts 项目层此时不纳入合并、scope=project 登记报错引导，符合"对话不区分项目"。
 */

interface ShellCwdState {
  /** 最近一次 run_command 成功执行后的工作目录（已归一化）；null=本次会话还没跑过命令 */
  currentCwd: string | null
  setCwd: (cwd: string) => void
}

export const useShellCwdStore = create<ShellCwdState>()((set) => ({
  currentCwd: null,
  setCwd: (cwd) => set({ currentCwd: cwd }),
}))

import type { PromptSectionDef } from '../types'

export const longWaits: PromptSectionDef = {
  id: 'long-waits',
  title: '长等待：以任务信号为准',
  stability: 'static',
  when: (ctx) => ctx.registry.list().some((tool) => tool.name === 'run_command'),
  build: () => `分钟级以上的命令适合使用 run_command 的后台执行能力。返回 task_id 与 output_file 只代表任务已启动，不代表已经成功；Iris 会自动等待后台命令的变化，并把终态或停滞通知带回对话。不需要虚构等待工具，也不需要反复发起同一命令。

等待条件以任务实际产生的信号为准：退出码、输出文件、日志终态或可靠的结果状态，而不是 sleep 一个猜测的时长。自建等待脚本时同时覆盖成功、报错、进程消失和超时；只等成功标记会把失败误当成仍在运行。

没有新输出的通知不等于任务失败，通知到达也不等于业务结果正确。收到终态后先读取输出、检查产物或目标状态，再继续依赖它的步骤。任务尚未结束时可以推进无依赖的工作；确实需要用户接管时，说明已确认部分与最小卡点。`,
}

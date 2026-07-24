# 04 · 工作区与 Python 沙箱

## 1. 工作区（Workspace）

助手的手和脚落在文件系统上。工作区是用户明确选择的一个真实目录，也是所有文件 Tool 唯一允许接触的根。需要外部文件时先由用户导入或显式更换工作区，不给单次调用临时越界特权。

### 路径围栏（Path Jail）——第一安全原则

- 文件工具只接受**工作区内相对路径**（`notes/旅行清单.md`）；
- 绝对路径、UNC、device path、空字节、非法段和 `..` 逃逸 → 一律拒绝；
- 在唯一 root 下 resolve + normalize，用路径段语义校验 containment，不用字符串 `startsWith`；
- 逐层检查已存在祖先的 symlink / Windows reparse point；无法解析或检查异常一律拒绝；
- 写入前重新校验父目录和目标版本，executor 只接收 WorkspaceGuard 签发的受保护目标；
- 错误信息要教学化："路径越界：只能操作工作区内文件，收到的是绝对路径 E:\…，请改用相对路径"。

### 文件工具集

`read_file / write_file / list_files / glob / grep / delete_file / mkdir / move_file`

- `read_file`：大文件截断 + 提示（"已截断，共 N 行"），支持行范围；
- `write_file`：要求不存在或匹配 expected version；写前建 Checkpoint、审批差异，再同目录原子替换；
- `delete_file`：destructive，强审批；
- `grep/glob`：走内存友好的流式扫描，结果限量。

所有文件写，包括创建目录、移动、覆盖、删除和恢复，都经过 Tool Runtime；不存在前端可直调的 `/workspace/write` 旁路。

### 检查点（Checkpoints）——后悔药

- 每次写操作前记录 logical path、change kind、before hash/size/mtime、内容快照引用和 `toolExecutionId`；
- 成功后记录 after hash 与 evidence；
- 对话分支只改变历史视野，不静默回滚文件；
- 恢复 Checkpoint 是新的可预览写动作，默认审批并保留新审计记录；
- 大文件的保留、内容寻址和清理策略在 M3 用真实数据验证；不能只留 hash 却仍承诺可回滚。

## 2. Python Runner 与 Sandbox 边界

数据处理、文档生成（Word/Excel/PPT/PDF）、图表渲染交给 Python——这是助手从"会聊"到"会干活"的关键一跃。

### 首版架构

```
Agentic / Pipeline 提交 run_python Invocation
  → Tool Runtime 校验脚本来源、输入、预算与风险
  → 把声明输入复制或只读映射到 staged input
  → Trusted Runner 或未来 Sandbox Helper 在独立 run directory 执行
  → 只写 separate output
  → 捕获 stdout/stderr/生成文件清单并截断
  → Runtime 验证 output
  → 导入 Workspace 作为新的受审批写动作
```

### 约束（默认值，可配置）

| 项 | 默认 | 说明 |
|---|---|---|
| 超时 | 120s | 到时强杀进程组 |
| 输出截断 | 64KB | stdout/stderr 各自截断 |
| 网络 | Trusted Runner 不承诺隔离 | 环境变量和约定不是安全边界；真正 Sandbox 必须由 OS 级策略验证 |
| 文件访问 | staged input + separate output | 不把整个 Workspace 读写挂载给执行进程 |
| 预装库 | python-docx / openpyxl / python-pptx / pypdf / matplotlib / pandas | 文档四件套 + 数据处理 |

### 与工具的衔接

- `run_python` 是一个 Tool（path `/code/python`）；任意模型代码在真正隔离前不开放，首版只运行内置或用户明确选择的受信脚本；
- output 通过验证和导入后才转为**产物卡片**，执行进程不能自行宣布 Artifact；
- 沙箱执行过程的 stdout 流式回显为过程节点（用户能看到"正在生成第 3 页"）。

## 3. 产物（Artifacts）

工具/沙箱产出的文件是一等公民：

- 统一产物模型：`{ id, path, version, name, kind, size, provenance, visibility, sourceToolExecutionId }`；
- 对话里渲染为文件卡片（类型图标 + 名称 + 大小 + 预览）；
- 产物索引按会话持久化（SQLite），切换会话水合还原；
- 预览坞（右侧面板）集中展示当前会话全部产物。

## 4. 设计规范提炼（通用）

1. **一切写前快照**：没有检查点的写操作不许合并。
2. **错误信息教学化**：拒绝时告诉用户正确用法长什么样。
3. **大输出必截断**：任何可能无限大的输出（文件/查询/子进程）都有上限 + "已截断"明示。
4. **如实命名隔离强度**：独立目录、超时和强杀只是 Runner 约束；没有 OS 边界就不能声称任意代码安全。
5. **产物可追踪**：每个产物记得自己由哪次工具调用产生（sourceToolCallId），对话与文件互链。

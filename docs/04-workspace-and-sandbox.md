# 04 · 工作区与 Python 沙箱

## 1. 工作区（Workspace）

助手的手和脚落在文件系统上。工作区是一个真实目录（默认 `~/Weave/workspace`），所有文件工具的根。

### 路径围栏（Path Jail）——第一安全原则

- 文件工具只接受**工作区内相对路径**（`notes/旅行清单.md`）；
- 传入绝对路径、含 `..` 逃逸、符号链接指向区外 → 一律拒绝（fail-close）；
- 解析后做 `realPath.startsWith(workspaceRoot)` 双重校验，防 symlink 逃逸；
- 错误信息要教学化："路径越界：只能操作工作区内文件，收到的是绝对路径 E:\…，请改用相对路径"。

### 文件工具集

`read_file / write_file / list_files / glob / grep / delete_file / mkdir / move_file`

- `read_file`：大文件截断 + 提示（"已截断，共 N 行"），支持行范围；
- `write_file`：默认要求目标不存在或带 overwrite 意图；写前自动建检查点（见 §2）；
- `delete_file`：destructive，必审批；
- `grep/glob`：走内存友好的流式扫描，结果限量。

### 检查点（Checkpoints）——后悔药

- 每次写操作前，把原文件快照到 `.weave/checkpoints/<msgId>/<原始相对路径>`；
- 对话分支切换/编辑重发时，世界状态回滚到锚点消息时刻：恢复该锚点检查点快照；
- 检查点按消息 id 组织 = 文件状态与对话树的节点一一对应，"回到那次对话"= 文件也回到那时；
- 容量控制：单文件 >10MB 不快照（只记录哈希），检查点总量 LRU 清理。

## 2. Python 沙箱

数据处理、文档生成（Word/Excel/PPT/PDF）、图表渲染交给 Python——这是助手从"会聊"到"会干活"的关键一跃。

### 架构

```
POST /api/sandbox/python
  { code, timeoutSec?, files? } 
    → 沙箱服务起子进程：嵌入式 Python（随安装包分发，用户机器零依赖）
    → 工作目录 = 工作区内 .weave/sandbox/<runId>/
    → 捕获 stdout/stderr/生成文件清单 → 截断 → 返回
```

### 约束（默认值，可配置）

| 项 | 默认 | 说明 |
|---|---|---|
| 超时 | 120s | 到时强杀进程组 |
| 输出截断 | 64KB | stdout/stderr 各自截断 |
| 网络 | 禁止 | 沙箱进程无网络命名空间/代理置空（Windows 用环境变量 + 防火墙规则尽力而为；文档明说这不是安全边界） |
| 文件访问 | 仅沙箱目录 + 工作区只读挂载 | 产物回收到工作区 `outputs/` |
| 预装库 | python-docx / openpyxl / python-pptx / pypdf / matplotlib / pandas | 文档四件套 + 数据处理 |

### 与工具的衔接

- `run_python` 本身是一个工具（path `/code/python`，elevated——能写工作区文件）；
- 生成的文档自动转为**产物卡片**（对话里的文件卡，可预览/下载/打开目录）；
- 沙箱执行过程的 stdout 流式回显为过程节点（用户能看到"正在生成第 3 页"）。

## 3. 产物（Artifacts）

工具/沙箱产出的文件是一等公民：

- 统一产物模型：`{ id, path, name, kind(document/image/table/...), size, createdAt, sourceToolCallId }`；
- 对话里渲染为文件卡片（类型图标 + 名称 + 大小 + 预览）；
- 产物索引按会话持久化（SQLite），切换会话水合还原；
- 预览坞（右侧面板）集中展示当前会话全部产物。

## 4. 设计规范提炼（通用）

1. **一切写前快照**：没有检查点的写操作不许合并。
2. **错误信息教学化**：拒绝时告诉用户正确用法长什么样。
3. **大输出必截断**：任何可能无限大的输出（文件/查询/子进程）都有上限 + "已截断"明示。
4. **子进程必隔离**：独立工作目录、进程组强杀、资源上限，主进程永不解析子进程输出为代码。
5. **产物可追踪**：每个产物记得自己由哪次工具调用产生（sourceToolCallId），对话与文件互链。

# 46 · 后端客观能力层（Objective Backend）

> 状态：2026-09 架构重画落地。本文档记录 Java 后端剥离 agent loop 后的客观能力层契约。
> 上游决策见 [docs/44](44-frontend-agent-runtime-rearchitecture.md)；前端迁移记录见 [docs/45](45-frontend-migration-log.md)。
>
> 核心原则：**前端裁决、后端报事实**。后端只执行 + 报结构化事实，不做审批裁决、不决定下一轮、不跑模型 loop。

## 1. 分层定位

```text
Frontend Agent Runtime（裁决、Loop、上下文、审批、可视化）
      ⇅ 有界命令与事实批次（/api/* REST + /api/chat/proxy SSE）
Java Objective Backend（本文档）
  ├─ 工作区文件原语（/api/workspace/*）—— 路径围栏 fail-close
  ├─ 会话历史（/api/history/*）—— SQLite 权威
  ├─ 能力目录发现（/api/capabilities*）—— 读模型，features 开关
  ├─ 模型透明代理（/api/chat/proxy）—— 只转发不编排
  ├─ 系统端点（/api/auth/user、/api/version、/api/config/providers、/api/cron/*）
  └─ 保留的客观能力（审批/产物/记忆/技能/定时/MCP/能力目录管理面）
```

## 2. 剥离了什么（删除清单）

随 agent loop 迁往前端 Runtime，以下后端编排代码已删除：

- `agent/model/`（模型请求、流解析、compaction、tool observation）——除 `ModelProfileController`/`ModelProfileCatalog` 保留并作为 provider 配置权威。
- `agent/pipeline/`、`agent/run/` 全部。
- `conversation/api/{RunController, StopController, SupplementController}` 及对应 application/domain 命令类。
- `tools/system/agents/*`（DelegateTask 等编排工具）、`InvokePipelineTool`、`StreamingToolSpeculator`。
- `ModelGatewayController` 的 `/model-profiles` 重复端点（与权威 `ModelProfileController` 撞路径）；gateway 收敛为纯透明 chat 转发通道 `/model-gateway/chat/completions`。

## 3. 新增端点契约（objective/ 包）

所有端点**只执行 + 报事实**，不做裁决。模型工具默认只能使用工作区内相对路径（正斜杠），经路径围栏 fail-close 解析；用户浏览面板可通过 `browse=true` 浏览已登记或临时选中的 Windows 目录。Iris 无 SystemCode 分区（单用户本地），相关参数一律忽略。

### 3.1 工作区文件 `/api/workspace`

| 路径 | 方法 | 用途 | 风险 |
|---|---|---|---|
| `/api/workspace/info` | GET | 工作区根路径 | read_only |
| `/api/workspace/list?path=&recursive=` | GET | 列目录 | read_only |
| `/api/workspace/read?path=&offset=&limit=` | GET | 读文件（分页） | read_only |
| `/api/workspace/write` | POST | 写文件（支持 append/expectedContent） | standard |
| `/api/workspace/upload` | POST | 上传文件（multipart） | standard |
| `/api/workspace/mkdir` | POST | 建目录 | standard |
| `/api/workspace/rename` | POST | 重命名 | standard |
| `/api/workspace/delete?path=&recursive=` | DELETE | 删除 | destructive |
| `/api/workspace/grep` | POST | 内容检索 | read_only |
| `/api/workspace/glob` | POST | 模式匹配 | read_only |
| `/api/workspace/download` / `preview` | GET | 按需下载/内联预览（有大小预算） | read_only |
| `/api/workspace/drives` | GET | 枚举本机盘符事实 | read_only |
| `/api/workspace/open` / `reveal` | POST | 用户面板调用系统文件管理器 | user_action |
| `/api/workspace/roots` | GET/POST/DELETE | 登记模型可读的外部目录根 | user_action |
| `/api/workspace/conventions` | GET | 发现工作区约定文件（有界） | read_only |
| `/api/workspace/shell/tasks/{id}/wait` | GET | 后台命令事件长等待（终态/停滞/heartbeat） | read_only |
| `/api/workspace/shell/tasks/{id}/stop` | POST | 终止后台命令进程树 | standard |

删除目录默认只接受空目录；面板明确确认 `recursive=true` 时才执行递归删除，
并以 10,000 个条目为上限，返回 `deletedEntries` 供界面反馈。`recycle` 目前只回显
请求意图，未伪装成系统回收站语义。

### 3.2 会话历史 `/api/history`（SQLite 权威）

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/history?page=&pageSize=` | GET | 会话列表（侧栏平铺） |
| `/api/history` | POST | 创建会话 |
| `/api/history/{id}` | GET | 单会话摘要 |
| `/api/history/{id}` | PUT | 重命名 |
| `/api/history/{id}` | DELETE | 删除会话（含消息/turn） |
| `/api/history/{id}/messages` | GET | 平铺消息列表 |
| `/api/history/{id}/messages` | POST | 追加消息事实（含 toolCalls/renderNodes） |

### 3.3 能力目录发现 `/api/capabilities`

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/capabilities` | GET | 扁平工具清单 + `features:["frontend_loop_online"]` 开关 |
| `/api/capabilities/all` | GET | 全量扁平清单 |
| `/api/capabilities/tree?path=` | GET | 目录浏览 |
| `/api/capabilities/schema?path=` | GET | 单工具 schema 按需读取 |

`frontend_loop_online` 是"前端 Loop 是否接管"的信号位——后端剥离后由此告知前端接管编排权。

### 3.4 模型透明代理 `/api/chat/proxy`

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/chat/proxy` | POST/SSE | 模型流透明转发（绕 CORS/凭据/企业网络），只转发不编排 |

### 3.5 工具执行桥 `/api/tools`

前端 Runtime 已经选定工具后，`POST /api/tools/execute` 只创建最小的
`client_run` 外壳并交给既有 ToolRuntime 校验、审批、执行和落盘，响应为
`approval_required` / `result` / `error` SSE。`POST /api/tools/approval`
是 WonWork 兼容的轻量决议入口；批准后在同一个客观 Runtime 内恢复工具并把终态一并返回，前端不重复发起调用。

### 3.6 系统端点

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/auth/user` | GET | 当前用户（本地单用户） |
| `/api/version` | GET | 版本信息 |
| `/api/config/providers` | GET | 模型 provider 配置（委托 ModelProfileCatalog 权威） |
| `/api/cron/*` | 混合 | 定时任务 CRUD（别名委托 Schedule 服务） |

## 4. 保留的客观能力（未动）

审批（ApprovalController）、人机交互（AttentionController）、工具输出查询（ToolOutputController）、产物（ArtifactController、UserArtifactIngressController）、模型配置（ModelProfileController，provider 权威）、MCP 连接器（McpServerController）、记忆（PersonalMemoryController）、定时任务（ScheduleController）、技能（SkillController）、任务台账（TaskController）、能力目录管理面（CapabilityAdmin*Controller）。

`run_command` 是工作区内的 Windows PowerShell 原语：`cwd` 是
`workingDirectory` 的简写，`run_in_background=true` 时立即返回
`task_id/output_file`，由 `/api/workspace/shell/tasks/*` 长等待或终止；完整输出始终落盘，
模型需要时再用文件原语读取。

## 5. SQLite schema 处理决策

**不删旧表。** 原计划"删旧运行事实表重建 schema"，但实际探明保留侧代码（ConversationRepository/ConversationQueryRepository/TaskEventEmitter/ToolRuntimeRepository）大量 JOIN 这些表（agent_task_*、client_run、context_frame、frame_chain、idempotency_record、attention_projection、render_node_projection、run_invocation 等）——删任何一张都会炸保留方。

结论：`schema.sql` 全表保留。旧 loop 投影表成为无写入方的空壳，待前端 Runtime 完全接管后随对应保留读模型一起退役。期间修复了真缺口：`client_run` 表在 schema.sql 缺失但保留代码已 INSERT/SELECT，已按 insert 列补建（含 2 索引）。

**远程部署方向**：本地 SQLite 权威；将来后端真正部署为服务器程序远程访问时换 PostgreSQL（见 docs/44 §1），不引 Redis——SQLite 单写者模型在本地够用，远程并发由 PostgreSQL 承接。

## 6. 已知边界与待办

- 启动守卫（能力定义版本 fail-close）：删除工具导致 manifest 指纹漂移，开发库 `~/.iris.db` 旧快照会拦启动。重建方式：备份后挪走旧库，应用以干净库重建快照（2026-09-10 已执行并验证）。
- 工作区根默认 `C:\Users\8\Iris\workspace`。
- 待办：端到端联调（前端 Loop → 工具调用 → 后端执行 → SSE → SQLite 落库）见阶段三。

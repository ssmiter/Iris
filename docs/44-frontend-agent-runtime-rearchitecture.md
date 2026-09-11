# 44 · 前端 Agent Runtime 与客观后端

> 状态：2026-09 架构重画，作为 `docs/02`、`06`、`07`、`08` 中旧“后端 Loop”决策的替代依据。
>
> 参考：WonWork 当前实现与 `docs/architecture.html`，Claude Code 的 Agentic 语义，以及真实工业 Agent JD。参考用于理解问题，不复制代码与历史包袱。

## 1. 结论

Iris 的 Agent 编排、模型协议和模型流消费统一由 Frontend Runtime 负责。Java Backend 不再运行模型 Loop，也不决定下一轮该调用什么；它只提供浏览器无法可靠承载、需要大量定义或需要受控环境的客观能力。

```text
用户 / UI
  ⇅ 同进程增量事件
Frontend Agent Runtime
  ├─ Context 组装、模型请求、Agent Loop、子 Agent、Pipeline 调度
  ├─ 流式协议解析、工具调用配对、补充/停止/审批交互
  └─ 瞬时 Runtime 投影、渲染节拍
       ⇅ 有界命令与事实批次
Java Objective Backend
  ├─ Conversation / Branch / Turn / Runtime Event 持久化
  ├─ Capability Catalog / Skill / MCP 元数据与大规模检索
  ├─ Tool Runtime、审批、证据、幂等与副作用边界
  ├─ Workspace / Artifact / SQL / Sandbox / WebBridge / AIGateway
  └─ 本地 SQLite；远程部署时可替换 PostgreSQL
```

“Frontend Runtime”不是 React 组件里的长函数。它是独立于组件和 Zustand 的 TypeScript 内核；UI 只订阅它产生的投影。模型传输可以直连 provider，也可以经无编排权的透明网关解决 CORS、凭据或企业网络问题。无论走哪条传输，messages、tools、续轮和终止判断都由前端决定。

## 2. 为什么重画

旧架构把 provider delta 先送入 Java，落库、投影成 Conversation SSE，再由浏览器合批揭示。它很适合“服务器拥有智能”的传统系统，却让 Iris 的交互经过两套时钟：模型流时钟和后端投影时钟。答案即使语义正确，也容易呈现为成段跳出；补充、中止、工具出生和最终答案衔接都需要前后端互猜。

把 Loop 放回前端后：

- 模型 delta 到达与画面消费在同一进程，首字、节拍和尾部收束不再依赖网络回环；
- Agent 每轮使用的真实消息、工具租约和 `reasoning_content` 就在请求发起处，协议配对更直接；
- React 组件不负责 Loop，动画也不反向驱动持久化；
- Java 能专心做好浏览器不具备的稳定能力：目录规模、文件系统、数据库、浏览器连接、企业网关、安全和事实存储。

真实 JD 进一步说明这条边界的价值：智能侧需要规划、工具、记忆、流式与异步；环境侧需要把 CAE/Git/企业系统变成稳定能力，以规则、求解器和证据验证结果。两者协作，但不应由同一个后端大 Loop 混成一层。

## 3. 前端 Runtime 的四层

### 3.1 Model Protocol

`ModelClient` 只负责把统一请求编译成 provider wire format，并把流解析为统一事件：

```ts
type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_delta'; callId: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  | { type: 'completed'; stopReason: string }
```

协议层不写 Store、不调用 Tool、不重试已经可见或可能产生副作用的语义动作。透明传输重试只允许发生在尚未收到任何有效模型事件之前。

### 3.2 Agent Loop

Loop 持有一次 Run 的工作状态，而不是整个产品状态：

- 当前规范 messages；
- 稳定系统前缀和本轮动态尾部；
- 当前发现的能力 Definition/租约；
- 正在组装的 assistant blocks/tool calls；
- 补充队列、AbortSignal、预算和 blocker；
- 下一步是继续模型、等待用户、执行工具还是收尾。

每轮形成一个不可变 `RoundCommit`。Loop 不逐 token 写数据库；首字直接进入本地投影，正文按渲染时钟消费，重要边界立即可见。

### 3.3 Objective Gateway

Frontend 通过一组窄接口使用 Backend：

```text
HistoryGateway     接受 Turn、提交 Round/Run 事实批次、读取分支历史
CapabilityGateway 浏览/搜索/读取定义；只返回当前需要的有限 schema
ToolGateway       提交冻结的工具调用，观察审批、结果和证据
ArtifactGateway   导入、预览、发布稳定成果引用
```

这些接口使用普通领域对象，不泄漏 SQLite 行、Java 类或 React RenderNode。Frontend 可以用 in-process mock 调试 Runtime，Backend 也可以不启动模型独立验证工具。

### 3.4 Projection Clock

模型事件先进入纯内存累积器，再由三种优先级投影：

- 立即：错误、审批、用户澄清、停止、生命周期终点；
- 快速：首个内容、首个工具、工具终态；
- 帧合批：连续正文与公开推理摘要。

数据库持久化批次和视觉帧互不等待。Frontend Store 只保存当前可见投影与可丢弃的交互状态；刷新后从 Backend 重新水合。

## 4. 新的事实边界

SQLite 继续有明显优势：事务、唯一约束、分页、分支查询、进程重启恢复和未来服务端访问都比 IndexedDB 中复制一套复杂图可靠。它是历史事实的唯一真相，而不是模型流的中转站。

新运行事实收敛为：

| 对象 | 保存内容 | 写入频率 |
|---|---|---:|
| Conversation / Branch / Message / Turn | 用户历史与分支位置 | 用户命令边界 |
| ClientRun | Runtime 身份、owner、阶段、预算摘要 | 生命周期边界 |
| RoundCommit | 请求摘要、assistant blocks、tool calls、stop reason、usage | 每个模型轮一次 |
| RuntimeEvent | 可恢复的有限事件和安全 UI 投影 | 批量、非逐 token |
| ToolExecution / Approval / Evidence | 后端真实执行事实 | 工具状态边界 |
| Artifact | 不可变成果与来源 | 成果边界 |

模型请求中的完整动态 payload 可以按诊断策略保存哈希和可选安全快照，但不是重建对话所需的第二套消息库。`RenderNode` 是可重建投影，不与 canonical message 竞争真相。

Frontend 因而不再持久化完整会话图，只保留：当前活动 Run、尚未提交的流缓冲、草稿、滚动/展开、连接状态。页面刷新先读取 ConversationView，再读取未闭合 ClientRun；可恢复则恢复，不能恢复则留下用户可见卡点，而不是假装仍在运行。

## 5. Tool 与后端的接口原则

Frontend 决定“调用哪个能力”，Backend 决定“这次调用是否合法且实际发生了什么”。

一次调用冻结：

```text
runId + roundId + toolCallId
+ capabilityPath + manifestHash
+ normalized arguments
+ clientRequestId
```

Backend 重新解析 Registry binding、校验 schema/risk/path/availability，创建 Operation Snapshot；只读操作可以在响应内直接返回终态，写操作返回 waiting approval。Frontend 从 ToolGateway 得到的永远是结构化 observation：`effect / evidence / error / recovery / outputRef`，不会从异常字符串猜下一步。

能力目录规模、大结果对象和执行环境留在后端；被选中的少量 Definition 才进入前端 Model Context。MCP、Skill 和企业 AIGateway 都投影为相同的能力定义，不要求前端理解其实现来源。

## 6. 本地、远程与 Redis

本地版：SQLite + Object Store 是事实源，Frontend 与 Backend 通过 loopback HTTP/SSE 通信。

远程版：关系数据库替换为 PostgreSQL 等服务端事务存储，API 语义不变。Redis 只有出现多实例协调的真实需求才加入，并且只承担：

- 短租约、分布式锁和幂等命令的热点加速；
- 在线状态、事件 fan-out 和短期队列唤醒；
- 可丢失、可由数据库恢复的缓存。

消息、分支、工具结果、审批与任务状态绝不只存在 Redis。单机阶段不引入 Redis；SQLite WAL 已足够，先用运行指标证明瓶颈。

## 7. 删除与保留

从 Java Backend 删除：

- Model Provider 请求与流解析；
- Agentic Round Coordinator / Launcher；
- Context 请求组装、自动续轮与模型重试；
- 依赖后端模型的标题、压缩、子 Agent 与语义 Pipeline 调度；
- 为上述 Loop 服务、且没有独立产品语义的表和 API。

保留并重新接线：

- Conversation、Branch、Message、Turn、压缩边界和安全读模型；
- Capability Catalog、Tool Registry/Runtime、审批、证据和大结果落盘；
- Workspace、Artifact、SQL、Sandbox、WebBridge、MCP、Skill、Memory；
- 固定的客观后台任务；若需要模型变换，由前端 Pipeline Runtime 发起。

不保留后端旧 Loop 作为 fallback。当前尚无值得迁移的真实运行数据，开发库按新 schema 重建。

## 8. 实施路线

1. 建立前端 `agent/runtime`：统一 ModelClient、OpenAI-compatible parser、Run 状态机、视觉投影时钟。
2. 重画 History/Tool API：Backend 接受前端拥有的 Run/Round 事实，Tool Runtime 暴露受控调用入口。
3. 把普通对话切到 Frontend Runtime；模型正文不再经过 Conversation SSE 才显示。
4. 把能力发现、文件、浏览器、SQL 接到 ToolGateway，跑通多轮观察闭环。
5. 迁移 compact、标题、子 Agent 和 Pipeline；这些复用同一个 Runtime，不另造 Loop。
6. 删除 Java 模型与 Agent 编排包、旧配置和旧表，重建开发库。
7. 最后收敛 Store：持久数据只水合，活动流只投影，移除重复本地历史逻辑。

每一步都必须保持用户可见：开始后立刻有活动反馈；Agent 自己能恢复的问题自己恢复；真正无法推进时给出已完成事实和明确卡点。

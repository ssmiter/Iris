# 45 · 前端迁移日志（WonWork → Iris）

> 状态：2026-09 架构重画落地。记录把 WonWork 前端复制改造为 Iris 前端的全过程。
> 上游决策见 [docs/44](44-frontend-agent-runtime-rearchitecture.md)；后端契约见 [docs/46](46-backend-objective-layer.md)。
>
> 核心原则：**前端承载 Agent 编排与模型协议**（复用 WonWork 前端 Runtime），Java 后端剥离为客观能力层。

## 1. 迁移策略

**复制-改造优先于重写。** 不从头写前端，直接把 WonWork 前端（`reference/WonWork/src`，398 个 ts/tsx，已验证与上游一致）落地为 Iris 前端，改标识、裁企业特有入口、对齐后端接口。用已有的完善前端倒逼后端，后端发现不合理的再反向完善前端。

WonWork 前端本身就是"前端裁决"架构的成熟实现：agenticLoop、上下文装配/压缩、工具租约、审批裁决、子代理、cron 调度、全部可视化都在浏览器内。直接复用这套 Runtime，而不是在 Iris 旧前端里另起炉灶。

## 2. 搬了什么

- 整套 WonWork 前端：瀑布流对话、Agent Runtime（agenticLoop/toolRegistry/approvalGate/taskSession/subAgentManager/renderKernel/modelClient）、能力目录、工作区交互、审批卡、可视化组件。
- 端口约定保持：前端 `:15173`，`/api` 代理 `:15001`（vite.config.ts）。
- `package.json` name 改为 `iris-frontend`，version `0.1.0`。

## 3. 改了什么（品牌与产品形态）

- **品牌标识改为 Iris**（参照 [docs/10](10-naming-and-identity.md)）：涉及 `config/product.ts`、`utils/identityPrompt.ts`、Sidebar 等。`product.ts` 保留 `BUILD_TARGET/isOnline/isMescli/IS_STANDALONE` 常量导出以维持旧代码编译，但产品形态收敛为单一本地个人版。
- **Sidebar 隐藏 MES 特有入口与官网云服务入口**（保留骨架、隐藏 UI，见 §4）。

## 4. 裁了什么（WonWork 包袱与企业特有，均不进入 Iris 主路径）

| 包袱/特有项 | 处理 | 理由 |
|---|---|---|
| IndexedDB/SQLite 双轨 + id 水位线路由 | **去掉**，前端不维护 IndexedDB 历史副本 | Iris 直接后端 SQLite 权威，不留双轨包袱 |
| standalone/mescli 双实现开关（IS_STANDALONE 二选一 API 模块） | 保留骨架、收敛为单形态 | Iris 只有一种形态，但删除二选一结构改动面大，先标注 |
| MES 特有（X-MES-* 头、域登录、SQL Server 路由、TokenHub 凭证链、mescli-packages、providerprobe） | **保留骨架标注禁用**，UI 入口隐藏 | 避免大改引入新 bug；纯 MES 业务页面可后续删 |
| 官网云服务（/api/cloud/*、套餐计费） | 保留骨架、隐藏 UI 入口 | 同上 |
| ChatService 后端回退路径 | **不抄** | WonWork 自己都只在回落用，Iris 不需要 |

## 5. API 层对接与契约缺口（TODO(backend-gap)）

前端 API 调用层（`api/client.ts` 等）按 WonWork 的 `/api/*` 形状写定；Iris 后端缺口处在代码里打了 `TODO(backend-gap)` 标记。关键缺口与裁决状态：

| 前端调用（WonWork 形状） | Iris 后端现状 | 状态 |
|---|---|---|
| `/api/workspace/*` | 已由后端 `objective/workspace/WorkspaceApiController` 补齐 | ✅ 已对齐 |
| `/api/history/*` | 已由 `objective/history/HistoryApiController` 补齐（SQLite 权威） | ✅ 已对齐（形状细节见下） |
| `/api/capabilities*` | 已由 `objective/capabilities/CapabilitiesApiController` 补齐，带 `frontend_loop_online` | ✅ 已对齐 |
| `/api/chat/proxy` | 已由 `objective/chat/ChatProxyController` 补齐（透明 SSE 代理） | ✅ 已对齐 |
| `/api/auth/user`、`/api/version`、`/api/config/providers`、`/api/cron/*` | 已由 `objective/system/*` 补齐 | ✅ 已对齐 |
| `/api/history/{id}/task-state`、`/project`、分层加载 `tailTurns`、消息 turns 补拉、消息 tool 折叠写回 | WonWork 2026-08/09 二阶段新增，Iris 后端未实现 | ⏳ 待后端补或前端降级 |
| `/api/auth/login`、`/api/auth/logout` | 本地个人版是否保留账号体系待裁决 | ⏳ 待裁决 |
| `/api/cron/* ↔ /api/v1/schedules`、`/api/usermemory/* ↔ /api/v1/memories`、`/api/skills/* ↔ /api/v1/skills`、`/api/mcp/* ↔ /api/v1/mcp/servers` | WonWork 形状 ↔ Iris v1 形状不一致 | ⏳ 待后端适配层或前端改造 |

**形状细节说明**：WonWork 的 `conversationId` 是 number、分页 page/pageSize；Iris 目标契约是 docs/44 的 HistoryGateway（Conversation/Branch/Turn/RoundCommit 事实批次）。当前 `HistoryApiController` 把数值型路径段当作不透明 id 适配，前端只当不透明 id 使用——这是过渡适配，最终形状以 docs/44 HistoryGateway 为准。

## 6. 验证

- `npm install && npm run build`（tsc + vite build）**通过**（过程中修复 181→12→0 个 TypeScript 错误）。
- 后端端点抽查（2026-09-10）：`/api/version`、`/api/auth/user`、`/api/workspace/info`、`/api/capabilities`（含 `frontend_loop_online`）、`/api/history`（参数校验规范化）全部可达。

## 7. 待裁决清单（留用户定）

1. `/api/auth/login`/`logout` 是否保留（本地个人版要不要账号体系，供远程部署形态）。
2. WonWork 二阶段新增的 history 高级端点（task-state/project/分层加载/折叠写回）——后端补还是前端降级。
3. cron/usermemory/skills/mcp 的 WonWork 形状 ↔ Iris v1 形状，做后端适配层还是改前端。
4. MES 特有骨架模块的最终去留（彻底删除 vs 长期禁用保留）。

## 8. 待办

- 端到端联调（前端 Loop → 工具调用 → 后端执行 → SSE → SQLite 落库）——见阶段三。
- 干净安装复验（clean install）在中断前未跑完，建议联调时一并确认。

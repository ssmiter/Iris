# 02 · 总体架构

## 1. 鸟瞰

```
┌─────────────────────────────────────────────────────────┐
│  frontend（React 瀑布流对话）                            │
│  ├─ Agent Loop（前端默认）/ 后端 Loop（可选回退）          │
│  ├─ 渲染层：renderNodes → 瀑布流组件                     │
│  └─ 状态：zustand stores（对话/分支/压缩/审批/视图持久化） │
└──────────────┬──────────────────────────────────────────┘
               │ REST + SSE（契约见 docs/08）
┌──────────────▼──────────────────────────────────────────┐
│  backend（Spring Boot 3）                                │
│  ├─ 模型代理层：/api/chat/proxy（SSE 转发 + 鉴权 + 重试） │
│  ├─ 工具平台：契约/注册表/域目录/发现/审批/执行（docs/03） │
│  ├─ 工作区：文件围栏 + 检查点（docs/04）                  │
│  ├─ 沙箱：Python 执行服务（docs/04）                     │
│  ├─ 历史：会话/消息/视图状态持久化（SQLite）              │
│  └─ 配置：provider/运行时开关                            │
└──────────────┬──────────────────────────────────────────┘
               │ 本地 HTTP（127.0.0.1，仅本机）
┌──────────────▼──────────────────────────────────────────┐
│  webbridge-daemon（浏览器自动化守护进程，docs/05）         │
│  └─ CDP/Playwright 驱动真实 Chrome                       │
└─────────────────────────────────────────────────────────┘
```

## 2. 关键架构决策

### D1：Agent Loop 放前端，后端是平台

对话循环（思考→调工具→再思考）默认在**前端**运行，后端只提供：模型代理（解决 CORS 与密钥不出服务端）、工具执行、工作区、历史。

理由：
- 循环状态（轮次、补充注入、审批挂起）与 UI 状态天然一体，放前端少一次网络往返语义转换；
- 后端因此可以是无状态平台，Java 实现简单；
- 保留后端 Loop 作为显式回退（弱设备/服务端长任务）。

### D2：SSE 是唯一流式通道

模型流式输出、工具进度、审批请求、压缩进度，全部 SSE 事件。前端不轮询。SSE 断线重连由代理层负责（对前端透明）。

### D3：工具契约统一，前后端同一形状

无论工具在前端本地执行还是后端执行，契约相同：`{ name, description, path, riskLevel, parameters(JSON Schema), execute }`。前端工具的 execute 是本地函数，后端工具走 `/api/tools/invoke`。**统一契约 = 工具可随部署形态自由迁移**。

### D4：本地优先持久化

- 会话/消息：后端 SQLite（也可纯前端 IndexedDB 起步）；
- 视图状态（分支/压缩边界）：IndexedDB 对象存储（大结构、写防抖）；
- 工作区：真实文件系统目录 + `.iris/checkpoints` 检查点。

### D5：运行时身份 ≠ 构建变体

能力开关走运行时配置（`/api/auth/runtime-config` 风格），不增加构建变体。个人版默认全部放开；此机制保留给未来"给朋友用的受限版"。

## 3. 后端模块划分（Spring 包结构）

```
com.iris
├── WeaveApplication.java
├── proxy/           模型代理（SSE 转发、鉴权、重试、熔断）
├── tools/
│   ├── core/        Tool 契约、ToolRegistry、审批闸门、执行器
│   ├── catalog/     域目录、路径推断、能力树、搜索索引
│   └── <domain>/    各生活域工具（finance/ travel/ job/ life/ ...）
├── workspace/       文件围栏、检查点
├── sandbox/         Python 执行（进程池、超时、输出截断）
├── history/         会话与消息持久化
├── config/          Provider 配置、运行时配置
└── common/          SSE 工具、错误模型、审计日志
```

## 4. 前端模块划分

```
frontend/src/
├── agent/
│   ├── agenticLoop.ts        对话循环（轮次/补充/审批挂起）
│   ├── toolExecutor.ts       统一工具执行（本地/后端路由）
│   ├── tools/                前端本地工具（文件/搜索/发现原语）
│   └── renderNodeBuilder.ts  消息 → 渲染节点
├── stores/                   chatStore（对话内核）/ conversationStore / viewState（IndexedDB）
├── components/Chat/          瀑布流组件族（WaterfallTurn/FlowNode/审批栏/composer）
└── api/                      后端契约客户端（docs/08）
```

## 5. 数据流：一次发问的完整旅程

1. 用户在 composer 输入 → chatStore 入列用户消息 → Agent Loop 启动一轮（round）。
2. 组装上下文：系统提示 + 压缩线语义裁剪后的历史 + 发现原语工具（非全量 schema）。
3. 请求后端 `/api/chat/proxy` → SSE 逐 token 回流 → renderNodes 实时更新 → 瀑布流逐字揭示。
4. 模型要求调工具：只读 → 立即执行，结果回注；写操作 → 审批挂起（SSE 推审批事件，前端对话框上方浮出审批条）→ 用户批准/拒绝 → 结果回注。
5. 轮次结束：答案落盘，轮次统计（思考/工具/耗时）生成摘要行；若上下文接近上限，触发压缩（画压缩线，历史不动）。
6. 全程每个事件持久化：消息、renderNodes、分支变体、压缩边界。

## 6. 技术选型理由（Java 侧）

| 选择 | 理由 |
|---|---|
| Java 21 + Spring Boot 3 | 你的主力学习栈，生态与面试主流 |
| WebFlux | SSE 转发是响应式最甜的场景；`Flux<ServerSentEvent>` 直接映射模型流 |
| Spring Data JDBC（非 JPA） | 表结构简单，不想要 ORM 魔法，SQL 可见可控 |
| SQLite（H2 备选） | 个人桌面产品零依赖部署；单文件好备份 |
| Playwright Java（daemon 备选） | 若不想维护 Node 进程，Java 直接驱动浏览器；见 docs/05 §7 权衡 |

# 16 · 前端状态管理骨架

> 状态：大陆 1 / 节点 1.4 已实现，等待统一验证
>
> 依赖：`docs/07-frontend-architecture.md`、`docs/08-api-contract.md`

## 1. 目标

把节点 1.2–1.3 的 Preview 局部状态迁入三个小型 zustand store，同时保持唯一数据方向：

```text
静态 fixture（大陆 1）/ API + SSE（大陆 2）
        ↓
chatStore + conversationStore
        ↓ selectors
components ← viewStateStore
```

三个 store 都不执行 Agent Loop，不读取 DOM 推断业务事实，不相互 import。

## 2. `chatStore`

保存当前 Conversation 的规范化投影工作集：

- `turnsById / turnOrder`；
- `runsById / roundsById / renderNodesById`；
- `connectionState / eventCursor / projectionVersion`；
- 当前本地提交中的 Supplement 乐观项；
- `hydrateProjection` 与按完整安全 View 替换的 upsert action。

Turn 是否活跃从显式 `phase` selector 得出，不保存第二份 `isStreaming`。

本节点不实现 SSE reducer，但 action 形状遵循 `docs/08`：普通实体事件携带完整 View，以 `id + version` 替换；旧 version 忽略。文本 delta 的连续性与帧级合并留给大陆 2。

## 3. `conversationStore`

保存导航工作集：

- `conversationsById / conversationOrder`；
- `currentConversationId / currentBranchId`；
- 当前分支的 `compactBoundaries`；
- 列表与当前视图加载状态。

它不缓存完整历史尾部。切换分支时大陆 2 会重新读取安全 `ConversationView`，而不是在前端深拷贝历史。

## 4. `viewStateStore`

只保存可丢弃视图状态：

- `expandedRoundIds / expandedNodeIds`；
- `followMode / atBottom / unseenTurnCount`；
- `theme / permissionMode`；
- 每个 Conversation 的草稿；
- sidebar 的桌面开合与移动端 overlay；
- 当前预览产物等后续视图入口。

Set 在持久化层使用 `Record<string, true>` 表达，避免不可序列化状态。仅持久化主题、权限偏好、草稿和 sidebar 偏好；折叠与滚动本轮保存在内存，后续需要跨启动恢复时再引入带版本 IndexedDB。

## 5. 乐观命令边界

Preview 的发送、停止和补充仍是演示动作：

- 新 Turn 提交不直接捏造 `TurnView`；
- Supplement 可以先加入 `submitting`，收到 202 后进入 `pending`；
- SSE 才能把 Supplement 改为 `injected / promoted`；
- stop 只设置本地 submitting 反馈，不直接把 Turn 改为 stopped；
- 演示模式通过明确的 `setPreviewActive` 切换，不冒充后端事件。

## 6. Selector 原则

- 组件订阅所需最小字段；
- 派生数组使用稳定 order + map；
- 单个 FlowNode 后续可按 `nodeId` 订阅，1.4 先保持 Turn 级组件接口；
- 不在 selector 中解析消息或复制大对象；
- 不允许 store action 触发 Toast，反馈属于调用组件。

## 7. 文件

```text
frontend/src/
├── stores/
│   ├── chatStore.ts
│   ├── conversationStore.ts
│   └── viewStateStore.ts
└── domain/chat/
    └── selectors.ts
```

## 8. 节点 1.5 的接口

`viewStateStore` 提供主题和 shell 视图状态，1.5 只消费这些字段实现桌面/窄屏布局，不再创建第二份 theme local state。

## 9. 实现记录（2026-07-24）

- 早期基于 `ChatMessage[] + isStreaming` 的 store 骨架已经替换；
- `chatStore` 规范化保存 Turn、Run、Round、RenderNode，并以显式 phase 派生活跃 Turn；
- `conversationStore` 保存当前会话、分支、摘要列表与 CompactBoundary；
- `viewStateStore` 保存折叠、滚动、主题、权限、草稿和 sidebar 状态；
- 持久化仅覆盖小粒度偏好，不把完整历史写进 localStorage；
- Preview fixture 通过 hydration action 注入，不被 product store 反向 import；
- `ConversationTimeline` 的展开和 follow mode 已迁入 view state；
- Composer 草稿、权限与 pending Supplement 已迁入相应 store。

本节点尚未单独构建；与 1.5 完成后统一验证。

### 9.1 统一验证更新

- TypeScript 与 Vite 生产构建通过；
- Zustand persist、selector 与 hydration 路径完成静态类型验证；
- Vite 实际服务启动并返回 HTTP 200；
- 未发现实现文件散落原始色值；
- 浏览器内的刷新持久化与交互回归仍待补验。

### 9.1 统一验证更新

- TypeScript 与 Vite 生产构建通过；
- Zustand persist、selector 与 hydration 路径完成静态类型验证；
- Vite 实际服务启动并返回 HTTP 200；
- 未发现实现文件散落原始色值；
- 浏览器内的刷新持久化与交互回归仍待补验。

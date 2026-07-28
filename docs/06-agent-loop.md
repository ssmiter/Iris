# 06 · 对话内核（Agent Loop）

> 对话循环是体验的心脏：轮次怎么切、补充怎么进、上下文怎么压缩、分支怎么长。
> 核心 Loop 只在 Java 后端；前端提交命令并渲染持久化事件投影。总体决策见 docs/02，正式 REST/SSE 契约见 docs/08。

## 1. 轮次模型（Turn → Run → Round / Pipeline Step）

- **Turn**：从一条用户消息开始，到下一用户消息之前的全部内容。
- **Run**：一次可恢复的求解过程；通常一个 Turn 有一个 root Agentic Run，也可以包含 Agentic/Pipeline child Run。
- **Round**：Agentic Run 中一轮“读取 Context → 模型输出 → 观察工具结果”。Pipeline 使用版本化 Step，不伪装成模型 Round。
- 渲染数据：**renderNodes**——thinking / tool / answer / attention / artifact / supplement / run 七类节点组成过程流；Round 与 Pipeline Step 的投影记录来源和统计。

```
Turn
└── Agentic Run
    ├── Round 1: thinking → tool(read) → tool(search)
    ├── child Pipeline Run: 固定检查 → tool(write) [审批]
    ├── Round 2: observation → thinking
    └── answer（最终回答）
```

Pipeline 与 Agentic 共用 Run、Tool Runtime、审批、证据和事件底座。Agentic 可以探索未知过程，经过多次验证和人工发布后沉淀 Pipeline；Pipeline 遇到声明外的未知分支，可以在安全边界创建有界 Agentic child Run。

## 2. 补充注入（Supplement）——不打断的中途指令

用户运行中再输入，不是排队也不是打断：

1. 先以独立 `pending Supplement` 事实持久化，尚不创建 Message，避免上下文提前读到；
2. 在**下一个 loop 边界**（模型即将发起下一次调用前）创建普通 User Message 并注入上下文；
3. 视觉：composer 上方 chip 淡出，在对应 Round 位置出现与最初提问同层的用户消息气泡；
4. 若 turn 在边界前结束：补充自动作为新 turn 发出；
5. **手动停止 = 完全停止**：未注入的补充转为排队 chip（不自动发），无自动续跑——杜绝"停不下来"的死循环。

竞态规则：Supplement 注入只发生在 loop 边界的一个点，注入后清空 pending。Stop 命令则立即持久化并禁止创建新活动：运行中的模型/只读动作可合作取消，已经进入副作用的动作必须 verify 或闭合为 `OutcomeUnknown`。两者不能共用“只在边界生效”的语义。

## 3. 压缩线（Compact Lines）——历史不动，视野滑动

上下文接近上限时压缩，但**历史一个字都不删**：

- 压缩 = 生成 summary Artifact + 画一条线：`{ id, cutoffEventSequence, cutoffMessageId, sourceContextFrameId, summaryArtifactRef, factRefs, pipelineRunId, trigger }`；
- 线前的记录保持原样；线后的新对话，上下文装配 = 摘要 + 线后原文；
- ToolCall/Exposure 已在 canonical history 保存 provenance；Boundary 不复制全部用过的 Capability，也不携带 active schema lease；
- 压缩进度有细轨道进度条，完成"✓ 已压缩"短暂停留后淡出；
- 手动 `/compact` 与超长自动压缩同一语义。

## 4. 分支多叉树（Branch Tree）

任何用户消息可编辑重发，长出分叉：

```
                      ┌─ 变体1（原始提问）─ 后续...
锚点用户消息 ─────────┼─ 变体2（改问法A）─ 后续...
                      └─ 变体3（改问法B）─ 后续...
```

- **BranchAnchor**：`{ anchorId, anchorText, variants[], active }`；变体保存完整尾部事实与稳定引用（含 Run、renderNodes、工具结构——不裁剪，切换无损，但不要求物理深拷贝）；
- 同一锚点最多 5 个变体（快照体积约束）；
- 气泡下 ‹ 2/5 › 切换；切换只改变历史视野，工作区恢复是独立、可预览、受审批的写动作；
- **key 恒为首个变体的锚点消息 id**——从非首变体上再编辑时按变体 anchorMsgId 找回真锚点（否则会长出"永远只有 2 个分支"的伪锚点）。

## 5. 压缩 × 分支的统一：位置语义

两者交汇处是最容易出 bug 的地方，规则只有一条：

> **在哪个位置分叉，就用那个位置该用的上下文。**

- 分叉点（稳定 message/event sequence）在压缩线后 → 该轮压缩摘要有效；
- 分叉点在线前 → 落回更早的线（或第 0 条线 = 无压缩，全原始上下文）；
- 多轮压缩 = 多条线，选"切点早于最早分叉点"的最新一条；
- 判定函数唯一：`selectActiveBoundary(messages, boundaries, branches)`，装配、分隔线渲染、token 估算三处共用。

## 6. 系统提示组装

分层注入（优先级从高到低）：

1. identity（你是谁/行为准则）
2. **有界 Catalog snapshot**：epoch/hash + 少量顶层目录 + 恒定发现原语 + 禁令（docs/03 §6）
3. 工作区说明（路径围栏、产物机制）
4. 当前上下文状态（压缩摘要、激活的项目/技能）
5. 用户记忆（`/remember` 关键词检索注入）

完整 Tool schema 不属于永久系统提示。每个 Model attempt 只激活 Capability Working Set 中有预算、绑定 `contextFrameId + modelStepId + modelAttemptId + capabilityId/version + schemaHash` 的短期 schema lease；Agentic ToolCall 必须链接对应 Exposure。CompactBoundary 只保留 source range、summary/fact refs 和少量未来求解 hints，不会让曾读过的 schema 跨长对话永久驻留。

稳定的工具元认知提示只负责四件事：建立“结果必须来自客观 observation”的事实观，
说明目录/搜索/读取 Definition 的发现循环，说明工作区、结果对象与计算等平台如何组合，
以及根据结构化 `effect + recovery.action` 处理失败和止损。它不罗列全量工具，不写某个
业务域的临时 SOP，也不提前承诺尚未接通的 SQL、沙箱或浏览器环境。Catalog 摘要只含
Definition hash 与顶层目录计数；Definition 未变化时，系统提示前缀保持逐字节稳定。

## 7. 持久化

| 数据 | 位置 | 说明 |
|---|---|---|
| Message / Turn / Run / Round / ToolCall | 后端 SQLite | canonical facts，结构完整 |
| RenderNode / ConversationView | 后端 SQLite | 可迁移重建的持久化投影 |
| 分支 / 压缩边界 / Context Frame | 后端 SQLite | 只改变历史或模型视野，不删除原事实 |
| 检查点 | Managed Object Store + SQLite | 不可变原文对象 + 结构化 metadata |
| 展开 / 滚动 / 草稿 | 前端 View State | 可丢弃、可重建，不是历史真相 |

SQLite 事务先提交事实和事件，再由 SSE 投影。前端刷新从 ConversationView 的 event cursor 续传；IndexedDB/localStorage 不能成为分支、压缩或审批的唯一来源。

## 8. 防死循环红线

- 手动停止不触发任何自动发送；
- 自动压缩失败后退避，不立即重试；
- Runtime 根据稳定 failure code、`recoveryAction` 和 `sideEffectOutcome` 决定 `retry_same / reprepare / rediscover / reconcile / user_input / none`；不能用“同类错误三次”覆盖副作用语义；
- 预算同时限制重复 code、相同资源和无进展 observation，熔断结果作为结构化 Failure 回注；
- 审批超时 = `expired`，不是用户 `rejected`，且不静默重发。

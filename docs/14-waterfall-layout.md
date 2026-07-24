# 14 · 瀑布流布局骨架

> 状态：大陆 1 / 节点 1.2 已实现，等待与节点 1.1 联合验证
>
> 依赖：`docs/07-frontend-architecture.md`、`docs/08-api-contract.md`、`docs/11-design-system.md`
>
> 参考切片：WonWork SVN working copy r188 的 `MessageList`、`WaterfallTurn`、`FlowNode`。只复用 Turn 级虚拟化、摘要锚点和纯手动折叠等设计结论，不复制组件。

## 1. 节点目标

用静态、契约级 `ConversationProjection` 建成瀑布流的第一套真实渲染骨架：

- `ConversationTimeline` 以完整 Turn 为虚拟列表项；
- `WaterfallTurn` 只编排用户请求、Run、Round 与终态；
- `RoundSection` 固定呈现“过程详情 → 摘要锚点 → 阶段/最终答案”；
- `FlowNode` 只依据 `type + rendererKey` 分派安全渲染器；
- 过程展开、节点展开和滚动跟随都只是用户视图状态；
- 静态数据覆盖 Agentic、Pipeline child Run、多 Round、并行工具、失败、待处理 Attention、补充和产物。

本节点不实现 SSE reducer、真实审批命令、Composer、分支切换或持久化 store。

## 2. 数据边界

组件直接消费与 `docs/08` 对齐的规范化读模型：

```text
ConversationProjection
├── turns[]
├── runsById
├── roundsById
└── renderNodesById
```

禁止：

- 从消息顺序推断 Turn；
- 从 `summary` 文本识别工具状态；
- 从相邻节点推断审批、回答或产物；
- 把大结果直接塞进 RenderNode；
- 为演示数据另造一套与 API 不同的数据形状。

`frontend/src/agent/types.ts` 是早期消息骨架，不扩展为第二套渲染协议。1.2 新模型放在 `domain/chat/models.ts`；节点 1.4 重写状态层时再迁移旧 store。

## 3. 组件结构

```text
WaterfallPreview
└── ConversationTimeline
    └── WaterfallTurn
        └── RunSection
            └── RoundSection
                ├── FlowNode[]
                ├── ProcessSummary
                └── AnswerBlock
```

`WaterfallTurn` 不执行工具、不维护后端 phase，也不解析 Markdown 来判断结构。Attention 的演示动作只产生本地回显，明确不伪装成后端批准。

## 4. 虚拟滚动与视线稳定

- 使用现有 `react-virtuoso`，`data` 的一个元素就是一个完整 Turn；
- key 永远使用 `turnId`；
- 动态高度由虚拟列表测量，不手写高度缓存；
- 展开状态保存在 Timeline 上层，Turn 卸载后仍不丢；
- 用户离开底部后停止自动跟随，并显示“回到最新”；
- 流式模拟更新不强迫用户回到底部；
- 过程详情位于摘要按钮上方，展开时摘要仍是视觉锚点；
- 不虚拟化单个 FlowNode，避免把一轮的语义与键盘顺序拆散。

## 5. 折叠规则

过程默认折叠。待处理 Attention、失败状态不依赖过程展开才可发现：

- Round 摘要显示失败或待处理数量；
- Turn 顶部显示待处理提示；
- 展开过程后，相关节点默认展开；
- 用户点击是展开状态的唯一修改来源；
- 节点状态改变、Turn 完成和虚拟列表重挂载都不能擅自改写。

节点详情使用真实 `button`、`aria-expanded` 与 `aria-controls`。动效只使用高度网格、透明度和旋转，并服从 reduced-motion。

## 6. 默认渲染器

| 类型 | 默认表现 |
|---|---|
| thinking | 摘要、可选公开详情引用提示、耗时 |
| tool | 工具展示名、状态、结果/证据摘要引用 |
| attention | 影响陈述与允许动作；演示动作只回调 |
| artifact | 产物标题、类型与预览入口占位 |
| answer | 安全 Markdown，阶段答案与最终答案层级不同 |
| supplement | 轻量边界标记，不生成用户气泡 |
| run | child Run 标签与结构化进度摘要 |

未知 `rendererKey` 仍落到相应类型的安全默认渲染器，不渲染原始 HTML，不动态加载代码。

## 7. 文件边界

```text
frontend/src/
├── domain/chat/
│   ├── models.ts
│   └── mockConversation.ts
├── components/chat/
│   ├── ConversationTimeline.tsx
│   ├── WaterfallTurn.tsx
│   ├── RunSection.tsx
│   ├── RoundSection.tsx
│   ├── ProcessSummary.tsx
│   ├── FlowNode.tsx
│   ├── AnswerBlock.tsx
│   └── index.ts
└── components/dev/
    └── WaterfallPreview.tsx
```

节点 1.3 将 Preview 底部占位替换为 Composer；节点 1.4 将临时视图状态迁入 `viewStateStore` 并接入投影 store。

## 8. 实现记录

节点 1.2 已落地：

- `domain/chat/models.ts` 与 `docs/08` 的 Turn、Run、Round、七类 RenderNode 对齐；
- `ConversationTimeline` 使用 `react-virtuoso` 按完整 Turn 虚拟化；
- 展开状态提升到 Timeline 层，虚拟列表卸载 Turn 后仍保留；
- `WaterfallTurn / RunSection / RoundSection` 只编排规范化投影；
- 过程详情位于摘要锚点上方，阶段答案和最终答案保持可见；
- `FlowNode` 提供安全默认渲染和未知 `rendererKey` 回退；
- 模拟投影覆盖长历史、压缩线、Agentic、Pipeline child Run、并行工具、补充、产物、审批与 `outcome_unknown`；
- Attention 演示按钮只显示本地反馈，不伪装成已批准的后端事实；
- `WaterfallPreview` 已替换 1.1 Preview 成为当前开发入口，1.1 Preview 文件仍保留。

## 9. 延后验证

按用户要求，节点 1.2 实现完成后再与 1.1 一起验证。联合验证至少包括：

- TypeScript 与 Vite 生产构建；
- 亮暗主题；
- 1000 个静态 Turn 的动态高度滚动；
- 展开/收起后位置与状态保持；
- 离开底部、模拟新增 Turn、回到最新；
- 键盘操作与可访问名称；
- 1440×900、1024×768、390×844；
- Markdown、长工具名、长中文内容与未知 renderer fallback；
- reduced-motion。

验证完成前，1.1 与 1.2 均不标记完成，不提交 Git。

### 9.1 首轮联合验证（2026-07-24）

- `npm run build`：通过；
- 设计令牌硬编码扫描与关键对比度检查：通过；
- 本地 HTTP 冒烟：宿主 PowerShell 的 `Path/PATH` 重复环境导致隐藏后台进程无法启动，并非应用构建失败；
- 真实浏览器交互、响应式与长列表性能：浏览器控制连接当前不可用，仍待补验。

因此 1.1 与 1.2 保持“等待完整验证”，不提交 Git；实现工作可以继续进入不依赖后端的 1.3。

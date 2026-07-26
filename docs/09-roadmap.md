# 09 · 路线图

> 当前策略：先把 reference 中已经验证过的基础语义用透，形成可恢复、可观测、可扩展
> 的 Agent 内核。工业互联网与个人助手都是后续产品化方向；当前不按场景数量推进，也
> 不提前建设通用工作流市场。
>
> **截至 2026-07-26**：M0 已跑通；M1 与 M2 的首个纵向切片已进入真实对话体验，
> 但长对话中的分支 × 压缩水位线、复杂工具链与进程恢复仍需持续验证。下列勾选表示
> “已有可运行实现”，不等于该能力已经产品化完成。

## M0 · 骨架可跑
- [x] backend：Spring Boot 工程 + `POST /api/v1/conversations/{id}/turns` + conversation SSE（DeepSeek OpenAI-compatible）
- [x] frontend：Vite React 工程 + 对话页（发消息、流式显示、失败与运行状态）
- [x] SQLite 最小事实与投影（Conversation / Message / Turn / Run / Event / RenderNode）
- [x] 验收：发一句话，流式回答，刷新后历史还在

## M1 · 对话内核
- [x] 轮次模型 + renderNodes + 瀑布流渲染（摘要行/折叠纯手动/逐字揭示）
- [x] 补充注入 + 排队 + Agentic Stop
- [x] 压缩线 + 分支多叉树 + 位置语义的首版实现
- [x] 前端只持久化可丢弃 View State；分支、压缩和运行事实全部在 SQLite
- [ ] 组合验收：一次长对话里完成补充、分支、压缩、回分支继续，全部无损

## M2 · 工具平台
- [x] Tool 契约 + Registry + 目录即路径 + 能力树统计
- [x] 发现三原语 + Capability Working Set / schema lease 的首版实现
- [x] 审批闸门 + 审批条 UI
- [ ] 足够闭环的系统原语；业务领域能力只用于验证抽象，不以数量充当效果指标
- [ ] 只落地 2-3 个 code-defined system Pipeline，通用 DSL、自动轨迹挖掘与公共 authoring 后置
- [ ] 组合验收：模型通过目录找到自己没见过的工具并正确调用；写操作必审批

## M3 · 工作区 + 沙箱
- [x] 工作区路径围栏（越界 fail-close）
- [ ] 文件工具 + Checkpoint；恢复是独立受审批写动作
- [ ] Trusted Runner / Sandbox 边界 + staged input/output + 产物卡片
- 验收："整理这个 Excel 并生成报告 docx"一次跑通，文件卡片可预览

## M4 · Connector / WebBridge
- [ ] 独立 daemon + 页面状态 + 动作原语 + 截图校验
- [ ] 录制结果沉淀为 Backend Pipeline Capability + 人工接管
- [ ] 对话内浏览器舞台
- 验收：真实页面任务中观察、动作、审批、验证、接管和恢复语义全部闭合；不以站点数量替代可靠性

## M5 · 产品方向验证
- [ ] exe 打包（后端自包含 + 前端静态 + 安装器）
- [ ] 个人网站发布页 + 更新通道
- [ ] 分别选择工业互联网与个人场景验证内核，基于证据决定产品重心

## 暂存的业务验证样本（不代表当前排期）
- 出行：12306 查票/余票监控、机票比价、行程单生成
- 求职：网申工作流、投递追踪表、面经检索
- 财务：记账（截图/语音 → 结构化）、订阅到期提醒
- 信息：网页收藏摘要、RSS 日报、稍后读
- 文档：周报生成、PDF 合并拆分、证件照排版

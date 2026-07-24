# 09 · 路线图

## M0 · 骨架可跑（1-2 周）
- [ ] backend：Spring Boot 工程 + `POST /api/v1/conversations/{id}/turns` + conversation SSE（接一家模型）
- [ ] frontend：Vite React 工程 + 最小对话页（发消息、流式显示）
- [ ] SQLite 最小事实与投影（Conversation / Message / Turn / Run / Event / RenderNode）
- 验收：发一句话，流式回答，刷新后历史还在

## M1 · 对话内核（2-3 周）
- [ ] 轮次模型 + renderNodes + 瀑布流渲染（摘要行/折叠纯手动/逐字揭示）
- [ ] 补充注入 + 排队 + 停止红线
- [ ] 压缩线（手动 /compact）+ 分支多叉树 + 位置语义
- [ ] 前端只持久化可丢弃 View State；分支、压缩和运行事实全部在 SQLite
- 验收：一次长对话里完成补充、分支、压缩、回分支继续，全部无损

## M2 · 工具平台（2-3 周）
- [ ] Tool 契约 + Registry + 目录即路径 + 能力树统计
- [ ] 发现三原语 + Capability Working Set / schema lease + 系统提示元认知注入
- [ ] 审批闸门 + 审批条 UI（两阶段退场）
- [ ] 足够闭环的系统原语 + 1-2 个做深的生活领域能力板块；不以工具数量充当效果指标
- [ ] 只落地 2-3 个 code-defined system Pipeline，通用 DSL、自动轨迹挖掘与公共 authoring 后置
- 验收：模型通过目录找到自己没见过的工具并正确调用；写操作必审批

## M3 · 工作区 + 沙箱（2 周）
- [ ] 路径围栏 + 文件工具 + Checkpoint；恢复是独立受审批写动作
- [ ] Trusted Runner / Sandbox 边界 + staged input/output + 产物卡片
- 验收："整理这个 Excel 并生成报告 docx"一次跑通，文件卡片可预览

## M4 · WebBridge（3-4 周）
- [ ] 独立 daemon + 页面状态 + 动作原语 + 截图校验
- [ ] 录制结果沉淀为 Backend Pipeline Capability + 人工接管
- [ ] 对话内浏览器舞台
- 验收（北极星）：10 个真实网申站点，半自动填完，断点可接管

## M5 · 产品化（持续）
- [ ] exe 打包（后端自包含 + 前端静态 + 安装器）
- [ ] 个人网站发布页 + 更新通道
- [ ] 工具生态持续沉淀（生活每遇到一件重复琐事 → 一个工具/工作流）

## 工具 backlog（生活向，随手记）
- 出行：12306 查票/余票监控、机票比价、行程单生成
- 求职：网申工作流、投递追踪表、面经检索
- 财务：记账（截图/语音 → 结构化）、订阅到期提醒
- 信息：网页收藏摘要、RSS 日报、稍后读
- 文档：周报生成、PDF 合并拆分、证件照排版

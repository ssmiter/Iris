# WonWork Reference

参考项目之一：瀑布流对话前端 + 浏览器自动化 daemon。

## 定位

这里前端已经能形成大致闭环——对话渲染、工具卡片、审批交互、Agentic Loop、daemon 通信都是完整可跑的。但它的短板也很清晰：

- **没有工作区/沙箱**：文件操作没有围栏，没有检查点与回滚
- **没有能力目录**：工具是前端硬编码注册，不走发现原语，无法生长
- **前端 Loop 太重**：agenticLoop 两千多行跑在浏览器里，模型协议装配、上下文压缩、工具调度全部压在前端——这既不可靠也不持久

## 对我们的价值

1. **视觉与交互设计**：瀑布流渲染（WaterfallTurn、FlowGroup、过程折叠/答案揭示）、审批卡片、Artifact 展示——这是最重要的参考资产
2. **WebBridge daemon**：浏览器自动化守护进程的进程模型、CDP 通信、动作录制
3. **反面教材**：前端 Loop 的复杂度证明了我们把 Agentic 内核放到 Java 后端是对的——前端只投影状态，不承担逻辑

## 结构

```
src/
  agent/          # Agentic 循环、工具注册、模型客户端（重，待迁移后端）
  api/            # HTTP API 客户端
  components/     # React 组件（Chat, WebBridge, DagWorkflow, Settings 等）
  stores/         # Zustand 状态管理
  utils/          # 工具函数
daemon/           # WebBridge 浏览器自动化守护进程
```

## 迁移方向

- 视觉组件：参考其渲染模式，按 Iris 设计令牌重写
- Agentic 逻辑：不搬代码，将其语义抽象后由后端原生实现（Turn/Run/Round 状态机）
- daemon：参考进程架构，按 docs/05 重新设计

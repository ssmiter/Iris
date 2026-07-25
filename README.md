# Iris

> 一个属于你自己的 AI 个人助手：瀑布流对话前端 + 原生 Agentic Java 后端 + 可组合的能力网络 + 真浏览器自动化 + 本地工作区。
> 目标：像 Claude Code 一样可靠好用，但面向**日常生活**而不是编码——订票、出行规划、秋招网申、记账、信息整理。
>
> 中文命名故事：Iris 是希腊神话中的彩虹女神、众神与人间的信使（"虹使"）。详见 [docs/10](docs/10-naming-and-identity.md)。

## 为什么存在

桌面助手早已不是"没有手和脚"的时代了——官方产品们已经能操作浏览器、读写文件、连接各种服务。但真正的缺口从来不在"能不能做"，而在：

1. **它们是通用的，而你的生活不是。** 官方助手面向所有人的平均水平设计；而真实生活充满了非规则化的需求——"帮我把这 300 家风马牛不相及的网申按我的优先级填掉"、"按我家的规矩记账"、"用我习惯的方式整理这一堆杂乱文件"。这些需求没有现成按钮，只能从你的生活中抽象出来。
2. **它们的能力是封闭的，而你的问题需要组合。** 官方工具箱给什么用什么；但真正解决生活问题，往往需要把客观原语（读文件、观察页面、计算、写入、验证）按你的情境自由组合成新的能力——组合权必须在你和 Agent 手里，而不是在产品经理的路线图里。

Iris 的回答：**自己造一个扎根本地的助手**。它只读你的文件、只操作你的工作区、只记住你的偏好；它的能力不是一堆按钮，而是一棵可以由你持续生长的能力树——客观的系统原语在底层，围绕求职、出行、财务等真实问题抽象出的生活能力在上层。

## 核心思路：Agentic 探索，Pipeline 沉淀

Iris 的内核设计来自一个关键辩证（详见 [docs/02 §5](docs/02-architecture-overview.md)）：

- **Agentic Run**：面对路径未知的任务，观察环境、发现原语、试错修正、直到求解。成本高，但什么都能试。
- **Pipeline Run**：重放已经被理解的成功过程——固定输入输出、步骤、检查点和证据。便宜稳定，但遇到新情境会失配。

两者不是二选一，而是同一运行内核上可以互相转化的两种形态：Agentic 探索出的成功轨迹，验证后沉淀为 Pipeline；Pipeline 遇到前置条件失效，受控回退给 Agentic 修复。所以 Iris 前期重 Agentic 内核（发现、组合、上下文、恢复做可靠），后期重心转向具体生活能力的抽象——而不是无限扩建通用 Loop。

## 设计信条

1. **历史不可丢**——对话是一棵倒着的树：分支变体、压缩边界、工具调用结构全部持久化；任何优化只能改变"当前视野"，不能丢弃信息。
2. **发现优于塞满**——面对成百上千个工具，schema 不预装进上下文；模型走发现原语（目录统计 → 进入分支 → 按需读 schema → 澄清 → 调用），不凭名字猜参数。
3. **写操作必审批**——任何改变外部状态的动作默认挂起，用一句人话说清影响，等你点头；批准绑定的是不可变的操作快照，不是会漂移的工具名。
4. **路径围栏**——文件工具只允许操作工作区根目录内，越界一律拒绝（fail-close）。
5. **视觉克制**——动画只为锚定注意力：过程折叠为摘要行，答案逐字揭示，审批条淡化退场；禁止无意义的频繁移动。
6. **本地优先**——SQLite 与本地文件是一等公民；不需要 24 小时常驻，重启后未闭合的事实可以恢复。

## 四个组成部分

- **瀑布流对话前端**（Vite + React + TS）：轮次 = N ×（过程 + 回答），过程默认折叠、答案逐字揭示；运行中可补充、可停止，历史可分支、可压缩。
- **Agentic 后端**（Java 21 + Spring Boot 3 + WebFlux + SQLite）：Loop 在后端——Turn / Run / Round 持久化状态机、模型协议装配、上下文预算与压缩、唯一 Tool Runtime（claim → prepare → approval → execute → verify），SSE 是唯一流式通道。
- **能力平台**：工具按"域 → 目录 → 工具"组织，**文件目录即能力树路径**；每个工具声明一句话描述、风险等级和参数 schema，经能力目录被模型发现，而不是被记住。
- **WebBridge 浏览器自动化**（规划中）：借出一个真实 Chrome 窗口（带你的登录态），模型看页面、做动作，你随时接管；录制一次示范，沉淀为可重放的工作流。

## 项目现状

- [x] 设计文档体系（docs/01–23，含对 Claude Code 内核与企业级后端的研究基线）
- [x] 前端视觉与交互骨架：设计令牌、瀑布流渲染、Composer、状态管理（mock 数据驱动）
- [x] 后端持久化 Agentic 内核：Turn 命令 + SSE、Run/Round 状态机、模型流装配、Tool Runtime + 审批、能力目录、工作区围栏
- [ ] 前后端对接与完整闭环（进行中）
- [ ] 分支 / 压缩 / 补充注入、生活能力板块、WebBridge、exe 产品化

## 文档地图

| 文档 | 内容 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | AI 协作开发指南（仓库约定、不变量、常用命令） |
| [docs/01](docs/01-vision-and-principles.md) | 产品哲学与面向业务的设计思考 |
| [docs/02](docs/02-architecture-overview.md) | 总体架构：模块边界、Pipeline 与 Agentic 辩证、技术选型 |
| [docs/03](docs/03-tool-platform.md) | 工具平台：契约 / 目录 / 发现 / 审批 / 隔离 |
| [docs/04](docs/04-workspace-and-sandbox.md) | 工作区、路径围栏、检查点、Python 执行边界 |
| [docs/05](docs/05-webbridge.md) | 浏览器自动化：原语 / 页面状态 / 录制 / 接管 |
| [docs/06](docs/06-agent-loop.md) | 对话内核：轮次循环、补充注入、压缩线、分支多叉树 |
| [docs/07](docs/07-frontend-architecture.md) | 前端架构与瀑布流渲染原理 |
| [docs/08](docs/08-api-contract.md) | 前后端 REST/SSE 契约 |
| [docs/09](docs/09-roadmap.md) | 里程碑与生活工具 backlog |
| [docs/10](docs/10-naming-and-identity.md) · [11](docs/11-design-system.md) | 命名与视觉身份、设计系统 |
| [docs/12](docs/12-agent-kernel-study.md) · [13](docs/13-backend-study.md) | 研究基线：Claude Code 内核、企业级 agent 后端 |
| [docs/14–17](docs/14-waterfall-layout.md) | 前端系列：瀑布流布局、输入系统、状态管理、主题响应式 |
| [docs/18–23](docs/18-turn-command-and-sse.md) | 后端系列：Turn 与 SSE、历史持久化、Tool Runtime、Run/Round 与模型协议、上下文与压缩、运行时投影 |

## 技术栈

- **后端**：Java 21 + Spring Boot 3（WebFlux）+ Spring Data JDBC + SQLite
- **前端**：Vite + React 18 + TypeScript + Tailwind CSS + zustand + react-virtuoso
- **浏览器自动化**：Node.js 守护进程（CDP / Playwright，见 [docs/05](docs/05-webbridge.md) 权衡）
- **打包**（后期）：后端自包含 jar + 内嵌前端 + Inno Setup exe

## 本地运行

```bash
# 后端 :5001（模型经 IRIS_MODEL_* 环境变量注入，密钥不入库）
cd backend && ./mvnw spring-boot:run

# 前端 :5173（/api 代理到 :5001）
cd frontend && npm install && npm run dev
```

## 免责声明

本项目为个人学习与个人产品项目。所有文档均为设计级原创描述，不包含任何第三方公司的代码、密钥、客户信息或专有数据。Claude Code、WonWork、ragent-lab、MESCLI 等是研究灵感的来源，不是代码或业务的模板——实现全部为全新编写。

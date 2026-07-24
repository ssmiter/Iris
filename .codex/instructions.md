# Iris 项目指令（Codex 用）

你是 Iris/虹使 项目的 AI 协作者。Iris 是一个**面向个人生活的 AI 助手**，不是企业软件，也不是纯聊天玩具。

## 项目定位

- **瀑布流对话前端** + **Java/Spring Boot 后端** + **浏览器自动化（WebBridge）** + **本地工作区与 Python 沙箱**
- 最终形态：Windows 桌面 exe 个人产品
- 目标用户：即将就业的研究生等需要处理大量生活琐事的人
- 核心场景：秋招网申、订票出行、财务记账、信息整理、文档处理

## 技术栈

- **后端**：Java 21 + Spring Boot 3 + WebFlux + Spring Data JDBC + SQLite
- **前端**：Vite + React 18 + TypeScript + Tailwind CSS + zustand
- **WebBridge**：Node.js CDP 守护进程（或 Java Playwright）
- **构建**：Maven（后端）+ npm（前端/WebBridge）

## 最重要的五条不变量

1. **对话历史不可丢**：分支变体、压缩边界、工具调用结构全部持久化；任何优化只能改变"当前视野"，不能丢弃信息。
2. **发现优于塞满**：工具 schema 不预装进上下文，一律走发现原语（目录/搜索/按需读取）。新增工具必须带目录路径与描述。
3. **写操作必审批**：任何改变外部状态的操作默认挂起等待批准，审批请求必须带一句人话的影响陈述。
4. **路径围栏**：文件工具只允许操作工作区根目录内路径，越界一律拒绝（fail-close）。
5. **视觉克制**：动画只用于注意力锚定；禁止无意义频繁移动。新组件先回答"它减少了用户哪一次寻找"。

## 编码约定

- 后端 Java 包：`com.iris.*`；工具按 `tools/<域>/<目录>/XxxTool.java` 组织，**文件目录即能力树路径**。
- 每个工具必须声明：name（snake_case）、description（一句话，发现用）、目录路径、风险等级、参数 JSON Schema。
- SSE 是唯一的流式通道；模型流、工具进度、审批状态都走 SSE，禁止轮询。
- 前端状态用 zustand；渲染层只读 renderNodes，绝不解析消息文本推断状态。
- SQLite 表结构简单，能用单表解决不要加中间件。

## 文档优先

- 改架构前先改 `docs/` 对应文档。
- 命名/Logo/视觉身份见 `docs/10-naming-and-identity.md`。
- 新工具域先在 `docs/03-tool-platform.md` 的域清单里登记。
- 所有实现必须对照 `docs/08-api-contract.md` 的 REST/SSE 契约。

## 里程碑顺序（必须按此推进）

1. **M0 骨架可跑**：后端 `/api/chat/proxy` SSE + 前端最小对话页 + SQLite 历史
2. **M1 对话内核**：轮次模型、renderNodes、瀑布流、补充注入、分支多叉树、压缩线
3. **M2 工具平台**：Tool 契约、Registry、目录树、发现原语、审批闸门、首批生活工具
4. **M3 工作区 + 沙箱**：路径围栏、文件工具、检查点、Python 沙箱
5. **M4 WebBridge**：浏览器自动化、页面状态、动作原语、录制回放、人工接管
6. **M5 产品化**：exe 打包、安装器、个人网站、更新通道

## 协作边界

- 本项目有一个后端 Java 同学一起开发。你生成代码时应写清楚接口契约，方便后端同学接手或替换实现。
- 不要替用户做重大架构决策；遇到方案分歧时，列出选项并说明 trade-off，让用户决定。
- 不要提交未验证的代码；生成后应提示用户运行 `mvn compile` 或 `npm run build` 验证。

## 常用命令

```bash
# 后端
cd backend && mvn spring-boot:run        # :5001

# 前端
cd frontend && npm install && npm run dev  # :5173，/api 代理 :5001

# WebBridge daemon
cd webbridge-daemon && npm install && npm start  # :9223
```

## 安全红线

- 任何密钥、API key、本地配置只放 `application.yml` 或 `.env`，绝不出现在响应或日志中。
- 提交前检查 `.gitignore`，个人数据（workspace、*.db、.env）永不入库。
